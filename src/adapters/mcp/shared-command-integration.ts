/**
 * Shared Command Integration for MCP
 *
 * This module provides utilities for automatically registering shared commands
 * with the MCP command mapper, eliminating the need for manual command duplication.
 */

import type { CommandMapper } from "../../mcp/command-mapper";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type CommandParameterDefinition
} from "../shared/command-registry";
import { log } from "../../utils/logger";
import { z } from "zod";

/**
 * Convert shared command parameters to a Zod schema that MCP can use
 */
function convertParametersToZodSchema(parameters: CommandParameterMap): z.ZodObject<any> {
  // If no parameters, return empty object schema
  if (!parameters || Object.keys(parameters).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, param] of Object.entries(parameters)) {
    // Skip the json parameter in MCP context since MCP always returns JSON
    if (key === "json") {
      continue;
    }

    let schema = param.schema;

    // Make optional if not required
    if (!param.required) {
      schema = schema.optional();
    }

    // Add default value if present
    if (param.defaultValue !== undefined) {
      schema = schema.default(param.defaultValue);
    }

    shape[key] = schema;
  }

  const zodSchema = z.object(shape);

  log.debug("Converting parameters to Zod schema", {
    parameterCount: Object.keys(parameters).length,
    parameterKeys: Object.keys(parameters),
    shapeKeys: Object.keys(shape),
    zodSchema: zodSchema._def,
  });

  return zodSchema;
}

/**
 * Convert MCP args to the format expected by shared commands
 */
function convertMcpArgsToParameters(
  args: Record<string, any>,
  parameterDefs: CommandParameterMap
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, paramDef] of Object.entries(parameterDefs)) {
    const value = args[key];

    if (value !== undefined) {
      // Use the value as-is since it should already be validated by MCP
      result[key] = value;
    } else if (paramDef.defaultValue !== undefined) {
      // Use default value
      result[key] = paramDef.defaultValue;
    }
    // For required parameters, rely on Zod validation to catch missing values
  }

  return result;
}

/**
 * Configuration for MCP shared command registration
 */
export interface McpSharedCommandConfig {
  /** Array of command categories to register */
  categories: CommandCategory[];
  /** Command-specific overrides */
  commandOverrides?: Record<
    string,
    {
      /** Override command description */
      description?: string;
      /** Hide command from MCP */
      hidden?: boolean;
      /** MCP-specific parameter requirements */
      mcpRequiredParams?: string[];
    }
  >;
  /** Whether to enable debug logging */
  debug?: boolean;
}

/**
 * Validates MCP-specific parameter requirements
 */
function validateMcpRequiredParameters(
  commandId: string,
  args: Record<string, any>,
  mcpRequiredParams?: string[]
): void {
  if (!mcpRequiredParams || mcpRequiredParams.length === 0) {
    return;
  }

  const missingParams: string[] = [];
  
  for (const paramName of mcpRequiredParams) {
    if (!args[paramName]) {
      missingParams.push(paramName);
    }
  }

  if (missingParams.length > 0) {
    throw new Error(
      `MCP Context Error: Command "${commandId}" requires the following parameters in MCP context: ${missingParams.join(", ")}. ` +
      "These parameters are optional in CLI context but required for MCP since there's no meaningful \"current directory\" for MCP services."
    );
  }
}

/**
 * Register shared commands with MCP using the bridge
 */
export function registerSharedCommandsWithMcp(
  commandMapper: CommandMapper,
  config: McpSharedCommandConfig
): void {
  log.debug("Registering shared commands with MCP", {
    categories: config.categories,
    overrides: config.commandOverrides ? Object.keys(config.commandOverrides) : [],
  });

  // Register commands for each category
  config.categories.forEach((category) => {
    const commands = sharedCommandRegistry.getCommandsByCategory(category);

    commands.forEach((command) => {
      const overrides = config.commandOverrides?.[command.id];

      // Skip hidden commands
      if (overrides?.hidden) {
        return;
      }

      const description = overrides?.description || command.description;

      log.debug(`Registering command ${command.id} with MCP`, {
        category,
        description,
        mcpRequiredParams: overrides?.mcpRequiredParams,
      });

      // Register command with MCP using the command mapper
      // Convert shared command parameters to MCP-compatible format
      commandMapper.addCommand({
        name: command.id,
        description,
        parameters: convertParametersToZodSchema(command.parameters),
        handler: async (args: any, projectContext?: any) => {
          // Validate MCP-specific required parameters
          validateMcpRequiredParameters(command.id, args, overrides?.mcpRequiredParams);

          // Create execution context for shared command
          const context: CommandExecutionContext = {
            interface: "mcp",
            debug: args?.debug || false,
            format: "json", // MCP always returns JSON format
          };

          // Convert MCP args to expected parameter format, filtering out the json parameter
          // since MCP always returns JSON regardless of this parameter
          const filteredArgs = { ...args };
          delete filteredArgs.json; // Remove json parameter as it's not needed in MCP context

          const parameters = convertMcpArgsToParameters(filteredArgs, command.parameters);

          // Execute the shared command
          return await command.execute(parameters, context);
        },
      });
    });
  });

  log.debug("Shared command registration complete", {
    categories: config.categories,
  });
}

/**
 * Register task commands with MCP
 */
export function registerTaskCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.TASKS],
    ...config,
  });
}

/**
 * Register git commands with MCP
 */
export function registerGitCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.GIT],
    ...config,
  });
}

/**
 * Register session commands with MCP
 */
export function registerSessionCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.SESSION],
    ...config,
  });
}

/**
 * Register rules commands with MCP
 */
export function registerRulesCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.RULES],
    ...config,
  });
}

/**
 * Register config commands with MCP
 */
export function registerConfigCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.CONFIG],
    ...config,
  });
}

/**
 * Register init commands with MCP
 */
export function registerInitCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.INIT],
    ...config,
  });
}

/**
 * Register debug commands with MCP
 */
export function registerDebugCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.DEBUG],
    ...config,
  });
}

/**
 * Register all main command categories with MCP
 */
export function registerAllMainCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [
      CommandCategory.TASKS,
      CommandCategory.GIT,
      CommandCategory.SESSION,
      CommandCategory.RULES,
      CommandCategory.CONFIG,
      CommandCategory.INIT,
      CommandCategory.DEBUG,
    ],
    ...config,
  });
}
