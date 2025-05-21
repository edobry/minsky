/**
 * Shared Commands Index
 * 
 * Exports all command registration functions.
 * This file serves as the central point for registering all shared commands.
 */

import { registerGitCommands } from "./git.js";

/**
 * Register all shared commands in the shared command registry
 */
export function registerAllSharedCommands(): void {
  // Register git commands
  registerGitCommands();
  
  // Additional command categories can be registered here as they're implemented
  // For example:
  // registerTaskCommands();
  // registerSessionCommands();
  // registerRuleCommands();
}

// Export individual command registration functions to allow
// per-category registration when needed
export { registerGitCommands }; 
