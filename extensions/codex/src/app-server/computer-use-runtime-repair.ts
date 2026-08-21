// Keeps a warm Codex app-server's native Computer Use client compatible in place.
import type { CodexAppServerClient } from "./client.js";
import {
  killStaleComputerUseMcpChildren,
  type CodexComputerUseRepairStatus,
} from "./computer-use-process-repair.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import {
  CodexAppServerStartSelectionChangedError,
  readCodexComputerUseRuntimeContext,
  retireSharedCodexAppServerClientIfCurrent,
  type CodexComputerUseRuntimeContext,
} from "./shared-client.js";

type ReconcileResult = {
  serviceChanged: boolean;
  sourceBuild?: string;
  processRepair?: CodexComputerUseRepairStatus;
};

type CodexComputerUseRuntimeReconciler = {
  synchronizeBeforeRequest: () => Promise<void>;
  repairAfterProbeFailure: () => Promise<CodexComputerUseRepairStatus>;
};

type ReconcilerEntry = {
  fingerprint: string;
  reconciler: CodexComputerUseRuntimeReconciler;
};

const RUNTIME_RECONCILERS = Symbol.for("openclaw.codexComputerUseRuntimeReconcilers");

function getRuntimeReconcilerState(): WeakMap<CodexAppServerClient, ReconcilerEntry> {
  // SAFETY: this process-global Symbol is owned exclusively by this module and always stores this map shape.
  const globalState = globalThis as typeof globalThis & {
    [RUNTIME_RECONCILERS]?: WeakMap<CodexAppServerClient, ReconcilerEntry>;
  };
  globalState[RUNTIME_RECONCILERS] ??= new WeakMap();
  return globalState[RUNTIME_RECONCILERS];
}

/** Returns stable, coalesced request-time repair functions for one physical app-server. */
export function getCodexComputerUseRuntimeReconciler(
  client: CodexAppServerClient,
): CodexComputerUseRuntimeReconciler | undefined {
  const context = readCodexComputerUseRuntimeContext(client);
  if (!context) {
    return undefined;
  }
  const fingerprint = JSON.stringify(context);
  const state = getRuntimeReconcilerState();
  const existing = state.get(client);
  if (existing?.fingerprint === fingerprint) {
    return existing.reconciler;
  }
  const reconciler = createRuntimeReconciler(client, context);
  state.set(client, { fingerprint, reconciler });
  return reconciler;
}

function createRuntimeReconciler(
  client: CodexAppServerClient,
  context: CodexComputerUseRuntimeContext,
): CodexComputerUseRuntimeReconciler {
  let active: { forceRevalidate: boolean; promise: Promise<ReconcileResult> } | undefined;
  let attachedSourceBuild: string | undefined;

  const reconcile = async (forceRevalidate: boolean): Promise<ReconcileResult> => {
    if (active) {
      if (!forceRevalidate || active.forceRevalidate) {
        return await active.promise;
      }
      await active.promise;
      return await reconcile(true);
    }
    const promise = reconcileOnce({ client, context, forceRevalidate });
    const current = { forceRevalidate, promise };
    active = current;
    try {
      return await promise;
    } finally {
      if (active === current) {
        active = undefined;
      }
    }
  };

  return {
    synchronizeBeforeRequest: async () => {
      const result = await reconcile(false);
      requireCurrentAppServerGeneration(result);
    },
    repairAfterProbeFailure: async () => {
      const result = await reconcile(true);
      requireCurrentAppServerGeneration(result);
      if (!result.processRepair) {
        throw new Error("Computer Use runtime repair did not replace the native client process");
      }
      return result.processRepair;
    },
  };

  function requireCurrentAppServerGeneration(result: ReconcileResult): void {
    const sourceBuild = result.sourceBuild?.trim() || undefined;
    const sourceGenerationChanged =
      attachedSourceBuild !== undefined &&
      sourceBuild !== undefined &&
      attachedSourceBuild !== sourceBuild;
    if (sourceBuild) {
      attachedSourceBuild = sourceBuild;
    }
    if (!result.serviceChanged && !sourceGenerationChanged) {
      return;
    }
    // A Computer Use generation change also changes the native sender identity
    // trusted by the service. Replacing only the MCP child leaves a warm app-server
    // mapped to the previous signed desktop generation, which the refreshed service
    // rejects as unauthenticated. Detach this one physical client so the bounded
    // startup retry launches the current app-server without restarting the gateway.
    retireSharedCodexAppServerClientIfCurrent(client);
    throw new CodexAppServerStartSelectionChangedError(
      "Codex Computer Use runtime generation changed during startup",
    );
  }
}

async function reconcileOnce(params: {
  client: CodexAppServerClient;
  context: CodexComputerUseRuntimeContext;
  forceRevalidate: boolean;
}): Promise<ReconcileResult> {
  const service = await ensureCodexComputerUseServiceApp({
    codexHome: params.context.codexHome,
    ownershipRoot: params.context.ownershipRoot,
    appServerCommand: params.context.appServerCommand,
    forceRevalidate: params.forceRevalidate,
  });
  if (!params.forceRevalidate && !service?.changed) {
    return {
      serviceChanged: false,
      ...(service?.sourceBuild ? { sourceBuild: service.sourceBuild } : {}),
    };
  }
  const processRepair = await killStaleComputerUseMcpChildren({
    ancestorPid: params.client.getTransportPid(),
  });
  return {
    serviceChanged: service?.changed ?? false,
    ...(service?.sourceBuild ? { sourceBuild: service.sourceBuild } : {}),
    processRepair: service?.changed
      ? {
          ...processRepair,
          message: `Synchronized the signed Computer Use client. ${processRepair.message}`,
        }
      : processRepair,
  };
}
