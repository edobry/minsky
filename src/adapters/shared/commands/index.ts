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

/**
 * Register all shared commands in the shared command registry
 */
export function registerAllSharedCommands(): void {
  // Register git commands
  registerGitCommands();

  // Register tasks commands
  registerTasksCommands();

  // Register session commands
  registerSessionCommands();

  // Register rules commands
  registerRulesCommands();

  // Register init commands
  registerInitCommands();

  // Register config commands
  registerConfigCommands();

  // Register debug commands
  registerDebugCommands();

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
};
