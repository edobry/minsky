/**
 * Modular Session Commands
 *
 * Lightweight orchestration layer that coordinates the extracted session command components.
 * This provides the registration function using the new modular architecture.
 */
import {
  createAllSessionCommands,
  setupSessionCommandRegistry,
  type SessionCommandDependencies,
  type SessionCommandRegistry,
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
  private commands: ReturnType<typeof createAllSessionCommands>;
  private commandRegistry: SessionCommandRegistry;

  constructor(deps: SessionCommandDependencies = defaultSessionCommandDependencies) {
    this.commands = createAllSessionCommands(deps);
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
