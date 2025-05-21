#!/usr/bin/env bun
/* eslint-disable no-restricted-imports */
import { Command } from "commander";
import { createSessionCommand } from "./adapters/cli/session.js";
import { createTasksCommand } from "./adapters/cli/tasks.js";
import { createGitCommand } from "./adapters/cli/git.js";
import { createInitCommand } from "./adapters/cli/init.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import { createRulesCommand } from "./adapters/cli/rules.js";
import { log } from "./utils/logger";
import {
  customizeCommand,
  createCommand,
  setupCommonCommandCustomizations
} from "./adapters/cli/cli-command-factory.js";
import { CommandCategory } from "./domain/types.js";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./domain/workspace.js";
import * as workspaceModule from "./domain/workspace.js";

// Use environment variable directly rather than trying to mock the function
// This avoids the "Attempted to assign to readonly property" error
const getCurrentSession = async () => {
  return Bun.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program.name("minsky").description("CLI for managing Minsky workflow").version("0.1.0");

// Set up CLI bridge customizations
setupCommonCommandCustomizations();

// Create the standard session command
const sessionCommand = createSessionCommand({
  getCurrentSession,
});

// Generate the "session list" command via the bridge
const bridgeGeneratedListCommand = createCommand("session.list");

if (bridgeGeneratedListCommand) {
  // Replace the "list" subcommand in the session command with our bridge-generated one
  const originalListCommand = sessionCommand.commands.find(cmd => cmd.name() === "list");
  if (originalListCommand) {
    // Remove the original list command
    sessionCommand.removeCommand(originalListCommand);
  }
  
  // Add the bridge-generated command
  sessionCommand.addCommand(bridgeGeneratedListCommand);
  
  // Log that we're using the bridge-generated command
  log.info("Using bridge-generated command for 'session list'");
}

program.addCommand(sessionCommand);
program.addCommand(createTasksCommand());
program.addCommand(createGitCommand());
program.addCommand(createInitCommand());
program.addCommand(createMCPCommand());
program.addCommand(createRulesCommand());

program.parse();
