#!/usr/bin/env bun
import "reflect-metadata";

// mt#1745: cold-start profiling. Loaded FIRST so the module-level timer
// baseline is set as early as possible — every other checkpoint's `t=` is
// relative to this point. No-op when MINSKY_MCP_PROFILE=1 is unset.
import { profileCheckpoint } from "./utils/cold-start-profile";
profileCheckpoint("cli_top");

// CRITICAL: Import and setup config FIRST before any other imports that might use configuration
// This ensures the custom configuration system is initialized before any code tries to access it
import { setupConfiguration } from "./config-setup";
import { ConfigValidationError } from "./domain/configuration/loader";

// Wait for configuration to be initialized before proceeding with other imports.
// Schema-validation failures get a clean one-line user-facing error here at
// the CLI boundary, instead of propagating to the Winston uncaughtException
// handler which would emit a stack trace + process-metadata dump (mt#1801).
try {
  await setupConfiguration();
} catch (error) {
  if (error instanceof ConfigValidationError) {
    // ConfigValidationError.message starts with "Configuration validation failed: ..."
    // — already names the unrecognized key and field path. Emit cleanly +
    // a remediation hint, then exit non-zero. The hint is environment-agnostic
    // (PR #1090 R1 NB#1) — doesn't prescribe a specific config path or install
    // method since both vary by platform and install source.
    process.stderr.write(`Error: ${error.message}\n`);
    process.stderr.write(
      "Hint: remove the unknown key from your Minsky config file, " +
        "or update the Minsky binary if it predates the relevant schema change.\n"
    );
    process.exit(1);
  }
  // Unknown failure: let it propagate to the Winston uncaughtException
  // handler so we get the full diagnostic dump for genuinely unexpected
  // errors.
  throw error;
}
profileCheckpoint("config_setup_complete");

import { Command } from "commander";
import { log } from "./utils/logger";
import { exit } from "./utils/process";
import { setupCommonCommandCustomizations, cliFactory } from "./adapters/cli/cli-command-factory";
import { validateError } from "./schemas/error";
import type { AppContainerInterface } from "./composition/types";
import { isMcpStartStdio, isCompletionInvocation } from "./cli-discriminators";
profileCheckpoint("cli_imports_complete");

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
 * Create the CLI command structure
 */
