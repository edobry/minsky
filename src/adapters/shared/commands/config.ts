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
    schema: (z.boolean() as unknown).default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: (z.boolean() as unknown).default(false),
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
    schema: (z.boolean() as unknown).default(false),
    description: "Output in JSON format",
    required: false,
  },
  sources: {
    schema: (z.boolean() as unknown).default(false),
    description: "Show configuration sources and precedence",
    required: false,
  },
};

/**
 * Config list command definition
 */
const configListRegistration = {
  id: "config.list",
  category: (CommandCategory as unknown).CONFIG,
  name: "list",
  description: "Show all configuration from all sources",
  parameters: configListParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    try {
      // Use node-config directly to get configuration
      const sources = (config.util as unknown).getConfigSources();
      const resolved = {
        backend: config.get("backend"),
        backendConfig: config.get("backendConfig"),
        credentials: config.has("credentials") ? config.get("credentials") : {},
        sessiondb: config.get("sessiondb"),
        ai: config.has("ai") ? config.get("ai") : undefined,
      };

      return {
        success: true,
        json: (params as unknown).json || false,
        sources: sources.map((source) => ({
          name: (source as unknown).name,
          original: (source as unknown).original,
          parsed: (source as unknown).parsed,
        })),
        resolved,
        showSources: (params as unknown).sources || false,
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: (params as unknown).json || false,
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
  category: (CommandCategory as unknown).CONFIG,
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
        json: (params as unknown).json || false,
        configuration: resolved,
        showSources: (params as unknown).sources || false,
        ...((params as unknown).sources && {
          sources: config.util.getConfigSources().map((source) => ({
            name: (source as unknown).name,
            original: (source as unknown).original,
            parsed: (source as unknown).parsed,
          })),
        }),
      };
    } catch (error) {
      log.error("Failed to load configuration", {
        error: getErrorMessage(error as any),
      });
      return {
        success: false,
        json: (params as unknown).json || false,
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
  (sharedCommandRegistry as unknown).registerCommand(configListRegistration);
  (sharedCommandRegistry as unknown).registerCommand(configShowRegistration);
}
