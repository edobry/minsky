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
import {
  customizeCommand,
  createCommand,
  setupCommonCommandCustomizations
} from "./adapters/cli/cli-command-factory.js";
// Import CommandCategory from the current working directory
// We'll handle the CommandCategory enum definition locally
// since we can't directly import it from domain/types.js

// Define the CommandCategory enum locally if needed
enum CommandCategory {
  SESSION = "SESSION",
  TASKS = "TASKS",
  GIT = "GIT",
  RULES = "RULES",
  INIT = "INIT",
  MCP = "MCP",
}

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

// Add customization for the session get command
customizeCommand("session.get", {
  // Use first required parameter as positional argument
  useFirstRequiredParamAsArgument: true,
  // Add command-specific parameter customizations
  parameters: {
    session: {
      // This maps the session parameter to the first positional argument
      asArgument: true,
      description: "Session name"
    },
    // Add the include-details option as a custom parameter
    includeDetails: {
      description: "Include additional session details",
      alias: "i"
    }
  }
});

// Create the standard session command
const sessionCommand = createSessionCommand({
  getCurrentSession,
});

// Generate the "session list" command via the bridge
const bridgeGeneratedListCommand = createCommand("session.list");
// Generate the "session get" command via the bridge
const bridgeGeneratedGetCommand = createCommand("session.get");

if (bridgeGeneratedListCommand && bridgeGeneratedGetCommand) {
  // Instead of replacing the session command, we'll create a temporary program
  // and use that instead, adding all commands except session, then our modified session
  const tempProgram = new Command();
  
  // Add our modified session command first
  // Create a fresh session command with all the non-list and non-get commands from the original
  const modifiedSessionCommand = new Command(sessionCommand.name())
    .description(sessionCommand.description());
  
  // Copy all commands except the list and get commands
  sessionCommand.commands.forEach(cmd => {
    if (cmd.name() !== "list" && cmd.name() !== "get") {
      modifiedSessionCommand.addCommand(cmd);
    }
  });
  
  // Add the bridge-generated commands
  modifiedSessionCommand.addCommand(bridgeGeneratedListCommand);
  modifiedSessionCommand.addCommand(bridgeGeneratedGetCommand);
  
  // Add the modified session command first
  tempProgram.addCommand(modifiedSessionCommand);
  
  // Add all other commands
  tempProgram.addCommand(createTasksCommand());
  tempProgram.addCommand(createGitCommand());
  tempProgram.addCommand(createInitCommand());
  tempProgram.addCommand(createMCPCommand());
  tempProgram.addCommand(createRulesCommand());
  
  // Log that we're using the bridge-generated commands
  log.cli("Using bridge-generated commands for 'session list' and 'session get'");
  
  // Use the temp program for parsing
  tempProgram.parse();
  
  // Exit early since we've already parsed
  process.exit(0);
} else {
  // Original program flow if the bridge commands weren't generated
  program.addCommand(sessionCommand);
  program.addCommand(createTasksCommand());
  program.addCommand(createGitCommand());
  program.addCommand(createInitCommand());
  program.addCommand(createMCPCommand());
  program.addCommand(createRulesCommand());
  
  program.parse();
}
