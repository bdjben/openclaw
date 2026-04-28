import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAgentId, resolveStateDir } from "./config-utils.js";
import type { SsrFPolicy } from "./ssrf-policy.js";
import { normalizeLowercaseStringOrEmpty } from "./string-utils.js";

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const HEARTBEAT_PROMPT =
  "Run the following periodic tasks (only those due based on their intervals):";
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";

export type MemoryHostLogger = {
  debug(message: string): void;
};

export type MemoryHostGuardedFetch = (params: {
  url: string;
  fetchImpl?: typeof fetch;
  init?: RequestInit;
  policy?: SsrFPolicy;
  auditContext?: string;
  mode?: string;
}) => Promise<{ response: Response; release(): Promise<void> }>;

export type MemoryHostServices = {
  auth: {
    requireApiKey(apiKey: string | undefined, provider: string): string;
    resolveApiKeyForProvider(params: {
      provider: string;
      cfg: unknown;
      agentDir?: string;
    }): Promise<string | undefined>;
  };
  io: {
    createSubsystemLogger(name: string): MemoryHostLogger;
    detectMime(opts: {
      buffer?: Buffer;
      headerMime?: string | null;
      filePath?: string;
    }): Promise<string | undefined>;
    estimateStringChars(text: string): number;
    redactSensitiveText(text: string, options?: unknown): string;
    runTasksWithConcurrency<T>(params: {
      tasks: Array<() => Promise<T>>;
      limit: number;
      errorMode?: "continue" | "stop";
      onTaskError?: (error: unknown, index: number) => void;
    }): Promise<{ results: T[]; firstError: unknown; hasError: boolean }>;
  };
  memory: {
    resolveCanonicalRootMemoryFile(workspaceDir: string): Promise<string | null>;
    shouldSkipRootMemoryAuxiliaryPath(params: { workspaceDir: string; absPath: string }): boolean;
  };
  network: {
    buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined;
    fetchWithSsrFGuard: MemoryHostGuardedFetch;
    shouldUseEnvHttpProxyForUrl(url: string): boolean;
  };
  session: {
    hasInterSessionUserProvenance(
      message: { role?: unknown; provenance?: unknown } | undefined,
    ): boolean;
    isCompactionCheckpointTranscriptFileName(fileName: string): boolean;
    isCronRunSessionKey(sessionKey: string | undefined | null): boolean;
    isExecCompletionEvent(event: string): boolean;
    isHeartbeatUserMessage(
      message: { role: string; content?: unknown },
      heartbeatPrompt?: string,
    ): boolean;
    isSessionArchiveArtifactName(fileName: string): boolean;
    isSilentReplyPayloadText(text: string | undefined): boolean;
    isUsageCountedSessionTranscriptFileName(fileName: string): boolean;
    parseUsageCountedSessionIdFromFileName(fileName: string): string | null;
    resolveSessionTranscriptsDirForAgent(agentId: string): string;
    stripInboundMetadata(text: string): string;
    stripInternalRuntimeContext(text: string): string;
  };
};

let activeServices: MemoryHostServices | undefined;

export function setMemoryHostServices(services: MemoryHostServices): void {
  activeServices = services;
}

export function getMemoryHostServices(): MemoryHostServices {
  activeServices ??= createDefaultMemoryHostServices();
  return activeServices;
}

export function createDefaultMemoryHostServices(): MemoryHostServices {
  return {
    auth: {
      requireApiKey(apiKey, provider) {
        const trimmed = apiKey?.trim();
        if (!trimmed) {
          throw new Error(`${provider} API key required`);
        }
        return trimmed;
      },
      async resolveApiKeyForProvider() {
        return undefined;
      },
    },
    io: {
      createSubsystemLogger: () => ({ debug: () => {} }),
      detectMime: async ({ filePath }) => mimeTypeFromFilePath(filePath),
      estimateStringChars,
      redactSensitiveText: (text) => text,
      runTasksWithConcurrency,
    },
    memory: {
      resolveCanonicalRootMemoryFile,
      shouldSkipRootMemoryAuxiliaryPath,
    },
    network: {
      buildRemoteBaseUrlPolicy,
      async fetchWithSsrFGuard(params) {
        const response = await (params.fetchImpl ?? fetch)(params.url, params.init);
        return { response, release: async () => {} };
      },
      shouldUseEnvHttpProxyForUrl: () => false,
    },
    session: {
      hasInterSessionUserProvenance,
      isCompactionCheckpointTranscriptFileName,
      isCronRunSessionKey,
      isExecCompletionEvent,
      isHeartbeatUserMessage,
      isSessionArchiveArtifactName,
      isSilentReplyPayloadText,
      isUsageCountedSessionTranscriptFileName,
      parseUsageCountedSessionIdFromFileName,
      resolveSessionTranscriptsDirForAgent,
      stripInboundMetadata,
      stripInternalRuntimeContext,
    },
  };
}

const ROOT_MEMORY_REPAIR_RELATIVE_DIR = ".openclaw-repair/root-memory";
const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

async function resolveCanonicalRootMemoryFile(workspaceDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    const entry = entries.find(
      (candidate) =>
        candidate.name === "MEMORY.md" && candidate.isFile() && !candidate.isSymbolicLink(),
    );
    return entry ? path.join(workspaceDir, entry.name) : null;
  } catch {
    return null;
  }
}

