// Matrix test support owns plugin-local fixture cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RegisterTempDirCleanup = (cleanup: () => void) => unknown;

export function useAutoCleanupTempDirTracker(registerCleanup: RegisterTempDirCleanup) {
  const dirs = new Set<string>();
  registerCleanup(() => {
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    dirs.clear();
  });
  return {
    make(prefix: string): string {
      // openclaw-temp-dir: allow extension-local test support cannot import the core-only tracker.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.add(dir);
      return dir;
    },
  };
}
