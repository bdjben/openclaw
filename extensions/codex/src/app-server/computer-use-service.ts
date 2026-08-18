/** Native Computer Use service provisioning for isolated Codex homes. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";

const SERVICE_APP_NAME = "Codex Computer Use.app";
const SERVICE_BUNDLE_ID = "com.openai.sky.CUAService";
const CLIENT_BUNDLE_ID = "com.openai.sky.CUAService.cli";
const OPENAI_TEAM_ID = "2DC432GLL2";
const CLIENT_APP_RELATIVE_PATH = path.join("Contents", "SharedSupport", "SkyComputerUseClient.app");
const CLIENT_RELATIVE_PATH = path.join(
  CLIENT_APP_RELATIVE_PATH,
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);
const COPY_TIMEOUT_MS = 120_000;
const INSPECT_TIMEOUT_MS = 30_000;
const activeInstalls = new Map<
  string,
  { syncKey: string; promise: Promise<CodexComputerUseServiceStatus> }
>();
const completedSyncs = new Map<
  string,
  Pick<CodexComputerUseServiceStatus, "targetPath" | "sourcePath" | "sourceBuild"> & {
    syncKey: string;
  }
>();

type CodexComputerUseServiceStatus = {
  status: "installed" | "refreshed" | "already_current" | "source_missing" | "unsupported";
  changed: boolean;
  targetPath?: string;
  sourcePath?: string;
  sourceBuild?: string;
  previousBuild?: string;
};

type CopyServiceApp = (sourcePath: string, targetPath: string) => Promise<void>;
type InspectServiceApp = (appPath: string) => Promise<CodexComputerUseServiceIdentity | undefined>;

type CodexComputerUseServiceIdentity = {
  bundleId: string;
  version: string;
  build: string;
  cdHash: string;
  teamId: string;
  clientBundleId: string;
  clientCdHash: string;
  clientTeamId: string;
};

type ServiceAppSnapshot = {
  exists: boolean;
  identity?: CodexComputerUseServiceIdentity;
  filesystemKey?: string;
};

/** Synchronizes the CODEX_HOME native client with the selected signed desktop distribution. */
export async function ensureCodexComputerUseServiceApp(params: {
  codexHome: string;
  platform?: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
  inspectServiceApp?: InspectServiceApp;
}): Promise<CodexComputerUseServiceStatus> {
  const platform = params.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "unsupported", changed: false };
  }
  const targetPath = path.join(path.resolve(params.codexHome), "computer-use", SERVICE_APP_NAME);
  const candidates =
    params.sourceAppCandidates ??
    resolveMacOSDesktopCodexComputerUseServiceAppCandidates(platform, params.appServerCommand);
  const syncKey = [targetPath, ...candidates].join("\0");
  const completed = completedSyncs.get(targetPath);
  if (completed?.syncKey === syncKey) {
    return {
      status: "already_current",
      changed: false,
      targetPath: completed.targetPath,
      sourcePath: completed.sourcePath,
      sourceBuild: completed.sourceBuild,
    };
  }
  const active = activeInstalls.get(targetPath);
  if (active) {
    if (active.syncKey === syncKey) {
      return await active.promise;
    }
    await active.promise.catch(() => undefined);
    return await ensureCodexComputerUseServiceApp(params);
  }
  if (completed) {
    completedSyncs.delete(targetPath);
  }
  const install = ensureCodexComputerUseServiceAppOnce({
    ...params,
    targetPath,
    platform,
    sourceAppCandidates: candidates,
  }).then((result) => {
    if (isCompletedSyncStatus(result.status)) {
      completedSyncs.set(targetPath, {
        syncKey,
        targetPath: result.targetPath,
        sourcePath: result.sourcePath,
        sourceBuild: result.sourceBuild,
      });
    }
    return result;
  });
  const activeEntry = { syncKey, promise: install };
  activeInstalls.set(targetPath, activeEntry);
  const clearActive = () => {
    if (activeInstalls.get(targetPath) === activeEntry) {
      activeInstalls.delete(targetPath);
    }
  };
  void install.then(clearActive, clearActive);
  return await install;
}

