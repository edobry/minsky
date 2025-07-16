/**
 * Config and SessionDB Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "../../../utils/logger";

/**
 * Utility function to flatten object to key-value pairs
 * @param obj Object to flatten
 * @returns Flattened object
 */
function flattenObjectToKeyValue(obj: any): any {
  const flattened: any = {};

  function flatten(current: any, prefix = ""): void {
    if (typeof current === "object" && current !== null) {
      const keys = Object.keys(current);
      for (const key of keys) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof current[key] === "object" && current[key] !== null) {
          flatten(current[key], fullKey);
        } else {
          flattened[fullKey] = current[key];
        }
      }
    }
  }

  flatten(obj as unknown);
  return flattened;
}

/**
 * Format flattened configuration for display
 * @param resolved Resolved configuration object
 * @returns Formatted string
 */
function formatFlattenedConfiguration(resolved: any): string {
  const flatten = (obj: any, prefix = ""): string[] => {
    const result: string[] = [];

    for (const [key, value] of Object.entries(obj as any)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        result.push(`${fullKey}=(null)`);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        // Recursively flatten objects
        result.push(...flatten(value, fullKey));
      } else if (Array.isArray(value)) {
        if ((value as any[]).length === 0) {
          result.push(`${fullKey}=(empty array)`);
        } else {
          (value as any[]).forEach((item, index) => {
            if (typeof item === "object") {
              result.push(...flatten(item, `${fullKey}[${index}]`));
            } else {
              result.push(`${fullKey}[${index}]=${item}`);
            }
          });
        }
      } else if (
        typeof value === "string" &&
        (fullKey.includes("token") || fullKey.includes("password"))
      ) {
        // Hide sensitive values
        result.push(`${fullKey}=*** (hidden)`);
      } else {
        result.push(`${fullKey}=${value}`);
      }
    }

    return result;
  };

  const flatEntries = flatten(resolved);
  return flatEntries.join("\n");
}

/**
 * Get config command customizations configuration
 * @returns Config category customization options
 */
export function getConfigCustomizations(): { category: CommandCategory; options: CategoryCommandOptions } {
  return {
    category: CommandCategory.CONFIG,
    options: {
      commandOptions: {
        "config.list": {
          outputFormatter: (result: any) => {
            // Check if JSON output was requested
            if (result.json) {
              // For JSON output, return flattened key-value pairs (matching normal output)
              const flattened = flattenObjectToKeyValue(result.resolved);
              log.cli(JSON.stringify(flattened, null, 2));
              return;
            }

            if (result.success && result.resolved) {
              let output = "";

              // Show sources if explicitly requested
              if (result.showSources && result.sources) {
                // Note: formatConfigurationSources needs to be imported from utilities
                output += "Configuration sources view not available in extracted module";
              } else {
                // For config list, show flattened key=value pairs
                output += formatFlattenedConfiguration(result.resolved);
              }

              log.cli(output);
            } else if (result.error) {
              log.cli(`Failed to load configuration: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
        "config.show": {
          outputFormatter: (result: any) => {
            // Check if JSON output was requested
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }

            if (result.success && result.configuration) {
              let output = "";

              // Show sources if explicitly requested
              if (result.showSources && result.sources) {
                // Note: formatConfigurationSources needs to be imported from utilities
                output += "Configuration sources view not available in extracted module";
              } else {
                // Default human-friendly structured view
                // Note: formatResolvedConfiguration needs to be imported from utilities
                output += "Structured configuration view not available in extracted module";
              }

              log.cli(output);
            } else if (result.error) {
              log.cli(`Failed to load configuration: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
      },
    },
  };
}

/**
 * Get sessiondb command customizations configuration
 * @returns SessionDB category customization options
 */
export function getSessiondbCustomizations(): { category: string; options: CategoryCommandOptions } {
  return {
    category: "SESSIONDB" as any,
    options: {
      commandOptions: {
        "sessiondb.migrate": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            to: {
              asArgument: true,
              description: "Target backend (json, sqlite, postgres)",
            },
            from: {
              description: "Source backend (auto-detect if not specified)",
            },
            sqlitePath: {
              description: "SQLite database file path",
            },
            connectionString: {
              description: "PostgreSQL connection string",
            },
            backup: {
              description: "Create backup in specified directory",
            },
            dryRun: {
              alias: "n",
              description: "Simulate migration without making changes",
            },
            verify: {
              alias: "V",
              description: "Verify migration after completion",
            },
          },
        },
      },
    },
  };
} 
