/**
 * Shared Commands Index
 *
 * Exports all command registration functions.
 * This file serves as the central point for registering all shared commands.
 */

import type { AppContainerInterface } from "../../../composition/types";
import { registerGitCommands } from "./git";
import { registerTasksCommands } from "./tasks";
import { registerSessionCommands } from "./session";
import { registerRulesCommands } from "./rules";
import { registerInitCommands } from "./init";
import { registerConfigCommands } from "./config";
import { registerDebugCommands } from "./debug";
import { registerPersistenceCommands } from "./persistence";
import { registerAiCommands } from "./ai";
import { registerToolsCommands } from "./tools";
import { registerChangesetCommands } from "./changeset";
import { registerValidateCommands } from "./validate";

/**
 * Register all shared commands in the shared command registry.
 * @param container Optional DI container — when provided, command groups can
 *   resolve services from it instead of reaching into singletons.
 */
export async function registerAllSharedCommands(container?: AppContainerInterface): Promise<void> {
  // Register git commands
  registerGitCommands();

  // Register tasks commands
  registerTasksCommands();

  // Register session commands (async) — pass container for DI migration (mt#761)
  await registerSessionCommands(undefined, container);

  // Register rules commands
  registerRulesCommands();

  // Register init commands
  registerInitCommands();

  // Register config commands
  registerConfigCommands();

  // Register debug commands
  registerDebugCommands();

  // Register persistence commands
  registerPersistenceCommands();

  // Register AI commands
  registerAiCommands();

  // Register tools commands
  registerToolsCommands();

  // Register changeset commands
  registerChangesetCommands();

  // Register validate commands (lint and typecheck)
  registerValidateCommands();

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
  registerPersistenceCommands,
  registerAiCommands,
  registerToolsCommands,
  registerChangesetCommands,
  registerValidateCommands,
};