function isCompletedSyncStatus(status: CodexComputerUseServiceStatus["status"]): boolean {
  return status === "installed" || status === "refreshed" || status === "already_current";
}

async function ensureCodexComputerUseServiceAppOnce(params: {
  codexHome: string;
  targetPath: string;
  platform: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
  inspectServiceApp?: InspectServiceApp;
}): Promise<CodexComputerUseServiceStatus> {
  const inspectServiceApp = params.inspectServiceApp ?? inspectTrustedServiceApp;
  const candidates = params.sourceAppCandidates ?? [];
  const source = await findUsableServiceApp(candidates, inspectServiceApp);
  if (!source) {
    return { status: "source_missing", changed: false, targetPath: params.targetPath };
  }
  const { path: sourcePath, identity: sourceIdentity } = source;
  const initialTarget = await readServiceAppSnapshot(params.targetPath, inspectServiceApp);
  if (initialTarget.identity && identitiesMatch(initialTarget.identity, sourceIdentity)) {
    return {
      status: "already_current",
      changed: false,
      targetPath: params.targetPath,
      sourcePath,
      sourceBuild: sourceIdentity.build,
    };
  }

  const targetParent = path.dirname(params.targetPath);
  await fs.mkdir(targetParent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(targetParent, ".service-app.staging-"));
  const stagedPath = path.join(stagingRoot, SERVICE_APP_NAME);
  const backupPath = path.join(targetParent, `.service-app.backup-${process.pid}-${Date.now()}`);
  let backupCreated = false;
  try {
    await (params.copyServiceApp ?? copyServiceAppWithDitto)(sourcePath, stagedPath);
    const stagedIdentity = await inspectServiceApp(stagedPath);
    if (!stagedIdentity || !identitiesMatch(stagedIdentity, sourceIdentity)) {
      throw new Error(
        `Copied Computer Use service app at ${stagedPath} does not match its selected signed source.`,
      );
    }
    const stagedSnapshot = await readServiceAppSnapshot(stagedPath, inspectServiceApp);
    const currentSourceIdentity = await inspectServiceApp(sourcePath);
    if (!currentSourceIdentity || !identitiesMatch(currentSourceIdentity, sourceIdentity)) {
      throw new Error("Selected Computer Use service source changed during refresh.");
    }
    if (await pathExists(params.targetPath)) {
      await fs.rename(params.targetPath, backupPath);
      backupCreated = true;
      const movedTarget = await readServiceAppSnapshot(backupPath, inspectServiceApp);
      if (movedTarget.identity && identitiesMatch(movedTarget.identity, sourceIdentity)) {
        // Another runtime installed the selected signed generation while this
        // process was staging. Keep that winner rather than replacing it.
        await fs.rename(backupPath, params.targetPath);
        backupCreated = false;
        return {
          status: "already_current",
          changed: false,
          targetPath: params.targetPath,
          sourcePath,
          sourceBuild: sourceIdentity.build,
        };
      }
      if (!snapshotsMatch(initialTarget, movedTarget)) {
        await fs.rename(backupPath, params.targetPath);
        backupCreated = false;
        throw new Error(
          "Computer Use service target changed to an unexpected generation during refresh.",
        );
      }
    }
    try {
      await fs.rename(stagedPath, params.targetPath);
    } catch (error) {
      const winnerIdentity = await inspectServiceApp(params.targetPath);
      if (!winnerIdentity || !identitiesMatch(winnerIdentity, sourceIdentity)) {
        if (backupCreated) {
          if (!(await pathExists(params.targetPath))) {
            await fs.rename(backupPath, params.targetPath);
            backupCreated = false;
          }
        }
        throw error;
      }
      // A concurrent installer won with the same selected signed generation.
      if (backupCreated) {
        await fs.rm(backupPath, { recursive: true, force: true });
        backupCreated = false;
      }
      return {
        status: "already_current",
        changed: false,
        targetPath: params.targetPath,
        sourcePath,
        sourceBuild: sourceIdentity.build,
      };
    }
    const installedSnapshot = await readServiceAppSnapshot(params.targetPath, inspectServiceApp);
    if (
      !installedSnapshot.identity ||
      !identitiesMatch(installedSnapshot.identity, sourceIdentity)
    ) {
      if (filesystemSnapshotsMatch(installedSnapshot, stagedSnapshot)) {
        await fs.rm(params.targetPath, { recursive: true, force: true });
        if (backupCreated) {
          await fs.rename(backupPath, params.targetPath);
          backupCreated = false;
        }
      }
      throw new Error(
        "Installed Computer Use service app failed post-install identity verification.",
      );
    }
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true, force: true });
      backupCreated = false;
    }
    return {
      status: initialTarget.exists ? "refreshed" : "installed",
      changed: true,
      targetPath: params.targetPath,
      sourcePath,
      sourceBuild: sourceIdentity.build,
      ...(initialTarget.identity ? { previousBuild: initialTarget.identity.build } : {}),
    };
  } catch (error) {
    if (backupCreated && !(await pathExists(params.targetPath))) {
      await fs.rename(backupPath, params.targetPath);
      backupCreated = false;
    }
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.lstat(filePath).then(
    () => true,
    () => false,
  );
}

