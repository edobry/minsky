#!/usr/bin/env bun

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
  try {
    await createCli();
    // Use type assertion to access process.argv in Bun environment
    await cli.parseAsync((process as any).argv);
  } catch (error) {
    log.systemDebug(`Error caught in main: ${error}`);
    log.systemDebug(`Error stack: ${error instanceof Error ? error.stack : "No stack"}`);
    log.error(`Unhandled error in CLI: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) log.debug(error.stack);
    exit(1);
  }
}

// Check if this file is being run directly
// For Bun, we need to check if this is the main module
const isMainModule = import.meta.main === true;

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error in CLI main:", err);
    exit(1);
  });
}

export default cli;
