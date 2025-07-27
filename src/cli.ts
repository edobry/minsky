#!/usr/bin/env bun

// CRITICAL: Import and setup config FIRST before any other imports that might use configuration
// This ensures the custom configuration system is initialized before any code tries to access it
import { setupConfiguration } from "./config-setup";

// Wait for configuration to be initialized before proceeding with other imports
await setupConfiguration();

import { Command } from "commander";
import { log } from "./utils/logger";
import { exit } from "./utils/process";
import { registerAllSharedCommands } from "./adapters/shared/commands/index";
import { createMCPCommand } from "./commands/mcp/index";
import {
  setupCommonCommandCustomizations,
  registerAllCommands,
} from "./adapters/cli/cli-command-factory";
import { validateProcess } from "./schemas/runtime";
import { validateError, getErrorMessage, getErrorStack } from "./schemas/error";

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

  // Still need explicit exit until all resource leaks are fixed
  // The improvements to workspace manager help, but there are other sources
  exit(0);
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
