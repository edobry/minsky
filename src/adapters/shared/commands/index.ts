/**
 * Shared Commands Index
 *
 * Exports all command registration functions.
 * This file serves as the central point for registering all shared commands.
 */

import { registerGitCommands } from "./git";
import { registerTasksCommands } from "./tasks";
import { registerInitCommands } from "./init";
import { registerConfigCommands } from "./config";
import { registerDebugCommands } from "./debug";
import { persistenceCommands } from "./persistence/index";
import { sharedCommandRegistry } from "../command-registry";
import { registerAiCommands } from "./ai";
import { registerChangesetCommands } from "./changeset";

// Import DatabaseCommand pattern commands
import { allSessionCommands } from "./session/index";
import { rulesCommands } from "./rules";
import { toolsCommands } from "./tools";

/**
 * Register all shared commands in the shared command registry
 */
export async function registerAllSharedCommands(): Promise<void> {
  // Register git commands
  registerGitCommands();

  // Register tasks commands
  registerTasksCommands();

  // Register session commands (async) - DISABLED: Using migrated DatabaseCommand versions
  // await registerSessionCommands();

  // Register rules commands - DISABLED: Using migrated DatabaseCommand versions
  // registerRulesCommands();

  // Register init commands
  registerInitCommands();

  // Register config commands
  registerConfigCommands();

  // Register debug commands
  registerDebugCommands();

  // Register persistence commands - MIGRATED to DatabaseCommand pattern
  persistenceCommands.forEach((command) => {
    sharedCommandRegistry.registerCommand({
      id: command.id,
      category: command.category,
      name: command.name,
      description: command.description,
      parameters: command.parameters,
      execute: (params, context) => command.execute(params, context as any),
    });
  });

  // Register ALL session commands - DatabaseCommand pattern (20 commands total)
  allSessionCommands.forEach((command) => {
    sharedCommandRegistry.registerCommand({
      id: command.id,
      category: command.category,
      name: command.name,
      description: command.description,
      parameters: command.parameters,
      execute: (params, context) => command.execute(params, context as any),
    });
  });

  // Register rules commands - DatabaseCommand pattern
  rulesCommands.forEach((command) => {
    sharedCommandRegistry.registerCommand({
      id: command.id,
      category: command.category,
      name: command.name,
      description: command.description,
      parameters: command.parameters,
      execute: (params, context) => command.execute(params, context as any),
    });
  });

  // Register tools commands - DatabaseCommand pattern
  toolsCommands.forEach((command) => {
    sharedCommandRegistry.registerCommand({
      id: command.id,
      category: command.category,
      name: command.name,
      description: command.description,
      parameters: command.parameters,
      execute: (params, context) => command.execute(params, context as any),
    });
  });

  // Register AI commands
  registerAiCommands();

  // Register tools commands - DISABLED: Using migrated DatabaseCommand versions
  // registerToolsCommands();

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
  registerPersistenceCommands,
  registerAiCommands,
  registerToolsCommands,
  registerChangesetCommands,
};
