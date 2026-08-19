// Verifies strict runtime config reads can opt out of config-health observation.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getRuntimeConfig, loadConfig } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("runtime config observation", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("skips observation on request while preserving materialization and the default", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, "state-root");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const loaded = loadConfig({ observe: false, pin: false });
          const runtime = getRuntimeConfig({ observe: false, pin: false });

          expect(loaded.agents?.defaults?.compaction?.mode).toBe("safeguard");
          expect(runtime.agents?.defaults?.compaction?.mode).toBe("safeguard");
          await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

          expect(loadConfig({ pin: false }).gateway?.mode).toBe("local");
          await expect(fs.stat(databasePath)).resolves.toBeDefined();
        },
      );
    });
  });

  it("keeps strict validation enabled when observation is disabled", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, "state-root");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const configPath = await writeOpenClawConfig(home, { gateway: { port: "invalid" } });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
          async () => {
            expect(() => loadConfig({ observe: false, pin: false })).toThrow(
              expect.objectContaining({ code: "INVALID_CONFIG" }),
            );
            await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
          },
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
