import { createHash } from "node:crypto";
import type { PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";

type CodexInstructionBlobMetadata = { version: 1; refCount: number };
export type CodexInstructionBlobStore = Pick<
  PluginBlobStore<CodexInstructionBlobMetadata>,
  "lookup" | "mutate"
>;
export type CodexInstructionBlobReconciliationStore = CodexInstructionBlobStore &
  Pick<PluginBlobStore<CodexInstructionBlobMetadata>, "entries">;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function readCodexInstructionBlobMetadata(value: unknown): CodexInstructionBlobMetadata {
  const parsed = z
    .object({ version: z.literal(1), refCount: z.number().int().positive() })
    .strict()
    .safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid Codex app-server instruction blob metadata");
  }
  return parsed.data;
}

export function codexInstructionBlobReference(instructions: string): string {
  return `sha256:${createHash("sha256").update(instructions).digest("hex")}`;
}

export function verifyCodexInstructionBlob(reference: string, bytes: Uint8Array): string {
  let instructions: string;
  try {
    instructions = textDecoder.decode(bytes);
  } catch (error) {
    throw new Error(`Codex app-server instruction blob is not valid UTF-8: ${reference}`, {
      cause: error,
    });
  }
  if (codexInstructionBlobReference(instructions) !== reference) {
    throw new Error(`Codex app-server instruction blob digest mismatch: ${reference}`);
  }
  return instructions;
}

/** Atomically creates immutable content or adds one binding owner. */
export async function retainCodexInstructionBlob(params: {
  store: CodexInstructionBlobStore;
  instructions: string;
}): Promise<string> {
  const reference = codexInstructionBlobReference(params.instructions);
  const bytes = textEncoder.encode(params.instructions);
  await params.store.mutate(reference, (current) => {
    if (!current) {
      return { kind: "set", bytes, metadata: { version: 1, refCount: 1 } };
    }
    verifyCodexInstructionBlob(reference, current.bytes);
    const metadata = readCodexInstructionBlobMetadata(current.metadata);
    return {
      kind: "set",
      bytes: current.bytes,
      metadata: { version: 1, refCount: metadata.refCount + 1 },
    };
  });
  return reference;
}

/** Atomically adds one owner to content that was already materialized. */
export async function retainCodexInstructionBlobReference(
  store: CodexInstructionBlobStore,
  reference: string,
): Promise<void> {
  await store.mutate(reference, (current) => {
    if (!current) {
      throw new Error(`Missing Codex app-server instruction blob: ${reference}`);
    }
    verifyCodexInstructionBlob(reference, current.bytes);
    const metadata = readCodexInstructionBlobMetadata(current.metadata);
    return {
      kind: "set",
      bytes: current.bytes,
      metadata: { version: 1, refCount: metadata.refCount + 1 },
    };
  });
}

/** Atomically removes one owner, deleting content only after the final owner. */
export async function releaseCodexInstructionBlob(
  store: CodexInstructionBlobStore,
  reference: string,
): Promise<void> {
  await store.mutate(reference, (current) => {
    if (!current) {
      return undefined;
    }
    verifyCodexInstructionBlob(reference, current.bytes);
    const metadata = readCodexInstructionBlobMetadata(current.metadata);
    return metadata.refCount === 1
      ? { kind: "delete" }
      : {
          kind: "set",
          bytes: current.bytes,
          metadata: { version: 1, refCount: metadata.refCount - 1 },
        };
  });
}

export async function resolveCodexInstructionBlob(
  store: CodexInstructionBlobStore,
  reference: string,
): Promise<string> {
  const entry = await store.lookup(reference);
  if (!entry) {
    throw new Error(`Missing Codex app-server instruction blob: ${reference}`);
  }
  readCodexInstructionBlobMetadata(entry.metadata);
  return verifyCodexInstructionBlob(reference, entry.bytes);
}
