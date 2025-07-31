/**
 * Standardized Config Command Customizations
 *
 * Applies the type composition patterns from Tasks #322 and #329 to config command customizations.
 * Demonstrates standardized parameter handling, response formatting, and error handling.
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import {
  CliBaseParametersSchema,
  createCliCommandSchema,
} from "../schemas/cli-parameter-schemas";
import {
  createCliSuccessResponse,
  formatCliOutput,
} from "../schemas/cli-response-schemas";
import {
  validateCliParameters,
  handleStandardizedCliError,
} from "../utils/standardized-error-handler";
import { z } from "zod";

/**
 * Config-specific parameter schemas
 */
const ConfigListParametersSchema = z.object({
  showSecrets: z.boolean().default(false),
});

const ConfigShowParametersSchema = z.object({
  workingDir: z.string().optional(),
});

/**
 * CLI config parameter schemas with standardized CLI options
 */
export const CliConfigListParametersSchema = createCliCommandSchema(ConfigListParametersSchema);
export const CliConfigShowParametersSchema = createCliCommandSchema(ConfigShowParametersSchema);

/**
 * Get standardized config command customizations using type composition patterns
 */
export function getStandardizedConfigCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.CONFIG,
    options: {
      commandOptions: {
        "config.list": {
          parameterSchema: CliConfigListParametersSchema,
          parameters: {
            showSecrets: {
              description: "Show actual credential values (SECURITY RISK: use with caution)",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              alias: "q",
              description: "Suppress non-essential output",
            },
            verbose: {
              alias: "v",
              description: "Show verbose output",
            },
            debug: {
              description: "Enable debug output",
            },
          },
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              debug: result.debug,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliConfigListParametersSchema,
                result,
                "config.list",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.resolved || result,
                  metadata: result.metadata,
                  sources: result.sources || [],
                },
                {
                  command: "config.list",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                // Format configuration display
                let output = "📋 CONFIGURATION SOURCES\n";
                output += "=".repeat(50) + "\n\n";

                if (data.result.resolved) {
                  // Display each configuration section
                  const sections = [
                    { key: "backend", title: "📁 Task Storage Backend" },
                    { key: "sessiondb", title: "💾 Session Storage" },
                    { key: "ai", title: "🤖 AI Configuration" },
                    { key: "github", title: "📦 GitHub Configuration" },
                    { key: "logger", title: "📝 Logger Configuration" },
                  ];

                  sections.forEach(({ key, title }) => {
                    if (data.result.resolved[key]) {
                      output += `${title}\n`;
                      output += JSON.stringify(data.result.resolved[key], null, 2);
                      output += "\n\n";
                    }
                  });
                }

                if (data.sources && data.sources.length > 0) {
                  output += "📂 Configuration Sources:\n";
                  data.sources.forEach((source: string) => {
                    output += `  • ${source}\n`;
                  });
                }

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "config.list", options);
            }
          },
        },

        "config.show": {
          parameterSchema: CliConfigShowParametersSchema,
          parameters: {
            workingDir: {
              description: "Working directory",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              alias: "q",
              description: "Suppress non-essential output",
            },
            verbose: {
              alias: "v",
              description: "Show verbose output",
            },
          },
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              debug: result.debug,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliConfigShowParametersSchema,
                result,
                "config.show",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.resolved || result },
                {
                  command: "config.show",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                // Format comprehensive configuration display
                let output = "📋 CURRENT CONFIGURATION\n";
                output += "=".repeat(50) + "\n\n";

                const config = data.result;

                // Task Storage Backend
                if (config.backend) {
                  output += "📁 TASK STORAGE\n";
                  output += `Backend: ${config.backend}\n`;
                  if (config.backendConfig) {
                    output += `Config: ${JSON.stringify(config.backendConfig, null, 2)}\n`;
                  }
                  output += "\n";
                }

                // Session Storage
                if (config.sessiondb) {
                  output += "💾 SESSION STORAGE\n";
                  output += `Database: ${config.sessiondb.type || "default"}\n`;
                  if (config.sessiondb.config) {
                    output += `Config: ${JSON.stringify(config.sessiondb.config, null, 2)}\n`;
                  }
                  output += "\n";
                }

                // AI Configuration
                if (config.ai) {
                  output += "🤖 AI CONFIGURATION\n";
                  if (config.ai.provider) {
                    output += `Provider: ${config.ai.provider}\n`;
                  }
                  if (config.ai.model) {
                    output += `Model: ${config.ai.model}\n`;
                  }
                  output += "\n";
                }

                // GitHub Configuration
                if (config.github) {
                  output += "📦 GITHUB CONFIGURATION\n";
                  if (config.github.owner) {
                    output += `Owner: ${config.github.owner}\n`;
                  }
                  if (config.github.repo) {
                    output += `Repository: ${config.github.repo}\n`;
                  }
                  output += "\n";
                }

                // Logger Configuration
                if (config.logger) {
                  output += "📝 LOGGER CONFIGURATION\n";
                  output += `Level: ${config.logger.level || "info"}\n`;
                  output += "\n";
                }

                // Credentials (if available)
                if (config.credentials) {
                  output += "🔐 CREDENTIALS\n";
                  Object.entries(config.credentials).forEach(([key, value]: [string, any]) => {
                    output += `${key}: ${value.status || "Unknown"}\n`;
                  });
                  output += "\n";
                }

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "config.show", options);
            }
          },
        },
      },
    },
  };
}

/**
 * Migration benefits for config commands:
 *
 * 1. **Enhanced Configuration Display**: Standardized formatting for configuration data
 * 2. **Consistent Parameter Validation**: Type-safe configuration command parameters
 * 3. **Security Awareness**: Proper handling of sensitive credential information
 * 4. **Multi-format Output**: JSON and human-readable configuration display
 * 5. **Error Recovery**: Helpful error messages for configuration issues
 *
 * Example usage after full integration:
 * ```bash
 * minsky config list --json
 * minsky config show --verbose
 * minsky config list --show-secrets --quiet
 * ```
 */ 
