/** Process-stable plugin-state metadata for Codex app-server bindings. */
export const CODEX_APP_SERVER_BINDING_NAMESPACE = "app-server-thread-bindings";
export const CODEX_APP_SERVER_BINDING_MAX_ENTRIES = 50_000;
export const CODEX_APP_SERVER_INSTRUCTIONS_BLOB_NAMESPACE = "app-server-instructions";
// Workspace bootstrap files are accepted up to 2 MiB. Leave bounded room for
// the rendered path/header wrapper around one maximum-size AGENTS.md snapshot.
export const CODEX_APP_SERVER_INSTRUCTIONS_BLOB_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;
export const CODEX_APP_SERVER_INSTRUCTIONS_BLOB_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
