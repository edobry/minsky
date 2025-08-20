/**
 * minsky config set command
 *
 * Updates configuration values programmatically with validation and backup
 */

import { Command } from "commander";
import { createConfigWriter } from "../../domain/configuration/config-writer";
import { log } from "../../utils/logger";

interface SetOptions {
  json?: boolean;
  noBackup?: boolean;
  format?: "yaml" | "json";
}

/**
 * Dependencies for executeConfigSet - used for dependency injection in tests
 */
export interface ConfigSetDependencies {
  createConfigWriter: typeof createConfigWriter;
  console: {
    log: (message: string) => void;
  };
}

/**
 * Execute the config set action - extracted for testability
 */
export async function executeConfigSet(
  key: string,
  value: string,
  options: SetOptions,
  deps?: ConfigSetDependencies
): Promise<void> {
  // Set up dependencies with defaults
  const dependencies = {
    createConfigWriter: deps?.createConfigWriter || createConfigWriter,
    console: deps?.console || console,
  };

  try {
    // Parse value - try to detect type
    const parsedValue = parseConfigValue(value);

    // Create config writer
    const writer = dependencies.createConfigWriter({
      createBackup: !options.noBackup,
      format: options.format === "json" ? "json" : "yaml",
      validate: true,
    });

    // Set the configuration value
    const result = await writer.setConfigValue(key, parsedValue);

    if (!result.success) {
      const errorMessage = `Failed to set configuration: ${result.error}`;
      if (options.json) {
        dependencies.console.log(
          JSON.stringify(
            {
              success: false,
              error: errorMessage,
            },
            null,
            2
          )
        );
      } else {
        log.error(errorMessage);
      }
      throw new Error(errorMessage);
    }

    // Output results
    if (options.json) {
      dependencies.console.log(
        JSON.stringify(
          {
            success: true,
            key,
            previousValue: result.previousValue,
            newValue: result.newValue,
            filePath: result.filePath,
            backupPath: result.backupPath,
          },
          null,
          2
        )
      );
    } else {
      dependencies.console.log(`✅ Configuration updated successfully`);
      dependencies.console.log(`   Key: ${key}`);
      dependencies.console.log(`   Previous value: ${formatValue(result.previousValue)}`);
      dependencies.console.log(`   New value: ${formatValue(result.newValue)}`);
      dependencies.console.log(`   File: ${result.filePath}`);

      if (result.backupPath) {
        dependencies.console.log(`   Backup: ${result.backupPath}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      dependencies.console.log(
        JSON.stringify(
          {
            success: false,
            error: message,
          },
          null,
          2
        )
      );
    } else {
      log.error(`Failed to set configuration: ${message}`);
    }

    throw error;
  }
}

export function createConfigSetCommand(): Command {
  return new Command("set")
    .description("Set a configuration value")
    .argument("<key>", "Configuration key path (e.g., 'ai.providers.openai.model')")
    .argument("<value>", "Value to set")
    .option("--json", "Output in JSON format", false)
    .option("--no-backup", "Skip creating backup before modification", false)
    .option("--format <format>", "File format to use (yaml|json)", "yaml")
    .addHelpText(
      "after",
      `
Examples:
  minsky config set backend markdown
  minsky config set ai.providers.openai.model gpt-4
  minsky config set sessiondb.backend sqlite
  minsky config set github.token ghp_xxxx
  minsky config set logger.level debug
`
    )
    .action(async (key: string, value: string, options: SetOptions) => {
      try {
        await executeConfigSet(key, value, options);
      } catch (error) {
        process.exit(1);
      }
    });
}

/**
 * Parse configuration value from string input
 */
export function parseConfigValue(value: string): any {
  // Handle special values
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined") return undefined;

  // Try to parse as number
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (!isNaN(num)) {
      return num;
    }
  }

  // Try to parse as JSON (for arrays and objects)
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through to string
    }
  }

  // Return as string
  return value;
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
