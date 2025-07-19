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
import { has, get, getConfiguration } from "../../../domain/configuration/index";
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
      // Use custom configuration system to get configuration
      const { getConfigurationProvider } = await import("../../../domain/configuration/index");
      const provider = getConfigurationProvider();
      const config = provider.getConfig();
      const metadata = provider.getMetadata();

      const resolved = {
        backend: config.backend,
        backendConfig: config.backendConfig,
        sessiondb: config.sessiondb,
        ai: config.ai,
        github: config.github,
      };

      return {
        success: true,
        json: params.json || false,
        sources: metadata.sources.map((source) => ({
          name: source.name,
          priority: source.priority,
          loaded: source.loaded,
          path: source.path,
          error: source.error,
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
      // Use custom configuration system to get resolved configuration
      const config = getConfiguration();
      const resolved = {
        backend: config.backend,
        backendConfig: config.backendConfig,
        sessiondb: config.sessiondb,
        ai: config.ai,
        github: config.github,
      };

      return {
        success: true,
        json: params.json || false,
        configuration: resolved,
        showSources: params.sources || false,
        ...(params.sources && {
          sources: [{ name: "custom-config", original: "Custom Configuration System", parsed: resolved }],
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
