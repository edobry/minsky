#!/usr/bin/env bun

// Set NODE_CONFIG_DIR to point to user config directory before any imports
// This must be done before any module imports that might load node-config
import { homedir } from "os";
import { join } from "path";
const userConfigDir = join(homedir(), ".config", "minsky");
const processEnv = validateProcess(process);
processEnv.env.NODE_CONFIG_DIR = userConfigDir;

import { Command } from "commander";
import { log } from "./utils/logger.js";
import { exit } from "./utils/process.js";
import { registerAllSharedCommands } from "./adapters/shared/commands/index.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import {
  setupCommonCommandCustomizations,
  registerAllCommands,
} from "./adapters/cli/cli-command-factory.js";
import { validateProcess } from "./schemas/runtime.js";
import { validateError, getErrorMessage, getErrorStack } from "./schemas/error.js";

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
  await createCli();
  await cli.parseAsync();
}

// Run the CLI
main().catch((err) => {
  const validatedError = validateError(err);
  log.systemDebug(`Error caught in main: ${err}`);
  log.systemDebug(`Error stack: ${validatedError.stack || "No stack available"}`);
  log.error(`Unhandled error in CLI: ${validatedError.message}`);
  if (validatedError.stack) log.debug(validatedError.stack);
  exit(1);
});

export default cli;
