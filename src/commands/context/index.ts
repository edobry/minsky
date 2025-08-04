/**
 * Context command implementation
 *
 * Main command for context management, including rule suggestions.
 * Designed to coordinate with Task 082 (context analysis/visualization).
 */

import { Command } from "commander";
import { createSuggestRulesCommand } from "./suggest-rules";

/**
 * Create the main context command
 */
export function createContextCommand(): Command {
  const contextCmd = new Command("context")
    .description("Context management commands for AI collaboration")
    .addHelpText(
      "after",
      `
Context Management:
  suggest-rules    Get AI-powered rule suggestions for your current task

Future Commands (Task 082):
  analyze         Analyze current context composition and token usage
  visualize       Generate visual representation of context usage

Examples:
  minsky context suggest-rules "I need to fix a bug"
  minsky context suggest-rules "refactor code organization" --json
  minsky context suggest-rules "add tests" --max-suggestions 3

The context command helps you understand and optimize the information
available to AI assistants for better collaboration.
`
    );

  // Add subcommands
  contextCmd.addCommand(createSuggestRulesCommand());

  // Future: Add analyze and visualize commands from Task 082
  // contextCmd.addCommand(createAnalyzeCommand());
  // contextCmd.addCommand(createVisualizeCommand());

  return contextCmd;
}
