/**
 * Standardized Rules Command Customizations
 *
 * Applies the type composition patterns from Tasks #322 and #329 to rules command customizations.
 * Demonstrates standardized parameter handling, response formatting, and error handling.
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import {
  CliBaseParametersSchema,
  createCliCommandSchema,
  createCliListingCommandSchema,
  createCliCrudCommandSchema,
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
 * Rules-specific parameter schemas
 */
const RulesListParametersSchema = z.object({
  format: z.enum(["cursor", "generic"]).optional(),
  tag: z.string().optional(),
});

const RulesGetParametersSchema = z.object({
  id: z.string().min(1, "Rule ID is required"),
  format: z.enum(["cursor", "generic"]).optional(),
});

const RulesGenerateParametersSchema = z.object({
  interface: z.enum(["cli", "mcp", "hybrid"]).default("cli"),
  rules: z.string().optional(),
  outputDir: z.string().optional(),
  dryRun: z.boolean().default(false),
  overwrite: z.boolean().default(false),
  format: z.enum(["cursor", "openai"]).default("cursor"),
  preferMcp: z.boolean().default(false),
  mcpTransport: z.enum(["stdio", "http"]).default("stdio"),
});

const RulesCreateParametersSchema = z.object({
  id: z.string().min(1, "Rule ID is required"),
  content: z.string().min(1, "Rule content is required"),
  name: z.string().optional(),
  description: z.string().optional(),
  format: z.enum(["cursor", "generic"]).optional(),
  tags: z.string().optional(),
  globs: z.string().optional(),
  overwrite: z.boolean().default(false),
});

const RulesSearchParametersSchema = z.object({
  query: z.string().optional(),
  format: z.enum(["cursor", "generic"]).optional(),
  tag: z.string().optional(),
});

const RulesUpdateParametersSchema = z.object({
  id: z.string().min(1, "Rule ID is required"),
  content: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  format: z.enum(["cursor", "generic"]).optional(),
  tags: z.string().optional(),
  globs: z.string().optional(),
});

/**
 * CLI rules parameter schemas with standardized CLI options
 */
export const CliRulesListParametersSchema = createCliListingCommandSchema(RulesListParametersSchema);
export const CliRulesGetParametersSchema = createCliCommandSchema(RulesGetParametersSchema);
export const CliRulesGenerateParametersSchema = createCliCommandSchema(RulesGenerateParametersSchema);
export const CliRulesCreateParametersSchema = createCliCrudCommandSchema(RulesCreateParametersSchema);
export const CliRulesSearchParametersSchema = createCliCommandSchema(RulesSearchParametersSchema);
export const CliRulesUpdateParametersSchema = createCliCrudCommandSchema(RulesUpdateParametersSchema);

/**
 * Get standardized rules command customizations using type composition patterns
 */
