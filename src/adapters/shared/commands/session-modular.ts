/**
 * Modular Session Commands
 *
 * Lightweight orchestration layer that coordinates the extracted session command components.
 * This provides the registration function using the new modular architecture.
 */
import { SessionCommandRegistry } from "./session/base-session-command";
import {
  setupSessionCommandRegistry,
  type SessionCommandDependencies,
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionApproveCommand,
  createSessionPrCommand,
  createSessionInspectCommand,
} from "./session";
import { sharedCommandRegistry } from "../command-registry";

/**
 * Default dependencies for session commands
 */
const defaultSessionCommandDependencies: SessionCommandDependencies = {
  // Dependencies will be injected as needed
};

/**
 * Modular Session Commands Manager
 *
 * Manages session commands using the Command Pattern with dependency injection.
 * Provides a clean interface for registering and managing session commands.
 */
export class ModularSessionCommandsManager {
  private commands: any; // Session commands collection
  private commandRegistry: SessionCommandRegistry;

  constructor(deps: SessionCommandDependencies = defaultSessionCommandDependencies) {
    // Create all session commands directly to avoid circular dependency
    this.commands = {
      list: createSessionListCommand(deps),
      get: createSessionGetCommand(deps),
      start: createSessionStartCommand(deps),
      dir: createSessionDirCommand(deps),
      delete: createSessionDeleteCommand(deps),
      update: createSessionUpdateCommand(deps),
      approve: createSessionApproveCommand(deps),
      pr: createSessionPrCommand(deps),
      inspect: createSessionInspectCommand(deps),
    };

    // Setup the command registry with actual session commands
    this.commandRegistry = setupSessionCommandRegistry(deps);
  }

  /**
   * Register all session commands in the shared command registry
   */
  registerSessionCommands(): void {
    // Get all commands from the registry
    const allCommands = this.commandRegistry.getAllCommands();

    // Register each command in the shared registry
    allCommands.forEach(({ id, registrationData }) => {
      sharedCommandRegistry.registerCommand(registrationData);
    });
  }

  /**
   * Get the command registry
   */
  getCommandRegistry(): SessionCommandRegistry {
    return this.commandRegistry;
  }

  /**
   * Get direct access to commands (for advanced usage)
   */
  getCommands() {
    return this.commands;
  }

  /**
   * Get available command IDs
   */
  getCommandIds(): string[] {
    return this.commandRegistry.getCommandIds();
  }
}

/**
 * Default modular session commands manager instance
 */
export const modularSessionCommandsManager = new ModularSessionCommandsManager();

/**
 * Factory function to create a session commands manager with custom dependencies
 */
export function createModularSessionCommandsManager(
  deps?: SessionCommandDependencies
): ModularSessionCommandsManager {
  return new ModularSessionCommandsManager(deps);
}

/**
 * Register session commands using the modular architecture (backward compatibility)
 */
export function registerSessionCommands(deps?: SessionCommandDependencies): void {
  const manager = deps ? createModularSessionCommandsManager(deps) : modularSessionCommandsManager;
  manager.registerSessionCommands();
}

// Export all command components for direct access
export * from "./session";

// Export for migration path
export { ModularSessionCommandsManager as SessionCommandsManager };
export { modularSessionCommandsManager as sessionCommandsManager };
