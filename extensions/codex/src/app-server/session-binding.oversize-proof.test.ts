import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("Codex oversized frozen-instruction proof", () => {
  it("persists a valid 73 KiB frozen instruction snapshot", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-oversize-before-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>(
        "codex",
        {
          namespace: "app-server-thread-bindings-oversize-before",
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env,
        },
      );
      const store = createCodexAppServerBindingStore(state);
      const instructions = "x".repeat(73 * 1024);

      expect(Buffer.byteLength(instructions)).toBe(74_752);
      await expect(
        store.mutate(
          { kind: "conversation", bindingId: "issue-128362-before" },
          {
            kind: "set",
            binding: {
              threadId: "thread-issue-128362-before",
              cwd: "/repo",
              agentWorkspaceDeveloperInstructions: instructions,
            },
          },
        ),
      ).resolves.toBe(true);
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
