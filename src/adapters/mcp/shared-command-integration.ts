/**
 * Shared Command Integration for MCP
 *
 * This module provides utilities for automatically registering shared commands
 * with the MCP command mapper, eliminating the need for manual command duplication.
 */

import type { CommandMapper } from "../../mcp/command-mapper";
import { sharedCommandRegistry, CommandCategory } from "../shared/command-registry";
import { log } from "../../utils/logger";

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
      // The exact method depends on the CommandMapper interface
      // This is a simplified version - the actual implementation may need
      // to handle parameter schema conversion from Zod to MCP format
      commandMapper.addCommand({
        name: command.id,
        description,
        parameters: command.parameters,
        execute: command.execute,
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