export async function createCli(container: AppContainerInterface): Promise<Command> {
  // Make the container available to CLI command execution contexts (mt#761).
  // Execute handlers access it via context.container.get("serviceName").
  cliFactory.setContainer(container);

  // Setup common command customizations with the CLI instance
  setupCommonCommandCustomizations(cli);

  // Initialize the container lazily via preAction hook — only when a command
  // actually executes, not during registration or help display. This defers
  // the DB connection (~1s) past Commander parsing.
  //
  // mt#1751: For `mcp start` stdio mode, skip this eager init entirely. The
  // start-command action will kick off init in the background AFTER server
  // construction, so the MCP `initialize` JSON-RPC handshake can complete
  // while DI is still resolving. Tool handlers await the init promise
  // before dispatching, so the first tool call pays the deferred cost (and
  // subsequent calls find the container ready). This matters because the
  // /mcp reconnect path spawns a fresh process for every reconnect — paying
  // ~1.1s of DB connection cost before the handshake responds is the
  // single biggest contributor to perceived cold-start latency (mt#1745
  // measured it at 72-75% of total).
  //
  // Non-stdio paths (HTTP mode, all other CLI commands) keep the eager
  // preAction init because their startup pattern is different: HTTP mode
  // is long-lived (Profile B per mt#1720), and CLI commands typically need
  // the container resolved before the action body runs.
  cli.hook("preAction", async (_thisCommand, actionCommand) => {
    if (container.has("persistence")) return;

    if (isMcpStartStdio(actionCommand)) {
      profileCheckpoint("preaction_skipped_for_mcp_stdio");
      log.debug("Container init deferred for mcp start stdio (mt#1751)");
      return;
    }

    // mt#1892: shell-completion TAB handler must not touch DB / DI container.
    // Latency budget is 300ms; container init alone is ~1s. Skip outright.
    if (isCompletionInvocation(actionCommand)) {
      profileCheckpoint("preaction_skipped_for_completions_complete");
      log.debug("Container init skipped for completions complete (mt#1892)");
      return;
    }

    profileCheckpoint("preaction_before_container_init");
    await container.initialize();
    profileCheckpoint("preaction_after_container_init");
    log.debug("Container initialized (lazy, on first command)");
  });

  // Register shared commands (session, tasks, git, rules, config, etc.)
  profileCheckpoint("before_shared_commands_load");
  const { registerAllSharedCommands } = await import("./adapters/shared/commands/index");
  profileCheckpoint("shared_commands_module_loaded");
  await registerAllSharedCommands(container);
  profileCheckpoint("shared_commands_registered");

  // Register all commands via CLI command factory (which applies customizations)
  cliFactory.registerAllCommands(cli);
  profileCheckpoint("cli_factory_registered");

  // Non-shared commands (context, mcp, github, lint, init, setup) pull in expensive
  // dependencies (~700ms total: AI tokenizer, MCP SDK, etc.). Only load when actually
  // invoked or when full help is requested.
  const requestedCommand = process.argv[2];
  const needsAll =
    !requestedCommand ||
    requestedCommand === "--help" ||
    requestedCommand === "-h" ||
    requestedCommand === "help" ||
    requestedCommand === "--version" ||
    requestedCommand === "-V";

  if (needsAll || requestedCommand === "mcp") {
    profileCheckpoint("before_mcp_command_load");
    const { createMCPCommand } = await import("./commands/mcp/index");
    profileCheckpoint("mcp_command_module_loaded");
    cli.addCommand(await createMCPCommand(container));
    profileCheckpoint("mcp_command_added");
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
  if (needsAll || requestedCommand === "init") {
    const { createInitCommand } = await import("./commands/init/index");
    cli.addCommand(createInitCommand());
  }
  if (needsAll || requestedCommand === "setup") {
    const { createSetupCommand } = await import("./commands/setup/index");
    cli.addCommand(createSetupCommand());
  }
  if (needsAll || requestedCommand === "compile") {
    const { createCompileCommand } = await import("./commands/compile/index");
    cli.addCommand(createCompileCommand());
  }
  if (needsAll || requestedCommand === "cockpit") {
    const { createCockpitCommand } = await import("./commands/cockpit/index");
    cli.addCommand(createCockpitCommand(container));
  }
  if (needsAll || requestedCommand === "completions" || requestedCommand === "completion-server") {
    const { createCompletionsCommand, createCompletionServerCommand } = await import(
      "./commands/completions/index"
    );
    cli.addCommand(createCompletionsCommand());
    // Hidden top-level command invoked by the user's shell on TAB.
    // `tabtab` generates shell scripts that call `minsky completion-server`,
    // not `minsky completions complete`, so this MUST be top-level.
    cli.addCommand(createCompletionServerCommand(), { hidden: true });
  }
  if (needsAll || requestedCommand === "ops") {
    const { createOpsCommand } = await import("./commands/ops/index");
    cli.addCommand(createOpsCommand(container));
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
  // Create the DI container with real service factories (deferred initialization)
  const { createCliContainer } = await import("./composition/cli");
  const container = await createCliContainer();

  // Create CLI — container is initialized lazily via preAction hook
  const cliInstance = await createCli(container);
  await cliInstance.parseAsync();

  // Clean up container resources on exit (closes DB connections, etc.)
  await container.close();

  // Still need explicit exit until all resource leaks are fixed
  // The improvements to workspace manager help, but there are other sources
  exit(0);
}

// Run the CLI.
//
// MINSKY_SKIP_CLI_AUTORUN gate (mt#1892): build scripts that need to import
// `createCli` (e.g., scripts/build-completion-manifest.ts) set this env var
// so importing this module does NOT auto-run the CLI. Without the gate, the
// import alone would trigger parseAsync() and exit the build script. The
// env var is registered in HOOK_ONLY_ENV_VARS per the custom ESLint rule
// (mt#1788) so the config-loader skips it.
if (!process.env.MINSKY_SKIP_CLI_AUTORUN) {
  main().catch((err) => {
    const validatedError = validateError(err);
    log.systemDebug(`Error caught in main: ${err}`);
    log.systemDebug(`Error stack: ${validatedError.stack || "No stack available"}`);
    log.error(`Unhandled error in CLI: ${validatedError.message}`);
    if (validatedError.stack) log.debug(validatedError.stack);
    exit(1);
  });
}

export default cli;
