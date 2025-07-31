/**
 * Standardized Git Command Customizations
 *
 * Applies the type composition patterns from Tasks #322 and #329 to git command customizations.
 * Demonstrates standardized parameter handling, response formatting, and error handling.
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import { CliBaseParametersSchema, createCliCommandSchema } from "../schemas/cli-parameter-schemas";
import { createCliSuccessResponse, formatCliOutput } from "../schemas/cli-response-schemas";
import {
  validateCliParameters,
  handleStandardizedCliError,
} from "../utils/standardized-error-handler";
import { z } from "zod";

/**
 * Git-specific parameter schemas
 */
const GitCommitParametersSchema = z.object({
  message: z.string().min(1, "Commit message is required"),
  all: z.boolean().default(false),
  amend: z.boolean().default(false),
  noVerify: z.boolean().default(false),
});

const GitBranchParametersSchema = z.object({
  branchName: z.string().optional(),
  delete: z.boolean().default(false),
  force: z.boolean().default(false),
  merged: z.boolean().default(false),
});

const GitStatusParametersSchema = z.object({
  short: z.boolean().default(false),
  porcelain: z.boolean().default(false),
});

/**
 * CLI git parameter schemas with standardized CLI options
 */
export const CliGitCommitParametersSchema = createCliCommandSchema(GitCommitParametersSchema);
export const CliGitBranchParametersSchema = createCliCommandSchema(GitBranchParametersSchema);
export const CliGitStatusParametersSchema = createCliCommandSchema(GitStatusParametersSchema);

/**
 * Get standardized git command customizations using type composition patterns
 */
export function getStandardizedGitCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.GIT,
    options: {
      commandOptions: {
        "git.commit": {
          // Note: parameterSchema would be used when CLI bridge supports it
          parameterSchema: CliGitCommitParametersSchema,
          parameters: {
            message: {
              alias: "m",
              description: "Commit message",
              asArgument: false,
            },
            all: {
              alias: "a",
              description: "Automatically stage modified and deleted files",
            },
            amend: {
              description: "Amend the previous commit",
            },
            noVerify: {
              description: "Skip pre-commit and commit-msg hooks",
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
                CliGitCommitParametersSchema,
                result,
                "git.commit",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.commit || result,
                  message: result.quiet ? undefined : "Commit created successfully",
                },
                {
                  command: "git.commit",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "git.commit", options);
            }
          },
        },

        "git.branch": {
          parameterSchema: CliGitBranchParametersSchema,
          parameters: {
            branchName: {
              asArgument: true,
              description: "Name of the branch",
            },
            delete: {
              alias: "d",
              description: "Delete the specified branch",
            },
            force: {
              alias: "f",
              description: "Force the operation",
            },
            merged: {
              description: "List branches that have been merged",
            },
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              alias: "q",
              description: "Suppress non-essential output",
            },
          },
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
                CliGitBranchParametersSchema,
                result,
                "git.branch",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.branches || result },
                {
                  command: "git.branch",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) => {
                if (Array.isArray(data.result)) {
                  return data.result
                    .map((branch: any) =>
                      typeof branch === "string" ? branch : branch.name || String(branch)
                    )
                    .join("\n");
                }
                return String(data.result);
              });
            } catch (error) {
              handleStandardizedCliError(error, "git.branch", options);
            }
          },
        },

        "git.status": {
          parameterSchema: CliGitStatusParametersSchema,
          parameters: {
            short: {
              alias: "s",
              description: "Show status in short format",
            },
            porcelain: {
              description: "Show status in porcelain format for scripts",
            },
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              alias: "q",
              description: "Suppress non-essential output",
            },
          },
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
                CliGitStatusParametersSchema,
                result,
                "git.status",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.status || result },
                {
                  command: "git.status",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "git.status", options);
            }
          },
        },

        "git.push": {
          parameters: {
            remote: {
              asArgument: true,
              description: "Remote repository name",
            },
            branch: {
              asArgument: true,
              description: "Branch name to push",
            },
            force: {
              alias: "f",
              description: "Force push",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },

        "git.pull": {
          parameters: {
            remote: {
              asArgument: true,
              description: "Remote repository name",
            },
            branch: {
              asArgument: true,
              description: "Branch name to pull",
            },
            rebase: {
              description: "Use rebase instead of merge",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },
      },
    },
  };
}

/**
 * Migration benefits for git commands:
 *
 * 1. **Consistent Parameter Validation**: All git commands use standardized schemas
 * 2. **Standardized Response Formatting**: Uniform output across all git operations
 * 3. **Enhanced Error Handling**: Proper exit codes and user-friendly error messages
 * 4. **Type Safety**: Full TypeScript validation for git command parameters
 * 5. **Composable Patterns**: Easy to add new git commands using established patterns
 *
 * Example usage after full integration:
 * ```bash
 * minsky git commit -m "Fix bug" --json
 * minsky git branch feature-branch --verbose
 * minsky git status --short --quiet
 * ```
 */
