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
import nodeConfig from "config";
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
    const workspacePath = params.workspace || process.cwd();
    
    try {
      // Load configuration with node-config
      const resolved = nodeConfig.util.toObject();
      
      return {
        success: true,
        configuration: resolved,
      };
    } catch (error) {
      log.error("Failed to load configuration", { 
        workspacePath, 
        error: error instanceof Error ? error.message : String(error) 
      });
      return {
        success: false,
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
    const workspacePath = params.workspace || process.cwd();
    
    try {
      // Load configuration with node-config
      const resolved = nodeConfig.util.toObject();
      
      return {
        success: true,
        configuration: resolved,
      };
    } catch (error) {
      log.error("Failed to load configuration", { 
        workspacePath, 
        error: error instanceof Error ? error.message : String(error) 
      });
      return {
        success: false,
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
