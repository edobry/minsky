/**
 * Modular Tasks Commands
 *
 * Lightweight orchestration layer that coordinates the extracted task command components.
 * This replaces the monolithic tasks.ts with a modular, command-pattern architecture.
 */
import { sharedCommandRegistry } from "../command-registry";
import {
  createAllTaskCommands,
  setupTaskCommandRegistry,
  type TaskCommandRegistry,
} from "./tasks";

/**
 * Modular Tasks Command Manager
 *
 * Manages task commands using the Command Pattern with dependency injection.
 * Provides a clean interface for registering and managing task commands.
 */
export class ModularTasksCommandManager {
  private taskRegistry: TaskCommandRegistry;

  constructor() {
    this.taskRegistry = setupTaskCommandRegistry();
  }

  /**
   * Register all task commands in the shared command registry
   */
  registerAllCommands(): void {
    const registrations = this.taskRegistry.getAllRegistrations();
    
    registrations.forEach(registration => {
      sharedCommandRegistry.registerCommand(registration);
    });
  }

  /**
   * Get the task command registry
   */
  getTaskRegistry(): TaskCommandRegistry {
    return this.taskRegistry;
  }

  /**
   * Get all command registrations
   */
  getAllRegistrations() {
    return this.taskRegistry.getAllRegistrations();
  }

  /**
   * Check if a command is registered
   */
  hasCommand(commandId: string): boolean {
    return !!this.taskRegistry.get(commandId);
  }

  /**
   * Get command IDs
   */
  getCommandIds(): string[] {
    return this.taskRegistry.getAll().map(cmd => cmd.id);
  }

  /**
   * Reset and re-register all commands (useful for testing)
   */
  resetCommands(): void {
    this.taskRegistry.clear();
    this.taskRegistry = setupTaskCommandRegistry();
  }
}

/**
 * Default modular tasks command manager instance
 */
export const modularTasksManager = new ModularTasksCommandManager();

/**
 * Register task commands function (backward compatibility)
 * 
 * This function maintains compatibility with the original registerTasksCommands()
 * while using the new modular architecture underneath.
 */
export function registerTasksCommands(): void {
  modularTasksManager.registerAllCommands();
}

/**
 * Factory function to create a tasks command manager
 */
export function createModularTasksManager(): ModularTasksCommandManager {
  return new ModularTasksCommandManager();
}

// Export all task command components for direct access
export * from "./tasks";

// Re-export for migration path
export { ModularTasksCommandManager as TasksCommandManager };
export { modularTasksManager as tasksManager };