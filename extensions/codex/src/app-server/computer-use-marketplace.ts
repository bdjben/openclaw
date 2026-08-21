/** Prepares Codex's reserved bundled marketplace inside an isolated agent home. */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
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

  const marketplacePath = path.join(
    params.codexHome,
    ".tmp",
    "bundled-marketplaces",
    BUNDLED_MARKETPLACE_NAME,
  );
  const linkChanged = await ensureMarketplaceSymlink(marketplacePath, sourcePath);
  const configChanged = await ensureMarketplaceConfig(params.codexHome, marketplacePath);
  return {
    status: "ready",
    changed: linkChanged || configChanged,
    sourcePath,
    marketplacePath,
  };
}

async function ensureMarketplaceSymlink(targetPath: string, sourcePath: string): Promise<boolean> {
  const parentPath = path.dirname(targetPath);
  await fs.mkdir(parentPath, { recursive: true });
  const current = await fs.lstat(targetPath).catch(() => undefined);
  if (current?.isSymbolicLink()) {
    const currentTarget = await fs.readlink(targetPath);
    if (path.resolve(parentPath, currentTarget) === path.resolve(sourcePath)) {
      return false;
    }
  }

  const stagingPath = path.join(
    parentPath,
    `.${BUNDLED_MARKETPLACE_NAME}.staging-${process.pid}-${Date.now()}`,
  );
  const backupPath = path.join(
    parentPath,
    `.${BUNDLED_MARKETPLACE_NAME}.backup-${process.pid}-${Date.now()}`,
  );
  await fs.symlink(sourcePath, stagingPath, "dir");
  let backupCreated = false;
  try {
    if (current) {
      await fs.rename(targetPath, backupPath);
      backupCreated = true;
    }
    try {
      await fs.rename(stagingPath, targetPath);
    } catch (error) {
      if (backupCreated) {
        await fs.rename(backupPath, targetPath);
        backupCreated = false;
      }
      throw error;
    }
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true, force: true });
    }
    return true;
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
}

async function ensureMarketplaceConfig(
  codexHome: string,
  marketplacePath: string,
): Promise<boolean> {
  const configPath = path.join(codexHome, CONFIG_FILENAME);
  const existing = await fs.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
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
  const existingStat = await fs.stat(configPath).catch(() => undefined);
  const stagingPath = path.join(
    codexHome,
    `.${CONFIG_FILENAME}.staging-${process.pid}-${Date.now()}`,
  );
  try {
    await fs.writeFile(stagingPath, serialized, {
      mode: existingStat ? existingStat.mode & 0o777 : 0o600,
    });
    await fs.rename(stagingPath, configPath);
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
  return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
