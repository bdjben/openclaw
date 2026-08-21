// Codex tests cover live, agent-local Computer Use runtime reconciliation.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureService: vi.fn(),
  killChildren: vi.fn(),
  readContext: vi.fn(),
  retireClient: vi.fn(),
}));

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: runtimeMocks.ensureService,
}));

vi.mock("./computer-use-process-repair.js", () => ({
  killStaleComputerUseMcpChildren: runtimeMocks.killChildren,
}));

vi.mock("./shared-client.js", () => ({
  CodexAppServerStartSelectionChangedError: class CodexAppServerStartSelectionChangedError extends Error {
    readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";
  },
  readCodexComputerUseRuntimeContext: runtimeMocks.readContext,
  retireSharedCodexAppServerClientIfCurrent: runtimeMocks.retireClient,
}));

import { getCodexComputerUseRuntimeReconciler } from "./computer-use-runtime-repair.js";

describe("Codex Computer Use runtime reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runtimeMocks.ensureService.mockReset();
    runtimeMocks.killChildren.mockReset();
    runtimeMocks.readContext.mockReset();
    runtimeMocks.retireClient.mockReset();
  });

  it("retires the warm app-server when the signed source changed", async () => {
    const client = createClient(4101);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({
      status: "refreshed",
      changed: true,
      sourceBuild: "1000816",
    });
    runtimeMocks.killChildren.mockResolvedValue(repairStatus([4201]));

    await expect(requireRuntimeReconciler(client).synchronizeBeforeRequest()).rejects.toMatchObject(
      { code: "CODEX_APP_SERVER_START_SELECTION_CHANGED" },
    );

    expect(runtimeMocks.ensureService).toHaveBeenCalledWith(serviceParams(false));
    expect(runtimeMocks.killChildren).toHaveBeenCalledWith({ ancestorPid: 4101 });
    expect(runtimeMocks.retireClient).toHaveBeenCalledWith(client);
  });

  it("keeps the warm fast path when the signed source generation is unchanged", async () => {
    const client = createClient(4102);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({
      status: "already_current",
      changed: false,
      sourceBuild: "1000816",
    });

    await requireRuntimeReconciler(client).synchronizeBeforeRequest();

    expect(runtimeMocks.killChildren).not.toHaveBeenCalled();
    expect(runtimeMocks.retireClient).not.toHaveBeenCalled();
  });

  it("retires the warm app-server when another reconciler already refreshed its target", async () => {
    const client = createClient(4105);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService
      .mockResolvedValueOnce({
        status: "already_current",
        changed: false,
        sourceBuild: "1000790",
      })
      .mockResolvedValueOnce({
        status: "already_current",
        changed: false,
        sourceBuild: "1000816",
      });
    const reconciler = requireRuntimeReconciler(client);

    await reconciler.synchronizeBeforeRequest();
    await expect(reconciler.synchronizeBeforeRequest()).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
    });

    expect(runtimeMocks.killChildren).not.toHaveBeenCalled();
    expect(runtimeMocks.retireClient).toHaveBeenCalledWith(client);
  });

  it("force-revalidates the bundle and replaces the client after a failed handshake", async () => {
    const client = createClient(4103);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({ status: "already_current", changed: false });
    runtimeMocks.killChildren.mockResolvedValue(repairStatus([4203]));

    const result = await requireRuntimeReconciler(client).repairAfterProbeFailure();

    expect(runtimeMocks.ensureService).toHaveBeenCalledWith(serviceParams(true));
    expect(runtimeMocks.killChildren).toHaveBeenCalledWith({ ancestorPid: 4103 });
    expect(result.killedPids).toEqual([4203]);
  });

  it("coalesces simultaneous forced repairs for one physical app-server", async () => {
    const client = createClient(4104);
    const gate = createDeferred<void>();
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockImplementation(async () => {
      await gate.promise;
      return { status: "already_current", changed: false };
    });
    runtimeMocks.killChildren.mockResolvedValue(repairStatus([4204]));
    const reconciler = requireRuntimeReconciler(client);

    const first = reconciler.repairAfterProbeFailure();
    const second = reconciler.repairAfterProbeFailure();
    await vi.waitFor(() => expect(runtimeMocks.ensureService).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([first, second]);

    expect(runtimeMocks.ensureService).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.killChildren).toHaveBeenCalledTimes(1);
  });

  it("does not attach automatic repair outside a managed isolated runtime", () => {
    const client = createClient(4106);
    runtimeMocks.readContext.mockReturnValue(undefined);

    expect(getCodexComputerUseRuntimeReconciler(client)).toBeUndefined();
    expect(runtimeMocks.ensureService).not.toHaveBeenCalled();
    expect(runtimeMocks.killChildren).not.toHaveBeenCalled();
    expect(runtimeMocks.retireClient).not.toHaveBeenCalled();
  });
});

function requireRuntimeReconciler(client: CodexAppServerClient) {
  const reconciler = getCodexComputerUseRuntimeReconciler(client);
  if (!reconciler) {
    throw new Error("expected a managed isolated Computer Use runtime reconciler");
  }
  return reconciler;
}

function createClient(pid: number): CodexAppServerClient {
  return { getTransportPid: () => pid } as CodexAppServerClient;
}

function runtimeContext() {
  return {
    codexHome: "/owned/agent/codex-home",
    ownershipRoot: "/owned/agent",
    appServerCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
  };
}

function serviceParams(forceRevalidate: boolean) {
  return { ...runtimeContext(), forceRevalidate };
}

function repairStatus(killedPids: number[]) {
  return {
    attempted: true,
    killedPids,
    warnings: [],
    message: "Replaced the stale native client.",
  };
}
