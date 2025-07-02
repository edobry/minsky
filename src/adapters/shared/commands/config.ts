/**
 * Shared Config Commands
 *
 * This module contains shared config command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import config from "config";
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
      const sources = config.util.getConfigSources();
      const resolved = {
        backend: config.get("backend"),
        backendConfig: config.get("backendConfig"),
        credentials: config.get("credentials"),
        sessiondb: config.get("sessiondb"),
        ai: config.has("ai") ? config.get("ai") : undefined,
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
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        json: params.json || false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

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
        backend: config.get("backend"),
        backendConfig: config.get("backendConfig"),
        credentials: config.get("credentials"),
        sessiondb: config.get("sessiondb"),
        ai: config.has("ai") ? config.get("ai") : undefined,
      };

      return {
        success: true,
        json: params.json || false,
        configuration: resolved,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        json: params.json || false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Register all config commands
 */
export function registerConfigCommands() {
  sharedCommandRegistry.registerCommand(configListRegistration);
  sharedCommandRegistry.registerCommand(configShowRegistration);
}
