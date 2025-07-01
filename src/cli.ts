#!/usr/bin/env bun

console.log("DEBUG: CLI module loading");
import { Command } from "commander";
import { log } from "./utils/logger.js";
import { exit } from "./utils/process.js";
import { registerAllSharedCommands } from "./adapters/shared/commands/index.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import {
  setupCommonCommandCustomizations,
  registerAllCommands,
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

  // Register all shared commands
  registerAllSharedCommands();

  // Register all commands via CLI command factory (which applies customizations)
  registerAllCommands(cli);

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
  console.log("DEBUG: main() called");
  console.log("DEBUG: Bun.argv:", Bun.argv);
  await createCli();
  console.log("DEBUG: createCli() completed");
  console.log("DEBUG: About to call parseAsync");
  await cli.parseAsync(Bun.argv);
  console.log("DEBUG: parseAsync completed");
}

// Run the CLI
main().catch((err) => {
  log.systemDebug(`Error caught in main: ${err}`);
  log.systemDebug(`Error stack: ${err.stack}`);
  log.error(`Unhandled error in CLI: ${err.message}`);
  if (err.stack) log.debug(err.stack);
  exit(1);
});

export default cli;
