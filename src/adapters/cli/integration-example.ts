/**
 * Shared Command Integration Example
 *
 * This file demonstrates how to integrate the shared command system
 * with the CLI adapter. It can be used as a reference for future
 * migration of other commands.
 */

import { Command } from "commander";
import { registerGitCommands } from "../shared/commands/git";
import { registerTasksCommands } from "../shared/commands/tasks";
import { registerSessionCommands } from "../shared/commands/session";
import { registerRulesCommands } from "../shared/commands/rules";
import { registerCategorizedCliCommands } from "../shared/bridges/cli-bridge";
import { CommandCategory } from "../shared/command-registry";
import { log } from "../../utils/logger";

/**
 * Demonstrates the integration of shared commands with Commander.js
 *
 * This is an example of how the Minsky CLI could be updated
 * to use the shared command registry.
 *
 * @returns A configured Commander.js program
 */
export function createIntegratedCliProgram(): Command {
  log.debug("Creating integrated CLI program");

  // Create the root program
  const program = new Command()
    .name("minsky")
    .description("Minsky CLI - Task-based workspace management").version("1.0.0");

  // Register shared commands in the registry
  registerGitCommands();
  registerTasksCommands();
  registerSessionCommands();
  registerRulesCommands();

  // Bridge the commands to CLI
  registerCategorizedCliCommands(program,
    [CommandCategory.GIT, CommandCategory.TASKS, CommandCategory.SESSION, CommandCategory.RULES],
    true // Create subcommands for categories
  );

  return program;
}

// Example function removed as it was unused

// Export the CLI program creation function for use in tests
export default createIntegratedCliProgram;
