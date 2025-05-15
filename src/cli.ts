#!/usr/bin/env bun
/* eslint-disable no-restricted-imports */
import { Command } from "commander";
import { createSessionCommand } from "./commands/session/index.js";
import { createTasksCommand as createOldTasksCommand } from "./commands/tasks/index.js";
import { createTasksCommand } from "./adapters/cli/tasks.js";
import { createGitCommand } from "./commands/git/index.js";
import { createInitCommand } from "./commands/init/index.js";
import { createMCPCommand } from "./commands/mcp/index.js";
import { createRulesCommand } from "./commands/rules/index.js";
import { log } from "./utils/logger";

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

// Use a modified session command that uses our custom getCurrentSession function
const sessionCommand = createSessionCommand({
  getCurrentSession,
});

program.addCommand(sessionCommand);
program.addCommand(createTasksCommand());
program.addCommand(createGitCommand());
program.addCommand(createInitCommand());
program.addCommand(createMCPCommand());
program.addCommand(createRulesCommand());

program.parse();
