/** Prepares Codex's reserved bundled marketplace inside an isolated agent home. */
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  assertDirectoryIdentityStable,
  assertNotSymlink,
  directoryIdentityIsStable,
  ensureOwnedCodexHome,
  prepareOwnedServiceParent,
  readRealDirectoryIdentity,
} from "./computer-use-service-path.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import { resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath } from "./desktop-app-paths.js";

const BUNDLED_MARKETPLACE_NAME = "openai-bundled";
const CONFIG_FILENAME = "config.toml";

type CodexComputerUseBundledMarketplaceResult = {
  status: "disabled" | "explicit_marketplace" | "source_missing" | "ready";
  changed: boolean;
  sourcePath?: string;
  marketplacePath?: string;
};

/**
 * Codex reserves `openai-bundled` for materializations below
 * `$CODEX_HOME/.tmp/bundled-marketplaces`. OpenClaw-managed agent homes point
 * that location at the currently installed desktop bundle before app-server
 * startup, so a desktop update is visible without copying the whole catalog.
 */
export async function ensureCodexComputerUseBundledMarketplace(params: {
  codexHome: string;
  ownershipRoot: string;
  config: ResolvedCodexComputerUseConfig;
  bundledMarketplacePath?: string;
  bundledMarketplacePathCandidates?: readonly string[];
}): Promise<CodexComputerUseBundledMarketplaceResult> {
  if (!params.config.enabled) {
    return { status: "disabled", changed: false };
  }
  if (
    params.config.marketplaceSource ||
    params.config.marketplacePath ||
    params.config.marketplaceName
  ) {
    return { status: "explicit_marketplace", changed: false };
  }

  const sourcePath =
    params.bundledMarketplacePath ??
    resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath({
      candidates: params.bundledMarketplacePathCandidates,
    });
  if (!sourcePath) {
    return { status: "source_missing", changed: false };
  }

  const codexHome = path.resolve(params.codexHome);
  const ownershipRoot = path.resolve(params.ownershipRoot);
  await ensureOwnedCodexHome(codexHome, ownershipRoot);
  const marketplaceParent = path.join(codexHome, ".tmp", "bundled-marketplaces");
  const ownedMarketplaceParent = await prepareOwnedServiceParent({
    ownershipRoot,
    codexHome,
    targetParent: marketplaceParent,
  });
  const ownedCodexHome = await readRealDirectoryIdentity(codexHome, "isolated Codex home");
  const marketplacePath = path.join(
    codexHome,
    ".tmp",
    "bundled-marketplaces",
    BUNDLED_MARKETPLACE_NAME,
  );
  const linkChanged = await ensureMarketplaceSymlink({
    ownedParent: ownedMarketplaceParent,
    targetPath: path.join(ownedMarketplaceParent.realPath, BUNDLED_MARKETPLACE_NAME),
    sourcePath,
  });
  const configChanged = await ensureMarketplaceConfig({
    ownedCodexHome,
    marketplacePath,
  });
  return {
    status: "ready",
    changed: linkChanged || configChanged,
    sourcePath,
    marketplacePath,
  };
}

type OwnedDirectoryIdentity = Awaited<ReturnType<typeof readRealDirectoryIdentity>>;

