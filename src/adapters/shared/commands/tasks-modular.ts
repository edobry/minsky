/**
 * Modular Tasks Command Manager
 *
 * Provides a clean interface for task command operations using the new modular architecture.
 * This replaces the monolithic tasks.ts command handlers.
 */
import { sharedCommandRegistry } from "../command-registry";
import { TaskCommandRegistry } from "./tasks/base-task-command";

/**
 * ModularTasksCommandManager Class
 *
 * Manages all task-related commands using the new modular architecture.
 * Provides registration, execution, and management capabilities.
 */
export class ModularTasksCommandManager {
  private taskRegistry: TaskCommandRegistry;

  constructor() {
    // Create a simple new registry for now to avoid circular dependencies
    this.taskRegistry = new TaskCommandRegistry();
  }

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
        category: "TASKS" as any,
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
        category: "TASKS" as any,
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
        category: "TASKS" as any,
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
        category: "TASKS" as any,
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
        category: "TASKS" as any,
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
        category: "TASKS" as any,
        name: "status get",
        description: "Get the status of a task",
        parameters: statusGetCommand.parameters,
        execute: async (params: any, context: any) => {
          return await statusGetCommand.execute(params, context);
        },
      });

      // Register status set command
      sharedCommandRegistry.registerCommand({
        id: "tasks.status.set",
        category: "TASKS" as any,
        name: "status set",
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
    return this.taskRegistry.get(commandId);
  }

  /**
   * Get all registered task commands
   */
  getAllCommands() {
    return this.taskRegistry.getAll();
  }

  /**
   * Get all task command registrations for the shared registry
   */
  getAllRegistrations() {
    return this.taskRegistry.getAllRegistrations();
  }

  /**
   * Execute a task command by ID with the given parameters
   */
  async executeCommand(commandId: string, params: any, context: any) {
    const command = this.getCommand(commandId);
    if (!command) {
      throw new Error(`Task command not found: ${commandId}`);
    }

    return await command.execute(params, context);
  }

  /**
   * Reset and re-register all commands (useful for testing)
   */
  resetCommands(): void {
    this.taskRegistry.clear();
    // For now, just create a new empty registry
    this.taskRegistry = new TaskCommandRegistry();
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
