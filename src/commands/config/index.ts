/**
 * minsky config command
 *
 * Main configuration command that provides access to all config subcommands
 */

import { Command } from "commander";
import { createConfigListCommand } from "./list";
import { createConfigSetCommand } from "./set";
import { createConfigUnsetCommand } from "./unset";
import { createConfigValidateCommand } from "./validate";
import { createConfigDoctorCommand } from "./doctor";

export function createConfigCommand(): Command {
  const configCmd = new Command("config")
    .description("Configuration management commands")
    .addHelpText(
      "after",
      `
Examples:
  minsky config list                            Show all configuration sources
  minsky config show                            Show resolved configuration
  minsky config set <key> <value>               Set a configuration value
  minsky config unset <key>                     Remove a configuration value
  minsky config validate                        Validate configuration
  minsky config doctor                          Diagnose configuration issues
  
  minsky config list --json                     Output in JSON format
  minsky config set backend markdown            Set backend type
  minsky config set ai.providers.openai.model gpt-4  Set AI model
  minsky config unset github.token              Remove GitHub token
`
    );

  // Add subcommands  
  configCmd.addCommand(createConfigListCommand());
  // config.show is handled by command registration pattern in src/adapters/shared/commands/config.ts
  configCmd.addCommand(createConfigSetCommand());
  configCmd.addCommand(createConfigUnsetCommand());
  configCmd.addCommand(createConfigValidateCommand());
  configCmd.addCommand(createConfigDoctorCommand());

  return configCmd;
}
