/**
 * Session Command Registration
 *
 * Builds the session command registry from the modular command components
 * in ./session/ and registers them in the shared command registry.
 */
import { setupSessionCommandRegistry, type SessionCommandDependencies } from "./session/";
import { sharedCommandRegistry, type CommandDefinition } from "../command-registry";

/**
 * Register all session commands (including changeset aliases) in the shared command registry.
 */
export async function registerSessionCommands(deps?: SessionCommandDependencies): Promise<void> {
  const registry = await setupSessionCommandRegistry(deps);
  for (const { registrationData } of registry.getAllCommands()) {
    // eslint-disable-next-line custom/no-excessive-as-unknown -- registrationData shape matches CommandDefinition
    sharedCommandRegistry.registerCommand(registrationData as unknown as CommandDefinition);
  }

  // Register changeset aliases (session.changeset.* commands)
  const { registerSessionChangesetCommands } = await import("./session/changeset-aliases");
  registerSessionChangesetCommands();
}
