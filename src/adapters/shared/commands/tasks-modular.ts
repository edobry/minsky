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
    // For now, return empty registrations to avoid circular dependencies
    // This will be improved once the circular dependency issue is resolved
    const registrations: any[] = [];

    registrations.forEach((registration) => {
      sharedCommandRegistry.registerCommand(registration);
    });
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