function shouldSkipRootMemoryAuxiliaryPath(params: {
  workspaceDir: string;
  absPath: string;
}): boolean {
  const relative = path.relative(params.workspaceDir, params.absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const normalized = relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === LEGACY_ROOT_MEMORY_FILENAME ||
    normalized === ROOT_MEMORY_REPAIR_RELATIVE_DIR ||
    normalized.startsWith(`${ROOT_MEMORY_REPAIR_RELATIVE_DIR}/`)
  );
}

function hasArchiveSuffix(fileName: string, reason: "bak" | "reset" | "deleted"): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  return index >= 0 && ARCHIVE_TIMESTAMP_RE.test(fileName.slice(index + marker.length));
}

function isSessionArchiveArtifactName(fileName: string): boolean {
  if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
    return true;
  }
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return COMPACTION_CHECKPOINT_TRANSCRIPT_RE.test(fileName);
}

function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  return (
    fileName !== "sessions.json" &&
    fileName.endsWith(".jsonl") &&
    !fileName.endsWith(".trajectory.jsonl") &&
    !isCompactionCheckpointTranscriptFileName(fileName) &&
    !isSessionArchiveArtifactName(fileName)
  );
}

function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  return (
    isPrimarySessionTranscriptFileName(fileName) ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "deleted")
  );
}

function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0 && hasArchiveSuffix(fileName, reason)) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

function resolveSessionTranscriptsDirForAgent(agentId: string): string {
  return path.join(resolveStateDir(), "agents", normalizeAgentId(agentId), "sessions");
}

function parseAgentSessionKey(sessionKey: string | undefined | null): { rest: string } | null {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey ?? "");
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) {
    return null;
  }
  const rest = parts.slice(2).join(":");
  return rest ? { rest } : null;
}

function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  return parsed ? /^cron:[^:]+:run:[^:]+$/.test(parsed.rest) : false;
}

function isExecCompletionEvent(event: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(event).trimStart();
  return (
    /^exec finished(?::|\s*\()/.test(normalized) ||
    /^exec (completed|failed) \([a-z0-9_-]{1,64}, (code -?\d+|signal [^)]+)\)( :: .*)?$/.test(
      normalized,
    )
  );
}

function isSilentReplyPayloadText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (new RegExp(`^${escapeRegExp(SILENT_REPLY_TOKEN)}$`, "i").test(trimmed)) {
    return true;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || !trimmed.includes(SILENT_REPLY_TOKEN)) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as { action?: unknown };
    return (
      Object.keys(parsed).length === 1 &&
      typeof parsed.action === "string" &&
      parsed.action.trim() === SILENT_REPLY_TOKEN
    );
  } catch {
    return false;
  }
}

function resolveMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function isHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const trimmed = resolveMessageText(message.content).trim();
  return Boolean(
    trimmed &&
    ((heartbeatPrompt?.trim() && trimmed.startsWith(heartbeatPrompt.trim())) ||
      (trimmed.startsWith(HEARTBEAT_PROMPT) && trimmed.includes("HEARTBEAT_OK"))),
  );
}

function hasInterSessionUserProvenance(
  message: { role?: unknown; provenance?: unknown } | undefined,
): boolean {
  return (
    message?.role === "user" &&
    Boolean(message.provenance) &&
    typeof message.provenance === "object" &&
    (message.provenance as { kind?: unknown }).kind === "inter_session"
  );
}

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

function stripInboundMetadata(text: string): string {
  if (!text) {
    return text;
  }
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!INBOUND_META_SENTINELS.some((sentinel) => withoutTimestamp.includes(sentinel))) {
    return withoutTimestamp;
  }
  const lines = withoutTimestamp.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inJsonFence = false;
  for (const line of lines) {
    if (!inMetaBlock && INBOUND_META_SENTINELS.some((sentinel) => line.trim() === sentinel)) {
      inMetaBlock = true;
      inJsonFence = false;
      continue;
    }
    if (inMetaBlock) {
      if (!inJsonFence && line.trim() === "```json") {
        inJsonFence = true;
        continue;
      }
      if (inJsonFence) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inJsonFence = false;
        }
        continue;
      }
      if (line.trim() === "") {
        continue;
      }
      inMetaBlock = false;
    }
    result.push(line);
  }
  return result.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function stripInternalRuntimeContext(text: string): string {
  return text;
}

function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? { allowedHostnames: [parsed.hostname] }
      : undefined;
  } catch {
    return undefined;
  }
}

function estimateStringChars(text: string): number {
  const nonLatinCount =
    text.match(/[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu)
      ?.length ?? 0;
  return text.length + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

async function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: "continue" | "stop";
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
  const results: T[] = Array.from({ length: params.tasks.length });
  let cursor = 0;
  let firstError: unknown;
  let hasError = false;
  const limit = Math.max(1, Math.min(params.limit, params.tasks.length || 1));
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < params.tasks.length && !(params.errorMode === "stop" && hasError)) {
      const index = cursor++;
      try {
        results[index] = await params.tasks[index]();
      } catch (error) {
        firstError ??= error;
        hasError = true;
        params.onTaskError?.(error, index);
      }
    }
  });
  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}

function mimeTypeFromFilePath(filePath?: string): string | undefined {
  const ext = filePath ? path.extname(filePath).toLowerCase() : "";
  const byExt: Record<string, string> = {
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return byExt[ext];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
