/**
 * minsky config unset command
 *
 * Removes configuration values with validation and backup
 */

import { Command } from "commander";
import * as configWriter from "../../domain/configuration/config-writer";
import { log } from "../../utils/logger";

interface UnsetOptions {
  json?: boolean;
  noBackup?: boolean;
  format?: "yaml" | "json";
}

/**
 * Execute the config unset action - extracted for testability
 */
export async function executeConfigUnset(key: string, options: UnsetOptions): Promise<void> {
  try {
    // Create config writer
    const writer = configWriter.createConfigWriter({
      createBackup: !options.noBackup,
      format: options.format === "json" ? "json" : "yaml",
      validate: true,
    });

    // Unset the configuration value
    const result = await writer.unsetConfigValue(key);

    if (!result.success) {
      const errorMessage = `Failed to unset configuration: ${result.error}`;
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          )
        );
        return; // Do not exit; tests and callers handle outcome
      } else {
        log.error(errorMessage);
        return;
      }
    }

    // Output results
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            success: true,
            key,
            previousValue: result.previousValue,
            filePath: result.filePath,
            backupPath: result.backupPath,
          },
          null,
          2
        )
      );
    } else {
      if (result.previousValue === undefined) {
        console.log(`ℹ️  Configuration key was already unset`);
        console.log(`   Key: ${key}`);
      } else {
        console.log(`✅ Configuration removed successfully`);
        console.log(`   Key: ${key}`);
        console.log(`   Previous value: ${formatValue(result.previousValue)}`);
        if (result.backupPath) {
          console.log(`   Backup: ${result.backupPath}`);
        }
      }
      console.log(`   File: ${result.filePath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: message,
          },
          null,
          2
        )
      );
      return;
    } else {
      log.error(`Failed to unset configuration: ${message}`);
      return;
    }
  }
}

export function createConfigUnsetCommand(): Command {
  return new Command("unset")
    .description("Remove a configuration value")
    .argument("<key>", "Configuration key path to remove (e.g., 'ai.providers.openai.model')")
    .option("--json", "Output in JSON format", false)
    .option("--no-backup", "Skip creating backup before modification", false)
    .option("--format <format>", "File format to use (yaml|json)", "yaml")
    .addHelpText(
      "after",
      `
Examples:
  minsky config unset ai.providers.openai.model
  minsky config unset github.token
  minsky config unset sessiondb.backend
  minsky config unset logger.enableAgentLogs
`
    )
    .action(executeConfigUnset);
}

/**
 * Format value for display
 */
export function formatValue(value: any): string {
  if (value === undefined) {
    return "(not set)";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}
