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
  analyze         Analyze current context composition and token usage
  generate        Generate AI context using modular components
  visualize       Generate visual representation of context usage

Examples:
  minsky context suggest-rules "I need to fix a bug"
  minsky context analyze --model gpt-4o --include-optimizations
  minsky context analyze --compare-models gpt-4,claude-3-5-sonnet
  minsky context generate --format json --components environment,rules
  minsky context visualize --chart-type pie --show-details

The context command helps you understand and optimize the information
available to AI assistants for better collaboration.
`
    );

  // Add subcommands
  contextCmd.addCommand(createSuggestRulesCommand());

  // Add available context commands
  // Note: analyze/generate/visualize are temporarily unavailable; only register existing commands

  return contextCmd;
}
