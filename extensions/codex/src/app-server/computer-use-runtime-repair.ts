// Keeps a warm Codex app-server's native Computer Use client compatible in place.
import type { CodexAppServerClient } from "./client.js";
import {
  killStaleComputerUseMcpChildren,
  type CodexComputerUseRepairStatus,
} from "./computer-use-process-repair.js";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import {
  readCodexComputerUseRuntimeContext,
  type CodexComputerUseRuntimeContext,
} from "./shared-client.js";

type ReconcileResult = {
  serviceChanged: boolean;
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
): CodexComputerUseRuntimeReconciler {
  const context = readCodexComputerUseRuntimeContext(client);
  const fingerprint = JSON.stringify(context ?? null);
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
  context: CodexComputerUseRuntimeContext | undefined,
): CodexComputerUseRuntimeReconciler {
  let active: { forceRevalidate: boolean; promise: Promise<ReconcileResult> } | undefined;

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
      await reconcile(false);
    },
    repairAfterProbeFailure: async () => {
      const result = await reconcile(true);
      if (!result.processRepair) {
        throw new Error("Computer Use runtime repair did not replace the native client process");
      }
      return result.processRepair;
    },
  };
}

async function reconcileOnce(params: {
  client: CodexAppServerClient;
  context?: CodexComputerUseRuntimeContext;
  forceRevalidate: boolean;
}): Promise<ReconcileResult> {
  const service = params.context
    ? await ensureCodexComputerUseServiceApp({
        codexHome: params.context.codexHome,
        ownershipRoot: params.context.ownershipRoot,
        appServerCommand: params.context.appServerCommand,
        forceRevalidate: params.forceRevalidate,
      })
    : undefined;
  if (!params.forceRevalidate && !service?.changed) {
    return { serviceChanged: false };
  }
  const processRepair = await killStaleComputerUseMcpChildren({
    ancestorPid: params.client.getTransportPid(),
  });
  return {
    serviceChanged: Boolean(service?.changed),
    processRepair: service?.changed
      ? {
          ...processRepair,
          message: `Synchronized the signed Computer Use client. ${processRepair.message}`,
        }
      : processRepair,
  };
}
