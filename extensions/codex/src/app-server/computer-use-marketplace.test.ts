import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexComputerUseBundledMarketplace } from "./computer-use-marketplace.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("Codex Computer Use bundled marketplace", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("moves the reserved marketplace behind the isolated CODEX_HOME path", async () => {
    const root = tempDirs.make("openclaw-computer-use-marketplace-");
    const codexHome = path.join(root, "codex-home");
    const sourcePath = path.join(root, "ChatGPT.app", "openai-bundled");
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        'notify = ["helper", "turn-ended"]',
        "",
        '[plugins."computer-use@openai-bundled"]',
        "enabled = true",
        "",
        "[marketplaces.openai-bundled]",
        'last_updated = "2026-07-30T23:34:57Z"',
        'source_type = "local"',
        'source = "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled"',
        "",
      ].join("\n"),
    );

    const result = await ensureCodexComputerUseBundledMarketplace({
      codexHome,
      config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
      bundledMarketplacePath: sourcePath,
    });

    const marketplacePath = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
    expect(result).toMatchObject({ status: "ready", changed: true, marketplacePath });
    expect(await fs.realpath(marketplacePath)).toBe(await fs.realpath(sourcePath));
    const config = parseToml(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")) as {
      notify: string[];
      marketplaces: Record<string, { source_type: string; source: string }>;
    };
    expect(config.notify).toEqual(["helper", "turn-ended"]);
    expect(config.marketplaces["openai-bundled"]).toMatchObject({
      source_type: "local",
      source: marketplacePath,
    });
  });

  it("refreshes a stale marketplace symlink and becomes idempotent", async () => {
    const root = tempDirs.make("openclaw-computer-use-marketplace-refresh-");
    const codexHome = path.join(root, "codex-home");
    const oldSourcePath = path.join(root, "old", "openai-bundled");
    const sourcePath = path.join(root, "new", "openai-bundled");
    const marketplacePath = path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled");
    await fs.mkdir(oldSourcePath, { recursive: true });
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.mkdir(path.dirname(marketplacePath), { recursive: true });
    await fs.symlink(oldSourcePath, marketplacePath, "dir");

    const params = {
      codexHome,
      config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
      bundledMarketplacePath: sourcePath,
    };
    expect((await ensureCodexComputerUseBundledMarketplace(params)).changed).toBe(true);
    expect(await fs.realpath(marketplacePath)).toBe(await fs.realpath(sourcePath));
    expect((await ensureCodexComputerUseBundledMarketplace(params)).changed).toBe(false);
  });

  it("leaves an explicitly configured marketplace untouched", async () => {
    const root = tempDirs.make("openclaw-computer-use-marketplace-explicit-");
    const result = await ensureCodexComputerUseBundledMarketplace({
      codexHome: path.join(root, "codex-home"),
      config: resolveCodexComputerUseConfig({
        overrides: { enabled: true, marketplacePath: "/custom/marketplace" },
      }),
      bundledMarketplacePath: path.join(root, "openai-bundled"),
    });
    expect(result).toEqual({ status: "explicit_marketplace", changed: false });
  });
});
