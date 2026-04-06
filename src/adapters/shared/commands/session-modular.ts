/**
 * Modular Session Commands
 *
 * Lightweight orchestration layer that coordinates the extracted session command components.
 * This provides the registration function using the new modular architecture.
 */
import { setupSessionCommandRegistry, type SessionCommandDependencies } from "./session/";
import { sharedCommandRegistry, type CommandDefinition } from "../command-registry";

/**
 * Register all session commands in the shared command registry.
 */
export async function registerSessionCommands(deps?: SessionCommandDependencies): Promise<void> {
  const registry = await setupSessionCommandRegistry(deps);
  for (const { registrationData } of registry.getAllCommands()) {
    // eslint-disable-next-line custom/no-excessive-as-unknown -- registrationData shape matches CommandDefinition
    sharedCommandRegistry.registerCommand(registrationData as unknown as CommandDefinition);
  }
}

// Export all command components for direct access
export * from "./session/";
