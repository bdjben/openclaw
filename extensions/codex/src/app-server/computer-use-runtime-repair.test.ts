// Codex tests cover live, agent-local Computer Use runtime reconciliation.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureService: vi.fn(),
  killChildren: vi.fn(),
  readContext: vi.fn(),
}));

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: runtimeMocks.ensureService,
}));

vi.mock("./computer-use-process-repair.js", () => ({
  killStaleComputerUseMcpChildren: runtimeMocks.killChildren,
}));

vi.mock("./shared-client.js", () => ({
  readCodexComputerUseRuntimeContext: runtimeMocks.readContext,
}));

import { getCodexComputerUseRuntimeReconciler } from "./computer-use-runtime-repair.js";

describe("Codex Computer Use runtime reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runtimeMocks.ensureService.mockReset();
    runtimeMocks.killChildren.mockReset();
    runtimeMocks.readContext.mockReset();
  });

  it("replaces the warm native client immediately when the signed source changed", async () => {
    const client = createClient(4101);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({ status: "refreshed", changed: true });
    runtimeMocks.killChildren.mockResolvedValue(repairStatus([4201]));

    await getCodexComputerUseRuntimeReconciler(client).synchronizeBeforeRequest();

    expect(runtimeMocks.ensureService).toHaveBeenCalledWith({
      ...runtimeContext(),
      forceRevalidate: false,
    });
    expect(runtimeMocks.killChildren).toHaveBeenCalledWith({ ancestorPid: 4101 });
  });

  it("keeps the warm fast path when the signed source generation is unchanged", async () => {
    const client = createClient(4102);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({ status: "already_current", changed: false });

    await getCodexComputerUseRuntimeReconciler(client).synchronizeBeforeRequest();

    expect(runtimeMocks.killChildren).not.toHaveBeenCalled();
  });

  it("force-revalidates the bundle and replaces the client after a failed handshake", async () => {
    const client = createClient(4103);
    runtimeMocks.readContext.mockReturnValue(runtimeContext());
    runtimeMocks.ensureService.mockResolvedValue({ status: "already_current", changed: false });
    runtimeMocks.killChildren.mockResolvedValue(repairStatus([4203]));

    const result = await getCodexComputerUseRuntimeReconciler(client).repairAfterProbeFailure();

    expect(runtimeMocks.ensureService).toHaveBeenCalledWith({
      ...runtimeContext(),
      forceRevalidate: true,
    });
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
    const reconciler = getCodexComputerUseRuntimeReconciler(client);

    const first = reconciler.repairAfterProbeFailure();
    const second = reconciler.repairAfterProbeFailure();
    await vi.waitFor(() => expect(runtimeMocks.ensureService).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([first, second]);

    expect(runtimeMocks.ensureService).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.killChildren).toHaveBeenCalledTimes(1);
  });
});

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

function repairStatus(killedPids: number[]) {
  return {
    attempted: true,
    killedPids,
    warnings: [],
    message: "Replaced the stale native client.",
  };
}
