/**
 * Modular Session Commands
 *
 * Lightweight orchestration layer that coordinates the extracted session command components.
 * This provides the registration function using the new modular architecture.
 */
import { SessionCommandRegistry } from "./session/base-session-command";
import {
  createAllSessionCommands,
  setupSessionCommandRegistry,
  type SessionCommandDependencies,
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
  private commands: Awaited<ReturnType<typeof createAllSessionCommands>> | null = null;
  private commandRegistry: SessionCommandRegistry;
  private initialized = false;

  constructor(deps: SessionCommandDependencies = defaultSessionCommandDependencies) {
    // Create empty registry - will be populated during initialization
    this.commandRegistry = new SessionCommandRegistry();

    // Initialize asynchronously
    this.initialize(deps);
  }

  private async initialize(deps: SessionCommandDependencies): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize commands using the factory
      this.commands = await createAllSessionCommands(deps);

      // Setup the command registry with the commands
      this.commandRegistry = await setupSessionCommandRegistry(deps);

      this.initialized = true;
    } catch (error) {
      // Log error but don't throw to avoid breaking the constructor
      console.error("Failed to initialize session commands:", error);
    }
  }

  /**
   * Register all session commands in the shared command registry
   */
  async registerSessionCommands(): Promise<void> {
    // Wait for initialization to complete
    await this.waitForInitialization();

    // Get all commands from the registry
    const allCommands = this.commandRegistry.getAllCommands();

    // Register each command in the shared registry
    allCommands.forEach(({ id, registrationData }) => {
      sharedCommandRegistry.registerCommand(registrationData);
    });
  }

  /**
   * Wait for initialization to complete
   */
  private async waitForInitialization(): Promise<void> {
    // Simple polling approach - wait for initialization
    while (!this.initialized) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
export async function registerSessionCommands(deps?: SessionCommandDependencies): Promise<void> {
  const manager = deps ? createModularSessionCommandsManager(deps) : modularSessionCommandsManager;
  await manager.registerSessionCommands();
}

// Export all command components for direct access
export * from "./session";

// Export for migration path
export { ModularSessionCommandsManager as SessionCommandsManager };
export { modularSessionCommandsManager as sessionCommandsManager };
