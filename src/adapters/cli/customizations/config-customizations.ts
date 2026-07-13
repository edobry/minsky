/**
 * Config and SessionDB Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { log } from "@minsky/shared/logger";
import {
  formatResolvedConfiguration,
  formatConfigurationSources,
} from "../utilities/formatting-utilities";

/**
 * Utility function to flatten object to key-value pairs
 * @param obj Object to flatten
 * @returns Flattened object
 */
function flattenObjectToKeyValue(obj: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  function flatten(current: Record<string, unknown>, prefix = ""): void {
    const keys = Object.keys(current);
    for (const key of keys) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof current[key] === "object" && current[key] !== null) {
        flatten(current[key] as Record<string, unknown>, fullKey);
      } else {
        flattened[fullKey] = current[key];
      }
    }
  }

  flatten(obj);
  return flattened;
}

/**
 * Flatten nested object into key=value pairs suitable for display
 * @param obj Object to flatten
 * @param prefix Prefix for keys
 * @returns Flattened key-value string
 */
function formatFlattenedConfiguration(resolved: Record<string, unknown>): string {
  const flatten = (obj: Record<string, unknown>, prefix = ""): string[] => {
    const result: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        result.push(`${fullKey}=(null)`);
      } else if (typeof value === "object" && !Array.isArray(value)) {
        // Recursively flatten objects
        result.push(...flatten(value as Record<string, unknown>, fullKey));
      } else if (Array.isArray(value)) {
        if ((value as unknown[]).length === 0) {
          result.push(`${fullKey}=(empty array)`);
        } else {
          (value as unknown[]).forEach((item, index) => {
            if (typeof item === "object") {
              result.push(...flatten(item as Record<string, unknown>, `${fullKey}[${index}]`));
            } else {
              result.push(`${fullKey}[${index}]=${item}`);
            }
          });
        }
      } else if (
        typeof value === "string" &&
        (fullKey.includes("token") ||
          fullKey.includes("password") ||
          fullKey.includes("apiKey") ||
          fullKey.includes("api_key") ||
          fullKey.includes("connectionString") ||
          fullKey.includes("secret") ||
          value.includes("(configured)"))
      ) {
        // Enhanced credential detection - these should already be masked from the MCP command
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
 * Render a config value for terminal output. Scalars print bare (`sk-XXX`,
 * `42`, `true`) so the result is shell-pipeable; objects/arrays print as
 * pretty-JSON with a BigInt-safe replacer so nested bigints stringify
 * as their decimal representation rather than throwing. The handler upstream
 * guarantees `value !== undefined` on the success path, so we only handle
 * the null branch defensively.
 */
export function formatConfigValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/**
 * Pure renderers for config-command results. Return the line to print; the
 * outputFormatter wrappers below pass the return value to log.cli. Separating
 * "what to print" from "where to print" makes the renderers unit-testable
 * without module-level log mocks.
 */
export function renderConfigGetResult(result: Record<string, unknown>): string {
  if (result.json) {
    return JSON.stringify(result, null, 2);
  }
  if (result.success && result.exists) {
    return formatConfigValue(result.value);
  }
  const message =
    typeof result.error === "string" && result.error.length > 0
      ? result.error
      : `Configuration path '${result.key ?? "<unknown>"}' not found`;
  return `Error: ${message}`;
}

export function renderConfigSetResult(result: Record<string, unknown>): string {
  if (result.json) {
    return JSON.stringify(result, null, 2);
  }
  if (!result.success) {
    return `Error: ${result.error ?? "unknown error"}`;
  }
  const key = String(result.key ?? "");
  const newValue = formatConfigValue(result.newValue);
  return `${key} = ${newValue}`;
}

export function renderConfigUnsetResult(result: Record<string, unknown>): string {
  if (result.json) {
    return JSON.stringify(result, null, 2);
  }
  if (!result.success) {
    return `Error: ${result.error ?? "unknown error"}`;
  }
  const key = String(result.key ?? "");
  return `unset ${key}`;
}

/**
 * Get config command customizations configuration
 * @returns Config category customization options
 */
export function getConfigCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.CONFIG,
    options: {
      commandOptions: {
        "config.list": {
          outputFormatter: (result: Record<string, unknown>) => {
            // Check if JSON output was requested
            if (result.json) {
              // For JSON output, return flattened key-value pairs (matching normal output)
              const flattened = flattenObjectToKeyValue(result.resolved as Record<string, unknown>);
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
                output += formatFlattenedConfiguration(result.resolved as Record<string, unknown>);
              }

              // Add security notice if credentials are masked
              if (result.credentialsMasked) {
                output +=
                  "\n\n⚠️  Credentials are masked for security. Use --show-secrets to reveal actual values.";
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
          outputFormatter: (result: Record<string, unknown>) => {
            // Check if JSON output was requested
            if (result.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }

            if (result.success && result.configuration) {
              let output = "";

              // Show sources if explicitly requested
              if (result.showSources && result.sources) {
                output += formatConfigurationSources(
                  result.configuration as Record<string, unknown>,
                  result.sources as Record<string, unknown>[],
                  result.effectiveValues as
                    | Record<string, { value: unknown; source: string; path: string }>
                    | undefined
                );
              } else {
                // Default human-friendly structured view
                output += formatResolvedConfiguration(
                  result.configuration as Record<string, unknown>
                );
              }

              log.cli(output);
            } else if (result.error) {
              log.cli(`Failed to load configuration: ${result.error}`);
            } else {
              log.cli(JSON.stringify(result, null, 2));
            }
          },
        },
        "config.get": {
          outputFormatter: (result: Record<string, unknown>) => {
            log.cli(renderConfigGetResult(result));
          },
        },
        "config.set": {
          parameters: {
            key: {
              asArgument: true,
              description: "Configuration key path",
            },
            value: {
              asArgument: true,
              description: "Value to set",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
            log.cli(renderConfigSetResult(result));
          },
        },
        "config.unset": {
          parameters: {
            key: {
              asArgument: true,
              description: "Configuration key path",
            },
          },
          outputFormatter: (result: Record<string, unknown>) => {
            log.cli(renderConfigUnsetResult(result));
          },
        },
      },
    },
  };
}

/**
 * Get persistence command customizations configuration
 * @returns Persistence category customization options
 */
export function getPersistenceCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.PERSISTENCE,
    options: {
      commandOptions: {
        "persistence.migrate": {
          useFirstRequiredParamAsArgument: true,
          parameters: {
            to: {
              asArgument: true,
              description: "Target backend (postgres)",
            },
            from: {
              description: "Source backup file path (auto-detect if not specified)",
            },
            connectionString: {
              description: "PostgreSQL connection string",
            },
            backup: {
              description:
                "Create a JSON backup of the source before migration, written to the Minsky state dir with an auto-generated filename (default: true)",
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
