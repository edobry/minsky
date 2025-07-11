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
    schema: (z.boolean() as any).default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: (z.boolean() as any).default(false),
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
    schema: (z.boolean() as any).default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: (z.boolean() as any).default(false),
    description: "Show configuration sources and precedence",
    required: false,
  },
};

/**
 * Config list command definition
 */
const configListRegistration = {
  id: "config.list",
  category: (CommandCategory as any).CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  parameters: configListParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use node-config directly to get configuration
      const sources = (config.util as any).getConfigSources();
      const resolved = {
        backend: config.get("backend"),
        backendConfig: config.get("backendConfig"),
        credentials: config.has("credentials") ? config.get("credentials") : {},
        sessiondb: config.get("sessiondb"),
        ai: config.has("ai") ? config.get("ai") : undefined,
      };

      return {
        success: true,
        json: (params as any).json || false,
        sources: (sources as any).map((source) => ({
          name: (source as any).name,
          original: (source as any).original,
          parsed: (source as any).parsed,
        })),
        resolved,
        showSources: (params as any).sources || false,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: (params as any).json || false,
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
  category: (CommandCategory as any).CONFIG,
  name: "show",
  description: "Show the final resolved configuration",
  parameters: configShowParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use node-config directly to get resolved configuration
      const resolved = {
        backend: config.get("backend"),
        backendConfig: config.get("backendConfig"),
        credentials: config.has("credentials") ? config.get("credentials") : {},
        sessiondb: config.get("sessiondb"),
        ai: config.has("ai") ? config.get("ai") : undefined,
      };

      return {
        success: true,
        json: (params as any).json || false,
        configuration: resolved,
        showSources: (params as any).sources || false,
        ...((params as any).sources && {
          sources: (config.util.getConfigSources() as any).map((source) => ({
            name: (source as any).name,
            original: (source as any).original,
            parsed: (source as any).parsed,
          })),
        }),
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: (params as any).json || false,
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
  (sharedCommandRegistry as any).registerCommand(configListRegistration);
  (sharedCommandRegistry as any).registerCommand(configShowRegistration);
}
