#!/usr/bin/env bun
/* eslint-disable no-restricted-imports */
import { Command } from "commander";
import { log } from "./utils/logger.js";
import { registerAllSharedCommands } from "./adapters/shared/commands/index.js";
import { cliBridge } from "./adapters/shared/bridges/cli-bridge.js";
import { CommandCategory } from "./adapters/shared/command-registry.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import { setupCommonCommandCustomizations } from "./adapters/cli/cli-command-factory.js";

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

  // Register all shared commands
  registerAllSharedCommands();

  // Add top-level commands via CLI bridge
  const tasksCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.TASKS);
  if (tasksCategoryCommand) cli.addCommand(tasksCategoryCommand);

  const gitCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.GIT);
  if (gitCategoryCommand) cli.addCommand(gitCategoryCommand);

  const sessionCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.SESSION);
  if (sessionCategoryCommand) cli.addCommand(sessionCategoryCommand);

  const rulesCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.RULES);
  if (rulesCategoryCommand) cli.addCommand(rulesCategoryCommand);

  const initCategoryCommand = cliBridge.generateCategoryCommand(CommandCategory.INIT);
  if (initCategoryCommand) cli.addCommand(initCategoryCommand);

  // Add MCP command (this is not yet migrated to shared commands)
  cli.addCommand(await createMCPCommand());

  // Set error handler
  cli.configureOutput({
    outputError: (str, write) => write(str),
  });

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