export function getStandardizedRulesCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.RULES,
    options: {
      commandOptions: {
        "rules.list": {
          parameterSchema: CliRulesListParametersSchema,
          parameters: {
            format: {
              description: "Filter by rule format (cursor or generic)",
            },
            tag: {
              description: "Filter by tag",
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
                CliRulesListParametersSchema,
                result,
                "rules.list",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.rules || [], count: (result.rules || []).length },
                {
                  command: "rules.list",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                if (!data.result || data.result.length === 0) {
                  return "No rules found.";
                }

                let output = `📋 Found ${data.result.length} rule(s):\n\n`;

                data.result.forEach((rule: any, index: number) => {
                  output += `${index + 1}. ${rule.id}\n`;
                  if (rule.name) {
                    output += `   Name: ${rule.name}\n`;
                  }
                  if (rule.description) {
                    output += `   Description: ${rule.description}\n`;
                  }
                  if (rule.format) {
                    output += `   Format: ${rule.format}\n`;
                  }
                  if (rule.tags && rule.tags.length > 0) {
                    output += `   Tags: ${rule.tags.join(", ")}\n`;
                  }
                  output += "\n";
                });

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "rules.list", options);
            }
          },
        },

        "rules.get": {
          useFirstRequiredParamAsArgument: true,
          parameterSchema: CliRulesGetParametersSchema,
          parameters: {
            id: {
              asArgument: true,
              description: "Rule ID",
            },
            format: {
              description: "Preferred rule format (cursor or generic)",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
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
                CliRulesGetParametersSchema,
                result,
                "rules.get",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.rule || result },
                {
                  command: "rules.get",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                const rule = data.result;
                let output = `📋 Rule: ${rule.id}\n\n`;

                if (rule.name) {
                  output += `Name: ${rule.name}\n`;
                }
                if (rule.description) {
                  output += `Description: ${rule.description}\n`;
                }
                if (rule.format) {
                  output += `Format: ${rule.format}\n`;
                }
                if (rule.tags && rule.tags.length > 0) {
                  output += `Tags: ${rule.tags.join(", ")}\n`;
                }
                if (rule.globs && rule.globs.length > 0) {
                  output += `Globs: ${rule.globs.join(", ")}\n`;
                }

                output += "\n📄 Content:\n";
                output += "─".repeat(50) + "\n";
                output += rule.content || "";
                output += "\n" + "─".repeat(50) + "\n";

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "rules.get", options);
            }
          },
        },

        "rules.generate": {
          parameterSchema: CliRulesGenerateParametersSchema,
          parameters: {
            interface: {
              description: "Interface preference (cli, mcp, or hybrid)",
            },
            rules: {
              description: "Comma-separated list of specific rule templates to generate",
            },
            outputDir: {
              description: "Output directory for generated rules",
            },
            dryRun: {
              alias: "n",
              description: "Show what would be generated without creating files",
            },
            overwrite: {
              description: "Overwrite existing rule files",
            },
            format: {
              description: "Rule format (cursor or openai)",
            },
            preferMcp: {
              description: "In hybrid mode, prefer MCP commands over CLI",
            },
            mcpTransport: {
              description: "MCP transport method (stdio or http)",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
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
                CliRulesGenerateParametersSchema,
                result,
                "rules.generate",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.rules || [],
                  generated: result.generated || 0,
                  errors: result.errors || [],
                },
                {
                  command: "rules.generate",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                let output = "";

                if (data.generated > 0) {
                  output += `✅ Generated ${data.generated} rule(s):\n\n`;
                  data.result.forEach((rule: any) => {
                    output += `  📄 ${rule.id} → ${rule.outputPath || rule.path}\n`;
                  });
                } else {
                  output += "ℹ️  No rules were generated.\n";
                }

                if (data.errors && data.errors.length > 0) {
                  output += "\n❌ Errors:\n";
                  data.errors.forEach((error: any) => {
                    output += `  • ${error}\n`;
                  });
                }

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "rules.generate", options);
            }
          },
        },

        "rules.create": {
          parameterSchema: CliRulesCreateParametersSchema,
          parameters: {
            id: {
              asArgument: true,
              description: "Rule ID",
            },
            content: {
              description: "Rule content text",
            },
            name: {
              description: "Rule name",
            },
            description: {
              description: "Rule description",
            },
            format: {
              description: "Rule format (cursor or generic)",
            },
            tags: {
              description: "Comma-separated tags",
            },
            globs: {
              description: "Comma-separated file patterns",
            },
            overwrite: {
              description: "Overwrite existing rule",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
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
                CliRulesCreateParametersSchema,
                result,
                "rules.create",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.rule || result,
                  message: result.quiet ? undefined : "Rule created successfully",
                },
                {
                  command: "rules.create",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "rules.create", options);
            }
          },
        },

        "rules.search": {
          parameterSchema: CliRulesSearchParametersSchema,
          parameters: {
            query: {
              description: "Search query",
            },
            format: {
              description: "Filter by rule format (cursor or generic)",
            },
            tag: {
              description: "Filter by tag",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
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
                CliRulesSearchParametersSchema,
                result,
                "rules.search",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.rules || [], count: (result.rules || []).length },
                {
                  command: "rules.search",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (opts.json) {
                  return JSON.stringify(data.result, null, 2);
                }

                if (!data.result || data.result.length === 0) {
                  return "No matching rules found.";
                }

                let output = `🔍 Found ${data.result.length} matching rule(s):\n\n`;

                data.result.forEach((rule: any, index: number) => {
                  output += `${index + 1}. ${rule.id}\n`;
                  if (rule.name) {
                    output += `   Name: ${rule.name}\n`;
                  }
                  if (rule.description) {
                    output += `   Description: ${rule.description}\n`;
                  }
                  if (rule.format) {
                    output += `   Format: ${rule.format}\n`;
                  }
                  if (rule.tags && rule.tags.length > 0) {
                    output += `   Tags: ${rule.tags.join(", ")}\n`;
                  }
                  output += "\n";
                });

                return output;
              });
            } catch (error) {
              handleStandardizedCliError(error, "rules.search", options);
            }
          },
        },

        "rules.update": {
          parameterSchema: CliRulesUpdateParametersSchema,
          parameters: {
            id: {
              asArgument: true,
              description: "Rule ID",
            },
            content: {
              description: "Updated rule content",
            },
            name: {
              description: "Updated rule name",
            },
            description: {
              description: "Updated rule description",
            },
            format: {
              description: "Updated rule format",
            },
            tags: {
              description: "Updated comma-separated tags",
            },
            globs: {
              description: "Updated comma-separated file patterns",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
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
                CliRulesUpdateParametersSchema,
                result,
                "rules.update",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.rule || result,
                  message: result.quiet ? undefined : "Rule updated successfully",
                },
                {
                  command: "rules.update",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "rules.update", options);
            }
          },
        },
      },
    },
  };
}

/**
 * Migration benefits for rules commands:
 *
 * 1. **Enhanced Rules Management**: Standardized validation for all rule operations
 * 2. **Consistent Output Formatting**: Uniform display of rule information
 * 3. **Advanced Parameter Validation**: Type-safe rule parameter handling
 * 4. **Template Generation Support**: Standardized patterns for rule generation
 * 5. **Search and Discovery**: Enhanced rule search and filtering capabilities
 *
 * Example usage after full integration:
 * ```bash
 * minsky rules list --format cursor --json
 * minsky rules get my-rule --verbose
 * minsky rules generate --interface hybrid --dry-run
 * minsky rules create new-rule --content "Rule content" --tags "validation,types"
 * minsky rules search --query "validation" --tag "typescript"
 * ```
 */ 
