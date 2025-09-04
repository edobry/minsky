/**
 * Shared Commands Index
 *
 * Exports all command registration functions.
 * This file serves as the central point for registering all shared commands.
 */

import { registerGitCommands } from "./git";
import { registerTasksCommands } from "./tasks";
import { registerSessionCommands } from "./session";
import { registerRulesCommands } from "./rules";
import { registerInitCommands } from "./init";
import { registerConfigCommands } from "./config";
import { registerDebugCommands } from "./debug";
import { registerSessiondbCommands } from "./sessiondb";
import { registerAiCommands } from "./ai";
import { registerToolsCommands } from "./tools";
import { registerChangesetCommands } from "./changeset";

/**
 * Register all shared commands in the shared command registry
 */
export async function registerAllSharedCommands(): Promise<void> {
  // Register git commands
  registerGitCommands();

  // Register tasks commands
  registerTasksCommands();

  // Register session commands (async)
  await registerSessionCommands();

  // Register rules commands
  registerRulesCommands();

  // Register init commands
  registerInitCommands();

  // Register config commands
  registerConfigCommands();

  // Register debug commands
  registerDebugCommands();

  // Register sessiondb commands
  registerSessiondbCommands();

  // Register AI commands
  registerAiCommands();

  // Register tools commands
  registerToolsCommands();

  // Register changeset commands
  registerChangesetCommands();

  // Additional command categories can be registered here as they're implemented
}

// Export individual command registration functions to allow
// per-category registration when needed
export {
  registerGitCommands,
  registerTasksCommands,
  registerSessionCommands,
  registerRulesCommands,
  registerInitCommands,
  registerConfigCommands,
  registerDebugCommands,
  registerSessiondbCommands,
  registerAiCommands,
  registerToolsCommands,
  registerChangesetCommands,
};
