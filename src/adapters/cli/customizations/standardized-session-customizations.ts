/**
 * Standardized Session Command Customizations
 *
 * Applies the type composition patterns from Tasks #322 and #329 to session command customizations.
 * Demonstrates standardized parameter handling, response formatting, and error handling.
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";
import {
  CliSessionListParametersSchema,
  CliSessionGetParametersSchema,
  CliSessionCreateParametersSchema,
  CliSessionDeleteParametersSchema,
  CliSessionUpdateParametersSchema,
  createCliCommandSchema,
} from "../schemas/cli-parameter-schemas";
import {
  createCliSuccessResponse,
  formatCliOutput,
  formatSessionListOutput,
} from "../schemas/cli-response-schemas";
import {
  validateCliParameters,
  handleStandardizedCliError,
} from "../utils/standardized-error-handler";
import { z } from "zod";
import { log } from "../../../utils/logger";

/**
 * Session-specific parameter schemas for advanced operations
 */
const SessionPRParametersSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  bodyPath: z.string().optional(),
  name: z.string().optional(),
  task: z.string().optional(),
  skipUpdate: z.boolean().default(false),
  noStatusUpdate: z.boolean().default(false),
  debug: z.boolean().default(false),
  autoResolveDeleteConflicts: z.boolean().default(false),
  skipConflictCheck: z.boolean().default(false),
  advanced: z.boolean().default(false),
});

const SessionApproveParametersSchema = z.object({
  name: z.string().optional(),
  task: z.string().optional(),
  force: z.boolean().default(false),
});

/**
 * CLI session parameter schemas with standardized CLI options
 */
export const CliSessionPRParametersSchema = createCliCommandSchema(SessionPRParametersSchema);
export const CliSessionApproveParametersSchema = createCliCommandSchema(
  SessionApproveParametersSchema
);

/**
 * Get standardized session command customizations using type composition patterns
 */
