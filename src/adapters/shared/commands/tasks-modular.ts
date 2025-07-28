/**
 * Modular Tasks Commands
 *
 * Lightweight replacement for the original tasks commands using the Command Pattern.
 * This reduces duplication and improves maintainability by creating commands on-demand.
 */
import { sharedCommandRegistry } from "../command-registry";
import { CommandCategory } from "../command-registry";
import { log } from "../../../utils/logger";

/**
 * Modular Tasks Command Manager
 *
 * Manages task commands using the Command Pattern with lazy loading.
 * Commands are created on-demand to avoid circular dependencies.
 */
export class ModularTasksCommandManager {
  /**
   * Register all task commands in the shared command registry
   */
  registerAllCommands(): void {
    // Register a basic tasks command using require to avoid circular dependencies
    try {
      const { createTasksListCommand } = require("./tasks/crud-commands");
      const { createTasksGetCommand } = require("./tasks/crud-commands");
      const { createTasksCreateCommand } = require("./tasks/crud-commands");
      const { createTasksDeleteCommand } = require("./tasks/crud-commands");
      const { createTasksSpecCommand } = require("./tasks/spec-command");
      const { createTasksStatusGetCommand } = require("./tasks/status-commands");
      const { createTasksStatusSetCommand } = require("./tasks/status-commands");

      // Create command instances to get their parameter definitions
      const listCommand = createTasksListCommand();
      const getCommand = createTasksGetCommand();
      const createCommand = createTasksCreateCommand();
      const deleteCommand = createTasksDeleteCommand();
      const specCommand = createTasksSpecCommand();
      const statusGetCommand = createTasksStatusGetCommand();
      const statusSetCommand = createTasksStatusSetCommand();

      // Register list command
      sharedCommandRegistry.registerCommand({
        id: "tasks.list",
        category: CommandCategory.TASKS,
        name: "list",
        description: "List tasks",
        parameters: listCommand.parameters,
        execute: async (params: any, context: any) => {
          return await listCommand.execute(params, context);
        },
      });

      // Register get command
      sharedCommandRegistry.registerCommand({
        id: "tasks.get",
        category: CommandCategory.TASKS,
        name: "get",
        description: "Get task details",
        parameters: getCommand.parameters,
        execute: async (params: any, context: any) => {
          return await getCommand.execute(params, context);
        },
      });

      // Register create command
      sharedCommandRegistry.registerCommand({
        id: "tasks.create",
        category: CommandCategory.TASKS,
        name: "create",
        description: "Create a new task",
        parameters: createCommand.parameters,
        execute: async (params: any, context: any) => {
          return await createCommand.execute(params, context);
        },
      });

      // Register delete command
      sharedCommandRegistry.registerCommand({
        id: "tasks.delete",
        category: CommandCategory.TASKS,
        name: "delete",
        description: "Delete a task",
        parameters: deleteCommand.parameters,
        execute: async (params: any, context: any) => {
          return await deleteCommand.execute(params, context);
        },
      });

      // Register spec command
      sharedCommandRegistry.registerCommand({
        id: "tasks.spec",
        category: CommandCategory.TASKS,
        name: "spec",
        description: "Get task specification content",
        parameters: specCommand.parameters,
        execute: async (params: any, context: any) => {
          return await specCommand.execute(params, context);
        },
      });

      // Register status get command
      sharedCommandRegistry.registerCommand({
        id: "tasks.status.get",
        category: CommandCategory.TASKS,
        name: "get",
        description: "Get the status of a task",
        parameters: statusGetCommand.parameters,
        execute: async (params: any, context: any) => {
          return await statusGetCommand.execute(params, context);
        },
      });

      // Register status set command
      sharedCommandRegistry.registerCommand({
        id: "tasks.status.set",
        category: CommandCategory.TASKS,
        name: "set",
        description: "Set the status of a task",
        parameters: statusSetCommand.parameters,
        execute: async (params: any, context: any) => {
          return await statusSetCommand.execute(params, context);
        },
      });
    } catch (error) {
      console.warn("Failed to register task commands:", error);
    }
  }

  /**
   * Get a specific task command by ID
   */
  getCommand(commandId: string) {
    // This method is no longer needed as commands are created on-demand
    // and not stored in a registry.
    // For now, return null or throw an error if commandId is not found.
    // In a real scenario, you might need a more sophisticated command lookup.
    console.warn("getCommand is deprecated. Commands are created on-demand.");
    return null;
  }

  /**
   * Get all registered task commands
   */
  getAllCommands() {
    // This method is no longer needed as commands are created on-demand
    // and not stored in a registry.
    // For now, return an empty array.
    console.warn("getAllCommands is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Get all task command registrations for the shared registry
   */
  getAllRegistrations() {
    // This method is no longer needed as commands are created on-demand
    // and not stored in a registry.
    // For now, return an empty array.
    console.warn("getAllRegistrations is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Execute a task command by ID with the given parameters
   */
  async executeCommand(commandId: string, params: any, context: any) {
    // This method is no longer needed as commands are created on-demand
    // and not stored in a registry.
    // For now, throw an error.
    console.warn("executeCommand is deprecated. Commands are created on-demand.");
    throw new Error(`Task command not found: ${commandId}`);
  }

  /**
   * Reset and re-register all commands (useful for testing)
   */
  resetCommands(): void {
    // This method is no longer needed as commands are created on-demand
    // and not stored in a registry.
    console.warn("resetCommands is deprecated. Commands are created on-demand.");
  }
}

/**
 * Default modular tasks command manager instance
 */
export const modularTasksManager = new ModularTasksCommandManager();

/**
 * Register task commands function for backward compatibility
 */
export function registerTasksCommands(): void {
  modularTasksManager.registerAllCommands();
}

/**
 * Factory function for creating a new ModularTasksCommandManager
 */
export function createModularTasksManager(): ModularTasksCommandManager {
  return new ModularTasksCommandManager();
}