async function findUsableServiceApp(
  candidates: readonly string[],
  inspectServiceApp: InspectServiceApp,
): Promise<{ path: string; identity: CodexComputerUseServiceIdentity } | undefined> {
  for (const candidate of candidates) {
    const identity = await inspectServiceApp(candidate);
    if (identity) {
      return { path: candidate, identity };
    }
  }
  return undefined;
}

async function readServiceAppSnapshot(
  appPath: string,
  inspectServiceApp: InspectServiceApp,
): Promise<ServiceAppSnapshot> {
  if (!(await pathExists(appPath))) {
    return { exists: false };
  }
  return {
    exists: true,
    identity: await inspectServiceApp(appPath),
    filesystemKey: await readServiceAppFilesystemKey(appPath),
  };
}

async function readServiceAppFilesystemKey(appPath: string): Promise<string | undefined> {
  const paths = [
    appPath,
    path.join(appPath, "Contents", "Info.plist"),
    path.join(appPath, CLIENT_RELATIVE_PATH),
  ];
  const entries = await Promise.all(
    paths.map(
      async (entryPath) =>
        await fs.stat(entryPath).then(
          (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
          () => "missing",
        ),
    ),
  );
  return entries.join("|");
}

function snapshotsMatch(left: ServiceAppSnapshot, right: ServiceAppSnapshot): boolean {
  if (left.exists !== right.exists) {
    return false;
  }
  if (!left.exists) {
    return true;
  }
  if (left.filesystemKey && right.filesystemKey && left.filesystemKey !== right.filesystemKey) {
    return false;
  }
  if (left.identity || right.identity) {
    return Boolean(
      left.identity && right.identity && identitiesMatch(left.identity, right.identity),
    );
  }
  return left.filesystemKey !== undefined && left.filesystemKey === right.filesystemKey;
}

function filesystemSnapshotsMatch(left: ServiceAppSnapshot, right: ServiceAppSnapshot): boolean {
  return Boolean(
    left.exists &&
    right.exists &&
    left.filesystemKey &&
    right.filesystemKey &&
    left.filesystemKey === right.filesystemKey,
  );
}

function identitiesMatch(
  left: CodexComputerUseServiceIdentity,
  right: CodexComputerUseServiceIdentity,
): boolean {
  return (
    left.bundleId === right.bundleId &&
    left.version === right.version &&
    left.build === right.build &&
    left.cdHash === right.cdHash &&
    left.teamId === right.teamId &&
    left.clientBundleId === right.clientBundleId &&
    left.clientCdHash === right.clientCdHash &&
    left.clientTeamId === right.clientTeamId
  );
}

async function hasExecutableClient(appPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(appPath, CLIENT_RELATIVE_PATH), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectTrustedServiceApp(
  appPath: string,
): Promise<CodexComputerUseServiceIdentity | undefined> {
  if (!(await hasExecutableClient(appPath))) {
    return undefined;
  }
  const clientAppPath = path.join(appPath, CLIENT_APP_RELATIVE_PATH);
  try {
    await verifyTrustedBundle(appPath, SERVICE_BUNDLE_ID, true);
    await verifyTrustedBundle(clientAppPath, CLIENT_BUNDLE_ID, false);
    const [info, serviceSignature, clientSignature] = await Promise.all([
      readBundleInfo(appPath),
      readCodeSignature(appPath),
      readCodeSignature(clientAppPath),
    ]);
    if (
      !info ||
      serviceSignature.identifier !== SERVICE_BUNDLE_ID ||
      serviceSignature.teamId !== OPENAI_TEAM_ID ||
      clientSignature.identifier !== CLIENT_BUNDLE_ID ||
      clientSignature.teamId !== OPENAI_TEAM_ID
    ) {
      return undefined;
    }
    return {
      bundleId: serviceSignature.identifier,
      version: info.version,
      build: info.build,
      cdHash: serviceSignature.cdHash,
      teamId: serviceSignature.teamId,
      clientBundleId: clientSignature.identifier,
      clientCdHash: clientSignature.cdHash,
      clientTeamId: clientSignature.teamId,
    };
  } catch {
    return undefined;
  }
}

async function verifyTrustedBundle(
  appPath: string,
  bundleId: string,
  deep: boolean,
): Promise<void> {
  const requirement =
    `anchor apple generic and certificate leaf[subject.OU] = "${OPENAI_TEAM_ID}" ` +
    `and identifier "${bundleId}"`;
  await runExec(
    "/usr/bin/codesign",
    ["--verify", "--strict", ...(deep ? ["--deep"] : []), `-R=${requirement}`, appPath],
    { logOutput: false, timeoutMs: INSPECT_TIMEOUT_MS },
  );
}

async function readBundleInfo(
  appPath: string,
): Promise<{ version: string; build: string } | undefined> {
  const result = await runExec(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", path.join(appPath, "Contents", "Info.plist")],
    { logOutput: false, timeoutMs: INSPECT_TIMEOUT_MS },
  );
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const version = parsed.CFBundleShortVersionString;
  const build = parsed.CFBundleVersion;
  return typeof version === "string" && version && typeof build === "string" && build
    ? { version, build }
    : undefined;
}

async function readCodeSignature(
  appPath: string,
): Promise<{ identifier: string; teamId: string; cdHash: string }> {
  const result = await runExec("/usr/bin/codesign", ["-d", "--verbose=4", appPath], {
    logOutput: false,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const identifier = readCodeSignField(output, "Identifier");
  const teamId = readCodeSignField(output, "TeamIdentifier");
  const cdHash = readCodeSignField(output, "CDHash").toLowerCase();
  if (!identifier || !teamId || !/^[a-f0-9]+$/.test(cdHash)) {
    throw new Error(`Could not inspect the signed identity at ${appPath}.`);
  }
  return { identifier, teamId, cdHash };
}

function readCodeSignField(output: string, field: string): string {
  const prefix = `${field}=`;
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() ?? "";
}

async function copyServiceAppWithDitto(sourcePath: string, targetPath: string): Promise<void> {
  await runExec("/usr/bin/ditto", ["--noqtn", sourcePath, targetPath], {
    logOutput: false,
    timeoutMs: COPY_TIMEOUT_MS,
  });
}
