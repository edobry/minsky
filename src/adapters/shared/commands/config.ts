/**
 * Shared Config Commands
 *
 * This module contains shared config command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
// Delay config import to prevent early initialization before config-setup runs
let config: any = null;
function getConfig() {
  if (!config) {
    console.log(`DEBUG: NODE_CONFIG_DIR = ${process.env.NODE_CONFIG_DIR}`);
    config = require("config");

    // Check what sources were found
    try {
      const sources = config.util.getConfigSources();
      console.log(`DEBUG: Found ${sources.length} config sources:`, sources.map(s => s.name));
    } catch (e) {
      console.log(`DEBUG: Error getting sources: ${e}`);
    }
  }
  return config;
}
import { log } from "../../../utils/logger";

/**
 * Parameters for config list command
 */
const configListParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: z.boolean().default(false),
    description: "Show configuration sources and precedence",
    required: false,
  },
};

/**
 * Parameters for config show command
 */
const configShowParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: z.boolean().default(false),
    description: "Show configuration sources and precedence",
    required: false,
  },
};

/**
 * Config list command definition
 */
const configListRegistration = {
  id: "config.list",
  category: CommandCategory.CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  parameters: configListParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use node-config directly to get configuration
      const sources = getConfig().util.getConfigSources();
      const resolved = {
        backend: getConfig().get("backend"),
        backendConfig: getConfig().get("backendConfig"),
        credentials: getConfig().has("credentials") ? getConfig().get("credentials") : {},
        sessiondb: getConfig().get("sessiondb"),
        ai: getConfig().has("ai") ? getConfig().get("ai") : undefined,
      };

      return {
        success: true,
        json: params.json || false,
        sources: sources.map((source) => ({
          name: source.name,
          original: source.original,
          parsed: source.parsed,
        })),
        resolved,
        showSources: params.sources || false,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error as any),
        showSources: (params as any).sources || false,
      };
    }
  },
} as any;

/**
 * Config show command definition
 */
const configShowRegistration = {
  id: "config.show",
  category: CommandCategory.CONFIG,
  name: "show",
  description: "Show the final resolved configuration",
  parameters: configShowParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use node-config directly to get resolved configuration
      const resolved = {
        backend: getConfig().get("backend"),
        backendConfig: getConfig().get("backendConfig"),
        credentials: getConfig().has("credentials") ? getConfig().get("credentials") : {},
        sessiondb: getConfig().get("sessiondb"),
        ai: getConfig().has("ai") ? getConfig().get("ai") : undefined,
      };

      return {
        success: true,
        json: params.json || false,
        configuration: resolved,
        showSources: params.sources || false,
        ...(params.sources && {
          sources: getConfig().util.getConfigSources().map((source) => ({
            name: source.name,
            original: source.original,
            parsed: source.parsed,
          })),
        }),
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: params.json || false,
        error: getErrorMessage(error as any),
        showSources: (params as any).sources || false,
      };
    }
  },
} as any;

/**
 * Register all config commands
 */
export function registerConfigCommands() {
  sharedCommandRegistry.registerCommand(configListRegistration);
  sharedCommandRegistry.registerCommand(configShowRegistration);
}
