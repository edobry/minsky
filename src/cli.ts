#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./src/commands/session";

// Override getCurrentSession for testing
import { getCurrentSession as originalGetCurrentSession } from "./src/domain/workspace";
import * as workspaceModule from "./src/domain/workspace";

// Use environment variable directly rather than trying to mock the function
// This avoids the "Attempted to assign to readonly property" error
const getCurrentSession = async () => {
  return process.env.MINSKY_TEST_CURRENT_SESSION || null;
};

const program = new Command();
program
  .name("minsky")
  .description("CLI for managing Minsky workflow")
  .version("0.1.0");

// Use a modified session command that uses our custom getCurrentSession function
const sessionCommand = createSessionCommand({ 
  getCurrentSession 
});

program.addCommand(sessionCommand);

program.parse();