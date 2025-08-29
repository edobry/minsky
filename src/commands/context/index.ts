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
  generate         Generate AI context using modular components with optional analysis and visualization

Examples:
  minsky context suggest-rules "I need to fix a bug"
  minsky context generate --json --components environment,rules
  minsky context generate --analyze --show-breakdown  # Generate with analysis
  minsky context generate --analyze-only  # Show only analysis without full context
  minsky context generate --compare-models gpt-4,claude-3-5-sonnet  # Cross-model comparison
  minsky context generate --output /tmp/test-context.txt

  # Visualization examples (integrated into generate command)
  minsky context generate --visualize                  # Generate context with bar chart
  minsky context generate --visualize-only --chart-type pie  # Only show pie chart
  minsky context generate --visualize --show-details   # Visualization with detailed breakdown
  minsky context generate --compare-models gpt-4,claude-3-5-sonnet --visualize  # Compare with charts
  minsky context generate --csv                        # CSV output for spreadsheets

The context command helps you understand and optimize the information
available to AI assistants for better collaboration.
`
    );

  // Add subcommands
  contextCmd.addCommand(createSuggestRulesCommand());
  contextCmd.addCommand(createGenerateCommand());

  return contextCmd;
}