export function getStandardizedSessionCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.SESSION,
    options: {
      aliases: ["sess"],
      commandOptions: {
        "session.list": {
          aliases: ["ls"],
          useFirstRequiredParamAsArgument: false,
          parameterSchema: CliSessionListParametersSchema,
          parameters: {
            verbose: {
              alias: "v",
              description: "Show detailed session information",
            },
            current: {
              description: "Show only current session",
            },
            showPaths: {
              description: "Show session workspace paths",
            },
            // Standardized CLI options
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
              debug: result.debug,
              format: result.format,
              verbosity: result.verbosity,
            };

            try {
              const validatedParams = validateCliParameters(
                CliSessionListParametersSchema,
                result,
                "session.list",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.sessions || [],
                  count: (result.sessions || []).length,
                },
                {
                  command: "session.list",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options, (data, opts) =>
                formatSessionListOutput(data.result, opts)
              );
            } catch (error) {
              handleStandardizedCliError(error, "session.list", options);
            }
          },
        },

        "session.start": {
          parameterSchema: CliSessionCreateParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description:
                "Task ID to associate with the session (required if --description not provided)",
            },
            description: {
              alias: "d",
              description: "Description for auto-created task (required if --task not provided)",
            },
            autoStart: {
              description: "Automatically start the session",
            },
            clone: {
              description: "Clone repository into session workspace",
            },
            json: {
              description: "Output in JSON format",
            },
            quiet: {
              description: "Suppress non-essential output",
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

            // Check if JSON output was requested
            if (options.json) {
              log.cli(JSON.stringify(result, null, 2));
              return;
            }

            // Check if quiet mode was requested
            if (options.quiet) {
              // In quiet mode, only output session directory path
              if (result.session) {
                const sessionDir = `/Users/edobry/.local/state/minsky/sessions/${result.session.session}`;
                log.cli(sessionDir);
              }
              return;
            }

            try {
              const validatedParams = validateCliParameters(
                CliSessionCreateParametersSchema,
                result,
                "session.start",
                options
              );

              // Format the session start success message
              if (result.success && result.session) {
                log.cli("✅ Session started successfully!");
                log.cli("");

                if (result.session.session) {
                  log.cli(`📁 Session: ${result.session.session}`);
                }

                if (result.session.taskId) {
                  log.cli(`🎯 Task: ${result.session.taskId}`);
                }

                if (result.session.repoName) {
                  log.cli(`📦 Repository: ${result.session.repoName}`);
                }

                if (result.session.branch) {
                  log.cli(`🌿 Branch: ${result.session.branch}`);
                }

                log.cli("");
                log.cli("🚀 Ready to start development!");
                log.cli("");
                log.cli("💡 Next steps:");
                log.cli("   • Your session workspace is ready for editing");
                log.cli("   • All changes will be tracked on your session branch");
                log.cli('   • Run "minsky session pr" when ready to create a pull request');
              } else {
                // Fallback to JSON output if result structure is unexpected
                log.cli(JSON.stringify(result, null, 2));
              }
            } catch (error) {
              handleStandardizedCliError(error, "session.start", options);
            }
          },
        },

        "session.get": {
          parameterSchema: CliSessionGetParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
            showPath: {
              description: "Show session workspace path",
            },
            json: {
              description: "Output in JSON format",
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
                CliSessionGetParametersSchema,
                result,
                "session.get",
                options
              );

              const response = createCliSuccessResponse(
                { result: result.session || result },
                {
                  command: "session.get",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "session.get", options);
            }
          },
        },

        "session.dir": {
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },

        "session.delete": {
          parameterSchema: CliSessionDeleteParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
            deleteWorkspace: {
              description: "Also delete session workspace",
            },
            force: {
              description: "Force deletion without confirmation",
            },
            json: {
              description: "Output in JSON format",
            },
            quiet: {
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
                CliSessionDeleteParametersSchema,
                result,
                "session.delete",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.deleted || true,
                  message: result.quiet ? undefined : "Session deleted successfully",
                },
                {
                  command: "session.delete",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "session.delete", options);
            }
          },
        },

        "session.update": {
          parameterSchema: CliSessionUpdateParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
            pull: {
              description: "Pull latest changes from main branch",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },

        "session.approve": {
          parameterSchema: CliSessionApproveParametersSchema,
          parameters: {
            name: {
              asArgument: true,
              description: "Session name (optional, alternative to --task)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session",
            },
            force: {
              description: "Force approval without confirmation",
            },
            json: {
              description: "Output in JSON format",
            },
          },
        },

        "session.pr": {
          useFirstRequiredParamAsArgument: false,
          parameterSchema: CliSessionPRParametersSchema,
          parameters: {
            // === CORE PARAMETERS (Always visible) ===
            title: {
              description: "Title for the PR (auto-generated if not provided)",
            },
            body: {
              description: "Body text for the PR",
            },
            bodyPath: {
              description: "Path to file containing PR body text",
            },
            name: {
              description: "Session name (auto-detected from workspace if not provided)",
            },
            task: {
              alias: "t",
              description: "Task ID associated with the session (auto-detected if not provided)",
            },

            // === PROGRESSIVE DISCLOSURE CONTROL ===
            advanced: {
              description: "Show advanced options for conflict resolution and debugging",
            },

            // === ADVANCED PARAMETERS (Expert-level control) ===
            skipUpdate: {
              description: "Skip session update before creating PR (use with --advanced)",
            },
            noStatusUpdate: {
              description: "Skip updating task status (use with --advanced)",
            },
            debug: {
              description: "Enable debug output (use with --advanced)",
            },
            autoResolveDeleteConflicts: {
              description: "Auto-resolve delete/modify conflicts (use with --advanced)",
            },
            skipConflictCheck: {
              description: "Skip proactive conflict detection (use with --advanced)",
            },
            json: {
              description: "Output in JSON format",
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
                CliSessionPRParametersSchema,
                result,
                "session.pr",
                options
              );

              const response = createCliSuccessResponse(
                {
                  result: result.pr || result,
                  message: result.quiet ? undefined : "Pull request created successfully",
                },
                {
                  command: "session.pr",
                  format: options.format || "text",
                  verbosity: options.verbosity || "normal",
                }
              );

              formatCliOutput(response, options);
            } catch (error) {
              handleStandardizedCliError(error, "session.pr", options);
            }
          },
        },
      },
    },
  };
}

/**
 * Migration benefits for session commands:
 *
 * 1. **Enhanced Session Management**: Standardized validation for session operations
 * 2. **Consistent Output Formatting**: Uniform session information display
 * 3. **Advanced Parameter Validation**: Type-safe session parameter handling
 * 4. **Progressive Disclosure**: Advanced options hidden behind --advanced flag
 * 5. **Error Recovery**: Helpful suggestions for session-related issues
 *
 * Example usage after full integration:
 * ```bash
 * minsky session start --task 123 --json
 * minsky session list --current --verbose
 * minsky session pr --title "Fix bug" --body-path ./pr-description.md
 * ```
 */
