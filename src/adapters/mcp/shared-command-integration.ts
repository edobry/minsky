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
  type CommandParameterDefinition,
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
      spec?: string;
      /** Hide command from MCP */
      hidden?: boolean;
    }
  >;
  /** Whether to enable debug logging */
  debug?: boolean;
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
      });

      // Register command with MCP using the command mapper
      // Convert shared command parameters to MCP-compatible format
      commandMapper.addCommand({
        name: command.id,
        description,
        parameters: convertParametersToZodSchema(command.parameters),
        handler: async (args: any, projectContext?: any) => {
          const startTime = Date.now();
          log.debug(`[MCP] Starting command execution: ${command.id}`, { args });

          try {
            // Create execution context for shared command
            const context: CommandExecutionContext = {
              interface: "mcp",
              debug: args?.debug || false,
              format: args?.json === "true" ? "json" : "text", // Use json format only when explicitly requested
            };
            log.debug(`[MCP] Created execution context: ${command.id}`, { context });

            // Convert MCP args to expected parameter format
            const filteredArgs = { ...args };
            log.debug(`[MCP] Processing args: ${command.id}`, { filteredArgs });

            const parameters = convertMcpArgsToParameters(filteredArgs, command.parameters);
            log.debug(`[MCP] Converted parameters: ${command.id}`, { parameters });

            // Execute the shared command (no timeout - debug actual hang)
            log.debug(`[MCP] About to execute command: ${command.id}`);
            log.debug(`[MCP] Parameters being passed:`, parameters);
            log.debug(`[MCP] Context being passed:`, context);

            const result = await command.execute(parameters, context);

            const duration = Date.now() - startTime;
            log.debug(`[MCP] Command completed: ${command.id}`, { duration });
            return result;
          } catch (error) {
            const duration = Date.now() - startTime;

            // CRITICAL: Check for undefined reference errors that could indicate missing imports
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isUndefinedReference =
              errorMessage.includes("is not defined") ||
              errorMessage.includes("undefined") ||
              errorMessage.includes("ReferenceError");

            if (isUndefinedReference) {
              log.error(`🚨 CRITICAL: Possible missing import detected in ${command.id}`, {
                error: errorMessage,
                duration,
                suggestion: "Check for missing imports in the command implementation",
              });
            }

            log.error(`[MCP] Command failed: ${command.id}`, {
              error: errorMessage,
              duration,
              isUndefinedReference,
            });
            throw error;
          }
        },
      });
    });
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
 * Register persistence commands with MCP
 */
export function registerPersistenceCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  registerSharedCommandsWithMcp(commandMapper, {
    categories: [CommandCategory.PERSISTENCE],
    ...config,
  });
}

/**
 * Register sessiondb commands with MCP (legacy compatibility)
 */
export function registerSessiondbCommandsWithMcp(
  commandMapper: CommandMapper,
  config: Omit<McpSharedCommandConfig, "categories"> = {}
): void {
  // Forward to persistence commands for backward compatibility
  registerPersistenceCommandsWithMcp(commandMapper, config);
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
      CommandCategory.PERSISTENCE,
    ],
    ...config,
  });
}