async function ensureMarketplaceSymlink(params: {
  ownedParent: OwnedDirectoryIdentity;
  targetPath: string;
  sourcePath: string;
}): Promise<boolean> {
  const { ownedParent, sourcePath, targetPath } = params;
  await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
  const current = await fs.lstat(targetPath).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (current?.isSymbolicLink()) {
    const currentTarget = await fs.readlink(targetPath);
    await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
    if (path.resolve(ownedParent.realPath, currentTarget) === path.resolve(sourcePath)) {
      return false;
    }
  }

  const stagingPath = path.join(
    ownedParent.realPath,
    `.${BUNDLED_MARKETPLACE_NAME}.staging-${process.pid}-${Date.now()}`,
  );
  const backupPath = path.join(
    ownedParent.realPath,
    `.${BUNDLED_MARKETPLACE_NAME}.backup-${process.pid}-${Date.now()}`,
  );
  await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
  await fs.symlink(sourcePath, stagingPath, "dir");
  let backupCreated = false;
  try {
    await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
    if (current) {
      await fs.rename(targetPath, backupPath);
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
      backupCreated = true;
    }
    try {
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
      await fs.rename(stagingPath, targetPath);
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
    } catch (error) {
      if (
        backupCreated &&
        (await directoryIdentityIsStable(ownedParent)) &&
        !(await pathExists(targetPath))
      ) {
        await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
        await fs.rename(backupPath, targetPath);
        await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
        backupCreated = false;
      }
      throw error;
    }
    if (backupCreated) {
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
      await removeMarketplaceEntry(backupPath);
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
      backupCreated = false;
    }
    return true;
  } catch (error) {
    if (
      backupCreated &&
      (await directoryIdentityIsStable(ownedParent)) &&
      !(await pathExists(targetPath))
    ) {
      await assertDirectoryIdentityStable(ownedParent, "Computer Use marketplace parent");
      await fs.rename(backupPath, targetPath);
      backupCreated = false;
    }
    throw error;
  } finally {
    if (await directoryIdentityIsStable(ownedParent)) {
      await fs.rm(stagingPath, { force: true });
    }
  }
}

async function ensureMarketplaceConfig(params: {
  ownedCodexHome: OwnedDirectoryIdentity;
  marketplacePath: string;
}): Promise<boolean> {
  const { marketplacePath, ownedCodexHome } = params;
  const configPath = path.join(ownedCodexHome.realPath, CONFIG_FILENAME);
  await assertDirectoryIdentityStable(ownedCodexHome, "isolated Codex home");
  await assertNotSymlink(configPath, "Codex config");
  const existing = await fs.readFile(configPath, "utf8").catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  });
  await assertDirectoryIdentityStable(ownedCodexHome, "isolated Codex home");
  const parsedValue: unknown = existing.trim()
    ? parseToml(existing, { integersAsBigInt: true })
    : {};
  if (!isRecord(parsedValue)) {
    throw new Error("Codex config TOML root must be a table");
  }
  const parsed = parsedValue;
  const marketplaces = readOrCreateTable(parsed, "marketplaces");
  const bundled = readOrCreateTable(marketplaces, BUNDLED_MARKETPLACE_NAME);
  if (bundled.source_type === "local" && bundled.source === marketplacePath) {
    return false;
  }
  bundled.source_type = "local";
  bundled.source = marketplacePath;

  const serialized = stringifyToml(parsed);
  await assertNotSymlink(configPath, "Codex config");
  const existingStat = await fs.lstat(configPath).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  const stagingPath = path.join(
    ownedCodexHome.realPath,
    `.${CONFIG_FILENAME}.staging-${process.pid}-${Date.now()}`,
  );
  try {
    await assertDirectoryIdentityStable(ownedCodexHome, "isolated Codex home");
    await fs.writeFile(stagingPath, serialized, {
      mode: existingStat ? existingStat.mode & 0o777 : 0o600,
    });
    await assertDirectoryIdentityStable(ownedCodexHome, "isolated Codex home");
    await assertNotSymlink(configPath, "Codex config");
    await fs.rename(stagingPath, configPath);
    await assertDirectoryIdentityStable(ownedCodexHome, "isolated Codex home");
  } finally {
    if (await directoryIdentityIsStable(ownedCodexHome)) {
      await fs.rm(stagingPath, { force: true });
    }
  }
  return true;
}

async function removeMarketplaceEntry(entryPath: string): Promise<void> {
  const entry = await fs.lstat(entryPath);
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    await fs.rm(entryPath, { recursive: true, force: true });
    return;
  }
  await fs.unlink(entryPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function readOrCreateTable(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) {
    return value;
  }
  const table: Record<string, unknown> = {};
  parent[key] = table;
  return table;
}
