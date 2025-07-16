/**
 * minsky config command
 * 
 * Main configuration command that provides access to all config subcommands
 */

import { Command } from "commander";
import { createConfigListCommand } from "./list";
import { createConfigShowCommand } from "./show";

export function createConfigCommand(): Command {
  const configCmd = new Command("config")
    .description("Configuration management commands").addHelpText(
      "after",
      `
Examples:
  minsky config list         Show all configuration sources
  minsky config show         Show resolved configuration
  minsky config list --json  Output in JSON format
`
    );

  // Add subcommands
  configCmd.addCommand(createConfigListCommand());
  configCmd.addCommand(createConfigShowCommand());

  return configCmd;
} 
