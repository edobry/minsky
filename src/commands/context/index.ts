/**
 * Context command implementation
 *
 * Main command for context management, including rule suggestions.
 * Designed to coordinate with Task 082 (context analysis/visualization)
 * and provide testbench for modular context components.
 */

import { Command } from "commander";
import { createSuggestRulesCommand } from "./suggest-rules";
import { createGenerateCommand } from "./generate";

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
  generate         Generate AI context using modular components with optional analysis

Examples:
  minsky context suggest-rules "I need to fix a bug"
  minsky context generate --format json --components environment,rules
  minsky context generate --analyze --show-breakdown  # Generate with analysis
  minsky context generate --compare-models gpt-4,claude-3-5-sonnet  # Cross-model comparison
  minsky context generate --output /tmp/test-context.txt

The context command helps you understand and optimize the information
available to AI assistants for better collaboration.
`
    );

  // Add subcommands
  contextCmd.addCommand(createSuggestRulesCommand());
  contextCmd.addCommand(createGenerateCommand());

  // Future: Add visualize command from Task 082
  // contextCmd.addCommand(createVisualizeCommand());

  return contextCmd;
}
