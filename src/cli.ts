#!/usr/bin/env bun
/* eslint-disable no-restricted-imports */
import { Command } from "commander";
import { createSessionCommand } from "./adapters/cli/session.js";
import { createTasksCommand } from "./adapters/cli/tasks.js";
import { createGitCommand } from "./adapters/cli/git.js";
import { createInitCommand } from "./adapters/cli/init.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import { createRulesCommand } from "./adapters/cli/rules.js";
import { log } from "./utils/logger.js";
import { registerGitCommands } from "./adapters/shared/commands/git.js";
import { cliBridge } from "./adapters/shared/bridges/cli-bridge.js";
import { CommandCategory } from "./adapters/shared/command-registry.js";
import {
  customizeCommand,
  createCommand,
  setupCommonCommandCustomizations
} from "./adapters/cli/cli-command-factory.js";

/**
 * Root CLI command
 */
export const cli = new Command("minsky")
  .description("Minsky development workflow tool")
  .version("1.0.0");

/**
 * Create the CLI command structure
 */
export async function createCli(): Promise<Command> {
  // Setup common command customizations with the CLI instance
  setupCommonCommandCustomizations(cli);

  // Add top-level commands
  cli.addCommand(await createSessionCommand());
  cli.addCommand(await createTasksCommand());
  cli.addCommand(await createGitCommand());
  cli.addCommand(await createInitCommand());
  cli.addCommand(await createMCPCommand());
  cli.addCommand(await createRulesCommand());

  // Set error handler
  cli.configureOutput({
    outputError: (str, write) => write(str),
  });

  // Register shared git commands
  registerGitCommands();

  // Register git commands via CLI bridge
  const gitCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.GIT);
  if (gitCategoryCommand) cli.addCommand(gitCategoryCommand);

  // This allows this file to be imported without immediately running the CLI
  return cli;
}

/**
 * Main entry point when run from command line
 * This is only executed when this file is run directly
 */
async function main(): Promise<void> {
  await createCli();
  await cli.parseAsync(process.argv);
}

// Only run the CLI if this file is executed directly (not imported as a module)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error(`Unhandled error in CLI: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    process.exit(1);
  });
}

export default cli;
