import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import sessionSharePlugin from "../../extensions/session-share/index.js";

export function registerSessionShare(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  const catalogs: SessionCatalogProvider[] = [];
  const services: OpenClawPluginService[] = [];
  const api = createTestPluginApi({
    runtime,
    config,
    registerNodeHostCommand: (command) => {
      nodeCommands.push(command);
    },
    registerSessionCatalog: (catalog) => {
      catalogs.push(catalog);
    },
    registerService: (service) => {
      services.push(service);
    },
  });
  sessionSharePlugin.register(api);
  const catalog = catalogs.find((entry) => entry.id === "openclaw");
  if (!catalog) {
    throw new Error("Session Share did not register its catalog");
  }
  return { commands: nodeCommands, catalog, services, logger: api.logger };
}
