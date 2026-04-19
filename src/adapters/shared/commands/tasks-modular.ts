/**
 * Modular Tasks Commands
 *
 * Registers task commands in the shared command registry for MCP exposure.
 * Uses createAllTaskCommands() from registry-setup as the single source of truth,
 * eliminating dual-registration bugs where a command is added to CLI but not MCP.
 */
import { sharedCommandRegistry } from "../command-registry";
import { CommandCategory } from "../command-registry";
import { log } from "../../../utils/logger";
import type { AppContainerInterface } from "../../../composition/types";
import { createAllTaskCommands } from "./tasks/registry-setup";

/**
 * Modular Tasks Command Manager
 *
 * Registers all task commands from the canonical createAllTaskCommands() source.
 * Adding a command to registry-setup.ts automatically makes it available via MCP.
 */
export class ModularTasksCommandManager {
  /**
   * Register all task commands in the shared command registry.
   *
   * Uses createAllTaskCommands() as the single source of truth.
   * Each command is wrapped with category: CommandCategory.TASKS
   * so the MCP bridge can discover it.
   */
  registerAllCommands(container?: AppContainerInterface): void {
    try {
      log.debug("[ModularTasksCommandManager] Auto-registering all task commands");

      const commands = createAllTaskCommands(container);

      for (const command of commands) {
        sharedCommandRegistry.registerCommand({
          id: command.id,
          category: CommandCategory.TASKS,
          name: command.name,
          description: command.description,
          parameters: command.parameters,
          execute: (params, ctx) => command.execute(params, ctx),
        });
      }

      log.debug(`[ModularTasksCommandManager] Registered ${commands.length} task commands`);
    } catch (error) {
      log.warn(
        `Failed to register task commands: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get a specific task command by ID
   */
  getCommand(commandId: string) {
    log.warn("getCommand is deprecated. Commands are created on-demand.");
    return null;
  }

  /**
   * Get all registered task commands
   */
  getAllCommands() {
    log.warn("getAllCommands is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Get all task command registrations for the shared registry
   */
  getAllRegistrations() {
    log.warn("getAllRegistrations is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Execute a task command by ID with the given parameters
   */
  async executeCommand(commandId: string, params: unknown, context: unknown) {
    log.warn("executeCommand is deprecated. Commands are created on-demand.");
    throw new Error(`Task command not found: ${commandId}`);
  }

  /**
   * Reset and re-register all commands (useful for testing)
   */
  resetCommands(): void {
    log.warn("resetCommands is deprecated. Commands are created on-demand.");
  }
}

/**
 * Default modular tasks command manager instance
 */
export const modularTasksManager = new ModularTasksCommandManager();

/**
 * Register task commands function for backward compatibility
 */
export function registerTasksCommands(container?: AppContainerInterface): void {
  modularTasksManager.registerAllCommands(container);
}

/**
 * Factory function for creating a new ModularTasksCommandManager
 */
export function createModularTasksManager(): ModularTasksCommandManager {
  return new ModularTasksCommandManager();
}
