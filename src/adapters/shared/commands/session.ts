/**
 * Shared Session Commands (Simple Direct Registration)
 *
 * This module provides a simple direct approach to registering session commands
 * in the shared command registry, avoiding the complex circular dependency issues.
 */

import type { SessionCommandDependencies } from "./session/index";
import { registerSessionCommands as registerModularSessionCommands } from "./session-modular";

/**
 * Register session commands directly in the shared command registry
 * This bypasses the complex modular architecture to solve the registration issue
 */
export async function registerSessionCommands(deps?: SessionCommandDependencies): Promise<void> {
  await registerModularSessionCommands(deps);

  // Register changeset aliases
  const { registerSessionChangesetCommands } = await import("./session/changeset-aliases");
  registerSessionChangesetCommands();
}
