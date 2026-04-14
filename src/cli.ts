#!/usr/bin/env bun

// CRITICAL: Import and setup config FIRST before any other imports that might use configuration
// This ensures the custom configuration system is initialized before any code tries to access it
import { setupConfiguration } from "./config-setup";

// Wait for configuration to be initialized before proceeding with other imports
await setupConfiguration();

import { Command } from "commander";
import { log } from "./utils/logger";
import { exit } from "./utils/process";
import { setupCommonCommandCustomizations, cliFactory } from "./adapters/cli/cli-command-factory";
import { validateError } from "./schemas/error";

/**
 * Root CLI command
 */
export const cli = new Command("minsky")
  .description("Minsky development workflow tool")
  .version("1.0.0")
  .option("--non-interactive", "Disable interactive prompts, error on missing required parameters")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.nonInteractive) {
      process.env.MINSKY_NON_INTERACTIVE = "1";
    }
  });

/**
 * Lazy PersistenceService initialization.
 * Deferred from startup to first command execution so the CLI bootstrap
 * (Commander parsing, help display) doesn't pay the DB connection cost.
 */
let persistenceInitialized = false;
async function ensurePersistence(): Promise<void> {
  if (persistenceInitialized) return;
  const { PersistenceService } = await import("./domain/persistence/service");
  await PersistenceService.initialize();
  log.debug("PersistenceService initialized (lazy, on first command)");
  persistenceInitialized = true;
}

/**
 * Create the CLI command structure
 */
export async function createCli(): Promise<Command> {
  // Setup common command customizations with the CLI instance
  setupCommonCommandCustomizations(cli);

  // Initialize persistence lazily via preAction hook — only when a command
  // actually executes, not during registration or help display. Session commands
  // use LazySessionDeps to defer provider resolution to execution time.
  cli.hook("preAction", async () => {
    await ensurePersistence();
  });

  // Register shared commands (session, tasks, git, rules, config, etc.)
  const { registerAllSharedCommands } = await import("./adapters/shared/commands/index");
  await registerAllSharedCommands();

  // Register all commands via CLI command factory (which applies customizations)
  cliFactory.registerAllCommands(cli);

  // Non-shared commands (context, mcp, github, lint) pull in expensive dependencies
  // (~700ms total: AI tokenizer, MCP SDK, etc.). Only load when actually invoked
  // or when full help is requested.
  const requestedCommand = process.argv[2];
  const needsAll =
    !requestedCommand ||
    requestedCommand === "--help" ||
    requestedCommand === "-h" ||
    requestedCommand === "help" ||
    requestedCommand === "--version" ||
    requestedCommand === "-V";

  if (needsAll || requestedCommand === "mcp") {
    const { createMCPCommand } = await import("./commands/mcp/index");
    cli.addCommand(await createMCPCommand());
  }
  if (needsAll || requestedCommand === "github") {
    const { createGitHubCommand } = await import("./commands/github/index");
    cli.addCommand(createGitHubCommand());
  }
  if (needsAll || requestedCommand === "context") {
    const { createContextCommand } = await import("./commands/context/index");
    cli.addCommand(createContextCommand());
  }
  if (needsAll || requestedCommand === "lint") {
    const { createLintCommand } = await import("./commands/lint/index");
    cli.addCommand(createLintCommand());
  }

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
  // Create CLI — persistence is initialized lazily via preAction hook
  const cliInstance = await createCli();
  await cliInstance.parseAsync();

  // Clean up PersistenceService on exit (only if it was initialized)
  if (persistenceInitialized) {
    const { PersistenceService } = await import("./domain/persistence/service");
    await PersistenceService.close();
  }

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
