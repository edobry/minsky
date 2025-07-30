/**
 * Standardized Task Command Customizations
 * 
 * Demonstrates how to apply the type composition patterns from Tasks #322 and #329
 * to existing CLI customizations. This replaces the manual parameter definitions
 * with standardized schema-based patterns.
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import {
  CliTaskListParametersSchema,
  CliTaskGetParametersSchema,
  CliTaskCreateParametersSchema,
  CliTaskDeleteParametersSchema,
} from "../schemas/cli-parameter-schemas";
import {
  formatTaskListOutput,
  createCliSuccessResponse,
  formatCliOutput,
} from "../schemas/cli-response-schemas";
import {
  validateCliParameters,
  handleStandardizedCliError,
} from "../utils/standardized-error-handler";

/**
 * Get standardized task command customizations using type composition patterns
 * 
 * This demonstrates the migration from manual parameter definitions to
 * schema-based validation and standardized response formatting.
 */
export function getStandardizedTasksCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.TASKS,
    options: {
      aliases: ["task"],
      commandOptions: {
        "tasks.list": {
          useFirstRequiredParamAsArgument: false,
          // Note: parameterSchema would be a future enhancement to the CLI bridge
          parameters: {
            filter: {
              alias: "s",
              description: "Filter by task status",
            },
            all: {
              description: "Include completed tasks",
            },
            status: {
              description: "Filter by specific status values",
            },
            completed: {
              description: "Include completed tasks (alias for --all)",
            },
            // Standardized CLI options are automatically included
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
              description: "Show debug output",
            },
          },
          // Standardized output formatter
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              debug: result.debug,
              format: result.format,
              verbosity: result.verbosity,
            };

            // Validate parameters using standardized validation
            try {
              const validatedParams = validateCliParameters(
                CliTaskListParametersSchema,
                result,
                "tasks.list",
                options
              );

              // Create standardized response
              const response = createCliSuccessResponse(
                { result: result.tasks || [], count: (result.tasks || []).length },
                {
                  command: "tasks.list",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              // Use standardized formatter
              formatCliOutput(response, options, (data, opts) => 
                formatTaskListOutput(data.result, opts)
              );

            } catch (error) {
              handleStandardizedCliError(error, "tasks.list", options);
            }
          },
        },

        "tasks.get": {
          // Note: parameterSchema would be a future enhancement to the CLI bridge
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to retrieve",
            },
            section: {
              description: "Specific section of the specification to retrieve",
            },
            // Standardized CLI options are automatically included
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
          // Standardized output formatter
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliTaskGetParametersSchema,
                result,
                "tasks.get",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.task },
                {
                  command: "tasks.get",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);

            } catch (error) {
              handleStandardizedCliError(error, "tasks.get", options);
            }
          },
        },

        "tasks.create": {
          useFirstRequiredParamAsArgument: false,
          // Note: parameterSchema would be a future enhancement to the CLI bridge
          parameters: {
            title: {
              asArgument: false,
              description: "Title for the task",
            },
            description: {
              description: "Description text for the task",
            },
            descriptionPath: {
              description: "Path to file containing task description",
            },
            priority: {
              description: "Task priority level",
            },
            interactive: {
              description: "Interactive task creation",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
            },
            force: {
              description: "Force creation without confirmation",
            },
          },
          // Standardized output formatter
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliTaskCreateParametersSchema,
                result,
                "tasks.create",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.task, message: "Task created successfully" },
                {
                  command: "tasks.create",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);

            } catch (error) {
              handleStandardizedCliError(error, "tasks.create", options);
            }
          },
        },

        "tasks.delete": {
          useFirstRequiredParamAsArgument: true,
          // Note: parameterSchema would be a future enhancement to the CLI bridge
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to delete",
            },
            force: {
              description: "Force deletion without confirmation",
            },
            confirm: {
              description: "Skip confirmation prompt",
            },
            // Standardized CLI options
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              description: "Suppress non-essential output",
            },
          },
          // Standardized output formatter
          outputFormatter: (result: any) => {
            const options = {
              json: result.json,
              quiet: result.quiet,
              verbose: result.verbose,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliTaskDeleteParametersSchema,
                result,
                "tasks.delete",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.deleted, message: "Task deleted successfully" },
                {
                  command: "tasks.delete",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);

            } catch (error) {
              handleStandardizedCliError(error, "tasks.delete", options);
            }
          },
        },

        "tasks.status.get": {
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to get status for",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },

        "tasks.status.set": {
          parameters: {
            taskId: {
              asArgument: true,
              description: "ID of the task to update",
            },
            status: {
              asArgument: true,
              description: "New status for the task (optional, will prompt if omitted)",
            },
            json: {
              description: "Output in JSON format",
            },
            force: {
              description: "Force status change without confirmation",
            },
          },
        },
      },
    },
  };
}

/**
 * Migration guide for applying standardized patterns to existing CLI customizations
 * 
 * This demonstrates the key changes needed to migrate from manual parameter
 * definitions to the standardized type composition patterns:
 * 
 * 1. Replace manual parameter definitions with schema-based validation
 * 2. Use standardized response builders and formatters
 * 3. Apply consistent error handling with proper exit codes
 * 4. Include standardized CLI options automatically
 * 5. Use domain schemas for parameter validation
 * 
 * Benefits of this approach:
 * - Consistent parameter validation across all commands
 * - Standardized response formatting for JSON and human-readable output
 * - Proper error handling with meaningful exit codes
 * - Type safety through Zod schema validation
 * - Reduced code duplication through composable patterns
 * 
 * Example migration:
 * 
 * BEFORE (manual):
 * ```typescript
 * "tasks.list": {
 *   parameters: {
 *     filter: { alias: "s", description: "Filter by task status" },
 *     all: { description: "Include completed tasks" },
 *   },
 *   outputFormatter: (result) => {
 *     if (result.json) {
 *       console.log(JSON.stringify(result, null, 2));
 *     } else {
 *       // Manual formatting logic...
 *     }
 *   }
 * }
 * ```
 * 
 * AFTER (standardized):
 * ```typescript
 * "tasks.list": {
 *   parameterSchema: CliTaskListParametersSchema, // Schema-based validation
 *   outputFormatter: (result) => {
 *     const options = extractCliOptions(result);
 *     const response = createCliSuccessResponse({ result: result.tasks });
 *     formatCliOutput(response, options, formatTaskListOutput); // Standardized formatting
 *   }
 * }
 * ```
 */ 
