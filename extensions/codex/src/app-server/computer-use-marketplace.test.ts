import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexComputerUseBundledMarketplace } from "./computer-use-marketplace.js";
import { resolveCodexComputerUseConfig } from "./config.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("Codex Computer Use bundled marketplace", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());

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
      ownershipRoot: root,
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
      ownershipRoot: root,
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
      ownershipRoot: root,
      config: resolveCodexComputerUseConfig({
        overrides: { enabled: true, marketplacePath: "/custom/marketplace" },
      }),
      bundledMarketplacePath: path.join(root, "openai-bundled"),
    });
    expect(result).toEqual({ status: "explicit_marketplace", changed: false });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked isolated Codex home without touching its external target",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-marketplace-home-symlink-");
      const ownershipRoot = path.join(root, "agent");
      const codexHome = path.join(ownershipRoot, "codex-home");
      const externalHome = path.join(root, "external-home");
      const sourcePath = path.join(root, "source", "openai-bundled");
      const sentinelPath = path.join(externalHome, "sentinel.txt");
      await fs.mkdir(ownershipRoot, { recursive: true });
      await fs.mkdir(externalHome, { recursive: true });
      await fs.mkdir(sourcePath, { recursive: true });
      await fs.writeFile(sentinelPath, "outside");
      await fs.symlink(externalHome, codexHome, "dir");

      await expect(
        ensureCodexComputerUseBundledMarketplace({
          codexHome,
          ownershipRoot,
          config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
          bundledMarketplacePath: sourcePath,
        }),
      ).rejects.toThrow(/symlinked directory|real directory|symbolic link/iu);

      expect((await fs.lstat(codexHome)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(externalHome, ".tmp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked Codex config without modifying its external target",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-marketplace-config-symlink-");
      const ownershipRoot = path.join(root, "agent");
      const codexHome = path.join(ownershipRoot, "codex-home");
      const sourcePath = path.join(root, "source", "openai-bundled");
      const externalConfig = path.join(root, "external-config.toml");
      await fs.mkdir(codexHome, { recursive: true });
      await fs.mkdir(sourcePath, { recursive: true });
      await fs.writeFile(externalConfig, 'owner = "outside"\n');
      await fs.symlink(externalConfig, path.join(codexHome, "config.toml"));

      await expect(
        ensureCodexComputerUseBundledMarketplace({
          codexHome,
          ownershipRoot,
          config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
          bundledMarketplacePath: sourcePath,
        }),
      ).rejects.toThrow(/Codex config must not be a symbolic link/iu);

      await expect(fs.readFile(externalConfig, "utf8")).resolves.toBe('owner = "outside"\n');
      expect((await fs.lstat(path.join(codexHome, "config.toml"))).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses to publish or clean up through a marketplace parent rebound during staging",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-marketplace-parent-rebind-");
      const ownershipRoot = path.join(root, "agent");
      const codexHome = path.join(ownershipRoot, "codex-home");
      const marketplaceParent = path.join(codexHome, ".tmp", "bundled-marketplaces");
      const parkedParent = path.join(codexHome, ".tmp", "bundled-marketplaces-owned");
      const externalParent = path.join(root, "external-marketplace");
      const sourcePath = path.join(root, "source", "openai-bundled");
      const externalSource = path.join(root, "external-source", "openai-bundled");
      const externalTarget = path.join(externalParent, "openai-bundled");
      const sentinelPath = path.join(externalParent, "sentinel.txt");
      await fs.mkdir(marketplaceParent, { recursive: true });
      await fs.mkdir(externalParent, { recursive: true });
      await fs.mkdir(sourcePath, { recursive: true });
      await fs.mkdir(externalSource, { recursive: true });
      await fs.symlink(externalSource, externalTarget, "dir");
      await fs.writeFile(sentinelPath, "outside");
      const originalSymlink = fs.symlink.bind(fs);
      let rebound = false;
      vi.spyOn(fs, "symlink").mockImplementation(async (target, linkPath, type) => {
        await originalSymlink(target, linkPath, type);
        if (!rebound && path.basename(String(linkPath)).startsWith(".openai-bundled.staging-")) {
          rebound = true;
          await fs.rename(marketplaceParent, parkedParent);
          await originalSymlink(externalParent, marketplaceParent, "dir");
        }
      });

      await expect(
        ensureCodexComputerUseBundledMarketplace({
          codexHome,
          ownershipRoot,
          config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
          bundledMarketplacePath: sourcePath,
        }),
      ).rejects.toThrow(/marketplace parent changed during refresh/iu);

      expect(rebound).toBe(true);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(fs.realpath(externalTarget)).resolves.toBe(await fs.realpath(externalSource));
      await expect(fs.access(path.join(externalParent, "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await fs.readdir(parkedParent)).some((entry) =>
          entry.startsWith(".openai-bundled.staging-"),
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses to publish or clean up through a Codex home rebound during config staging",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-marketplace-home-rebind-");
      const ownershipRoot = path.join(root, "agent");
      const codexHome = path.join(ownershipRoot, "codex-home");
      const parkedHome = path.join(ownershipRoot, "codex-home-owned");
      const externalHome = path.join(root, "external-home");
      const sourcePath = path.join(root, "source", "openai-bundled");
      const externalConfig = path.join(externalHome, "config.toml");
      const sentinelPath = path.join(externalHome, "sentinel.txt");
      await fs.mkdir(codexHome, { recursive: true });
      await fs.mkdir(externalHome, { recursive: true });
      await fs.mkdir(sourcePath, { recursive: true });
      await fs.writeFile(externalConfig, 'owner = "outside"\n');
      await fs.writeFile(sentinelPath, "outside");
      const originalWriteFile = fs.writeFile.bind(fs);
      const originalSymlink = fs.symlink.bind(fs);
      let rebound = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        await originalWriteFile(file, data, options);
        if (!rebound && path.basename(String(file)).startsWith(".config.toml.staging-")) {
          rebound = true;
          await fs.rename(codexHome, parkedHome);
          await originalSymlink(externalHome, codexHome, "dir");
        }
      });

      await expect(
        ensureCodexComputerUseBundledMarketplace({
          codexHome,
          ownershipRoot,
          config: resolveCodexComputerUseConfig({ overrides: { enabled: true } }),
          bundledMarketplacePath: sourcePath,
        }),
      ).rejects.toThrow(/isolated Codex home changed during refresh/iu);

      expect(rebound).toBe(true);
      await expect(fs.readFile(externalConfig, "utf8")).resolves.toBe('owner = "outside"\n');
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      expect(
        (await fs.readdir(parkedHome)).some((entry) => entry.startsWith(".config.toml.staging-")),
      ).toBe(true);
    },
  );
});
