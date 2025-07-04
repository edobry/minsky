/**
 * CLI Bridge
 *
 * This module bridges the shared command registry with the Commander.js CLI,
 * enabling automatic generation of CLI commands from shared command definitions.
 */
import { Command } from "commander";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type SharedCommand,
} from "../command-registry";

import { handleCliError, outputResult } from "../../cli/utils/index";
import { log } from "../../../utils/logger";
import {
  type ParameterMapping,
  type ParameterMappingOptions,
  createParameterMappings,
  createOptionsFromMappings,
  addArgumentsFromMappings,
  normalizeCliParameters,
} from "./parameter-mapper";

/**
 * CLI-specific execution context
 */
export interface CliExecutionContext extends CommandExecutionContext {
  interface: "cli";
  cliSpecificData?: {
    command?: Command;
    rawArgs?: string[];
  };
}

/**
 * Options for customizing a CLI command
 */
export interface CliCommandOptions {
  /** Whether to automatically use first required parameter as command argument */
  useFirstRequiredParamAsArgument?: boolean;
  /** Custom parameter mapping options */
  parameters?: Record<string, ParameterMappingOptions>;
  /** Custom help text */
  helpText?: string;
  /** Command aliases */
  aliases?: string[];
  /** Whether to hide the command from help */
  hidden?: boolean;
  /** Whether to force the use of options instead of arguments */
  forceOptions?: boolean;
  /** Custom examples to show in help */
  examples?: string[];
  /** Custom output formatter */
  outputFormatter?: (result: unknown) => void;
}

/**
 * Options for creating a category command
 */
export interface CategoryCommandOptions {
  /** Override category name */
  name?: string;
  /** Override category description */
  description?: string;
  /** Command aliases */
  aliases?: string[];
  /** Custom options for specific commands */
  commandOptions?: Record<string, CliCommandOptions>;
  /** Whether to use category name as command prefix */
  usePrefix?: boolean;
}

/**
 * Main CLI bridge class
 *
 * Handles conversion of shared commands to Commander.js commands
 *
 * ⚠️  WARNING: This class should not be used directly in most cases.
 * Use the CLI Command Factory instead to ensure proper customizations are applied.
 *
 * @internal - This class is intended to be used through the CLI Command Factory
 */
export class CliCommandBridge {
  private customizations: Map<string, CliCommandOptions> = new Map();
  private categoryCustomizations: Map<CommandCategory, CategoryCommandOptions> = new Map();

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.customizations.set(commandId, options);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.categoryCustomizations.set(category, options);
  }

  /**
   * Get combined command options (defaults + customizations)
   */
  private getCommandOptions(commandId: string): CliCommandOptions {
    const defaults: CliCommandOptions = {
      useFirstRequiredParamAsArgument: true,
      parameters: {},
      hidden: false,
      forceOptions: false,
    };

    return {
      ...defaults,
      ...this.customizations.get(commandId),
    };
  }

  /**
   * Generate a CLI command from a shared command definition
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    log.systemDebug(`generateCommand called with commandId: ${commandId}`);

    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        `[CLI Bridge] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commandDef = sharedCommandRegistry.getCommand(commandId);
    log.systemDebug(`commandDef found: ${!!commandDef}`);
    if (!commandDef) {
      return null;
    }

    const options = this.getCommandOptions(commandId);
    log.systemDebug(`options retrieved: ${!!options}`);

    // Create the basic command
    const command = new Command(commandDef.name).description(commandDef.description);
    log.systemDebug(`command created: ${command.name()}`);

    // Add aliases if specified
    if (options.aliases?.length) {
      command.aliases(options.aliases);
    }

    // Hide from help if specified
    if (options.hidden) {
      // Alternative approach: use a special prefix that can be filtered out
      command.description(`[HIDDEN] ${command.description()}`);
    }

    // Create parameter mappings
    log.systemDebug("About to create parameter mappings");
    const mappings = this.createCommandParameterMappings(commandDef, options);
    log.systemDebug(`Parameter mappings created: ${mappings.length}`);

    // Add arguments to the command
    addArgumentsFromMappings(command, mappings);

    // Add options to the command
    createOptionsFromMappings(mappings).forEach((option) => {
      command.addOption(option);
    });

    // Add action handler
    command.action(async (...args) => {
      // Last argument is always the Command instance in Commander.js
      const commandInstance = args[args.length - 1] as Command;
      // Previous arguments are positional arguments
      const positionalArgs = args.slice(0, args.length - 1);

      try {
        // Create combined parameters from options and arguments
        const rawParameters = this.extractRawParameters(
          commandDef.parameters,
          commandInstance.opts(),
          positionalArgs,
          mappings
        );

        // Create execution context
        const context: CliExecutionContext = {
          interface: "cli",
          debug: !!rawParameters.debug,
          format: rawParameters.json ? "json" : "text",
          cliSpecificData: {
            command: commandInstance,
            rawArgs: commandInstance.args,
          },
        };

        // Normalize parameters
        const normalizedParams = normalizeCliParameters(commandDef.parameters, rawParameters);

        // Execute the command with parameters and context
        const result = await commandDef.execute(normalizedParams, context);

        // Handle output
        if (options.outputFormatter) {
          // Use custom formatter if provided
          options.outputFormatter(result);
        } else {
          // Use standard outputResult utility with JSON handling
          if (context.format === "json") {
            // For JSON output, bypass the default formatter and output JSON directly
            outputResult(result, {
              json: true,
            });
          } else {
            // Use default formatter for text output
            outputResult(result, {
              json: false,
              formatter: this.getDefaultFormatter(commandDef),
            });
          }
        }
      } catch (error) {
        // Handle any errors using the CLI error handler
        handleCliError(error);
      }
    });

    return command;
  }

  /**
   * Generate CLI commands for all commands in a category
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        `[CLI Bridge] Direct usage detected for category '${category}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commands = sharedCommandRegistry.getCommandsByCategory(category);
    if (commands.length === 0) {
      return null;
    }

    const customOptions = this.categoryCustomizations.get(category) || {};

    // Create the base category command
    const categoryName = customOptions.name || category.toLowerCase();
    const categoryCommand = new Command(categoryName).description(
      customOptions.description || `${category} commands`
    );

    // Add aliases if specified
    if (customOptions.aliases?.length) {
      categoryCommand.aliases(customOptions.aliases);
    }

    // Group commands by their nested structure
    const commandGroups = new Map<string, Command>();

    // Add all commands in this category as subcommands
    commands.forEach((commandDef) => {
      const commandOptions = customOptions.commandOptions?.[commandDef.id];
      if (commandOptions) {
        this.registerCommandCustomization(commandDef.id, commandOptions);
      }

      // Parse command name for nested structure (e.g., "status get" -> ["status", "get"])
      const nameParts = commandDef.name.split(" ");

      if (nameParts.length === 1) {
        // Simple command - add directly to category
        const subcommand = this.generateCommand(commandDef.id, context);
        if (subcommand) {
          categoryCommand.addCommand(subcommand);
        }
      } else if (nameParts.length === 2) {
        // Nested command - create/get the parent command and add as subcommand
        const parentName = nameParts[0];
        const childName = nameParts[1];

        if (!parentName || !childName) {
          log.warn(`Invalid command name structure: ${commandDef.name}`);
          return;
        }

        // Get or create the parent command
        let parentCommand = commandGroups.get(parentName);
        if (!parentCommand) {
          parentCommand = new Command(parentName).description(`${parentName} commands`);
          commandGroups.set(parentName, parentCommand);
          categoryCommand.addCommand(parentCommand);
        }

        // Create the child command with the correct name
        const childCommand = this.generateCommand(commandDef.id, context);
        if (childCommand) {
          // Update the child command name to just the child part
          childCommand.name(childName);
          parentCommand.addCommand(childCommand);
        }
      } else {
        // More complex nesting - handle it recursively or warn
        log.warn(`Complex command nesting not yet supported: ${commandDef.name}`);
        const subcommand = this.generateCommand(commandDef.id, context);
        if (subcommand) {
          categoryCommand.addCommand(subcommand);
        }
      }
    });

    return categoryCommand;
  }

  /**
   * Generate CLI commands for all categories
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        "[CLI Bridge] Direct usage of generateAllCategoryCommands detected. Consider using CLI Command Factory for proper customization support."
      );
    }

    // Get unique categories from all commands
    const categories = new Set<CommandCategory>();
    sharedCommandRegistry.getAllCommands().forEach((cmd) => {
      categories.add(cmd.category);
    });

    // Generate commands for each category
    categories.forEach((category) => {
      const categoryCommand = this.generateCategoryCommand(category, context);
      if (categoryCommand) {
        program.addCommand(categoryCommand);
      }
    });
  }

  /**
   * Create parameter mappings for a command
   */
  private createCommandParameterMappings(
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): ParameterMapping[] {
    const mappings = createParameterMappings(commandDef.parameters || {}, options.parameters || {});

    // If automatic argument generation is enabled
    if (options.useFirstRequiredParamAsArgument && !options.forceOptions) {
      // Find the first required parameter to use as an argument
      const firstRequiredIndex = mappings.findIndex((mapping) => mapping.paramDef.required);

      if (firstRequiredIndex >= 0 && mappings[firstRequiredIndex]) {
        // Mark it as an argument
        mappings[firstRequiredIndex].options.asArgument = true;
      }
    }

    return mappings;
  }

  /**
   * Extract raw parameters from CLI options and arguments
   */
  private extractRawParameters(
    parameters: Record<string, unknown>,
    options: Record<string, unknown>,
    positionalArgs: unknown[],
    mappings: ParameterMapping[]
  ): Record<string, unknown> {
    const result = { ...options };

    // Map positional arguments to parameter names
    const argumentMappings = mappings
      .filter((mapping) => mapping.options.asArgument)
      .sort((a, b) => {
        // Required arguments come first
        if (a.paramDef.required && !b.paramDef.required) return -1;
        if (!a.paramDef.required && b.paramDef.required) return 1;
        return 0;
      });

    // Assign positional arguments to their corresponding parameters
    argumentMappings.forEach((mapping, index) => {
      if (index < positionalArgs.length) {
        result[mapping.name] = positionalArgs[index];
      }
    });

    return result;
  }

  /**
   * Get a default formatter for command results
   */
  private getDefaultFormatter(commandDef: SharedCommand): (result: unknown) => void {
    // Very simple default formatter
    return (result: unknown) => {
      if (Array.isArray(result)) {
        // Handle arrays specifically
        if (result.length === 0) {
          log.cli("No results found.");
        } else {
          result.forEach((item, index) => {
            if (typeof item === "object" && item !== null) {
              // For objects in arrays, try to display meaningful information
              if (item.id && item.title) {
                // Looks like a task or similar entity
                log.cli(`- ${item.id}: ${item.title}${item.status ? ` [${item.status}]` : ""}`);
              } else {
                // Generic object display
                log.cli(`${index + 1}. ${JSON.stringify(item)}`);
              }
            } else {
              log.cli(`${index + 1}. ${item}`);
            }
          });
        }
      } else if (typeof result === "object" && result !== null) {
        // Special handling for session get command results
        if (commandDef.id === "session.get" && "session" in result) {
          this.formatSessionDetails(result.session as Record<string, unknown>);
        } else if (commandDef.id === "session.dir" && "directory" in result) {
          log.cli(`${result.directory}`);
        } else if (commandDef.id === "session.list" && "sessions" in result) {
          // Handle session list results
          const sessions = result.sessions as unknown[];
          if (Array.isArray(sessions) && sessions.length > 0) {
            sessions.forEach((session: unknown) => {
              this.formatSessionSummary(session as Record<string, unknown>);
            });
          } else {
            log.cli("No sessions found.");
          }
        } else if (commandDef.id === "session.pr" && "prBranch" in result) {
          // Handle session pr results - format them nicely
          this.formatSessionPrDetails(result);
        } else if (commandDef.id === "rules.list" && "rules" in result) {
          // Handle rules list results
          if (Array.isArray(result.rules)) {
            if (result.rules.length > 0) {
              result.rules.forEach((rule: unknown) => {
                this.formatRuleSummary(rule as Record<string, unknown>);
              });
            } else {
              log.cli("No rules found.");
            }
          }
        } else if (commandDef.id === "rules.get" && "rule" in result) {
          // Handle rules get results
          this.formatRuleDetails(result.rule as Record<string, unknown>);
        } else if (commandDef.id === "tasks.status.get") {
          // Handle tasks status get results with friendly formatting
          const resultObj = result as Record<string, unknown>;
          const taskId = String(resultObj.taskId || "unknown");
          const status = String(resultObj.status || "unknown");
          log.cli(`Task ${taskId} is ${status.toLowerCase()}`);
        } else if (commandDef.id === "tasks.status.set") {
          // Handle tasks status set results with friendly formatting
          const resultObj = result as Record<string, unknown>;
          const taskId = String(resultObj.taskId || "unknown");
          const status = String(resultObj.status || "unknown");
          const previousStatus = String(resultObj.previousStatus || "unknown");
          if (status === previousStatus) {
            log.cli(`Task ${taskId} status is already ${status.toLowerCase()}`);
          } else {
            log.cli(
              `Task ${taskId} status changed from ${previousStatus.toLowerCase()} to ${status.toLowerCase()}`
            );
          }
        } else {
          // Special handling for delete command - check if this is a user-friendly result
          if (commandDef.id === "tasks.delete") {
            const resultObj = result as Record<string, unknown>;
            // If json flag is false/undefined, just show the message
            if (!resultObj.json) {
              log.cli(String(resultObj.message || "Task deleted successfully"));
              return;
            }
            // Otherwise fall through to normal JSON formatting
          }

          // Generic object handling - show all simple properties and handle complex ones
          const meaningfulEntries = Object.entries(result).filter(([key]) => key !== "success");

          // If there's only one meaningful property and it's a simple message, show just the value
          if (meaningfulEntries.length === 1) {
            const [key, value] = meaningfulEntries[0]!;
            if (key === "message" && (typeof value === "string" || typeof value === "number")) {
              log.cli(String(value));
            } else if (typeof value !== "object" || value === null) {
              log.cli(`${key}: ${value}`);
            } else if (Array.isArray(value)) {
              log.cli(`${key}: [${value.length} items]`);
            } else {
              log.cli(`${key}: ${JSON.stringify(value)}`);
            }
          } else {
            // Multiple properties - show all with labels
            meaningfulEntries.forEach(([key, value]) => {
              if (typeof value !== "object" || value === null) {
                log.cli(`${key}: ${value}`);
              } else if (Array.isArray(value)) {
                log.cli(`${key}: [${value.length} items]`);
              } else {
                // For complex objects, try to show a meaningful summary
                if (key === "session" && value && typeof value === "object") {
                  this.formatSessionDetails(value as Record<string, unknown>);
                } else {
                  log.cli(`${key}: ${JSON.stringify(value)}`);
                }
              }
            });
          }
        }
      } else if (result !== undefined) {
        // Just print the result as is
        log.cli(String(result));
      }
    };
  }

  /**
   * Format session details for human-readable output
   */
  private formatSessionDetails(session: Record<string, unknown>): void {
    if (!session) return;

    // Display session information in a user-friendly format
    if (session.session) log.cli(`Session: ${session.session}`);
    if (session._taskId) log.cli(`Task ID: ${session._taskId}`);
    if (session.repoName) log.cli(`Repository: ${session.repoName}`);
    if (session.repoPath) log.cli(`Session Path: ${session.repoPath}`);
    if (session._branch) log.cli(`Branch: ${session._branch}`);
    if (session.createdAt) log.cli(`Created: ${session.createdAt}`);
    if (session.backendType) log.cli(`Backend: ${session.backendType}`);
    if (session.repoUrl && session.repoUrl !== session.repoName) {
      log.cli(`Repository URL: ${session.repoUrl}`);
    }
  }

  /**
   * Format session summary for list views
   */
  private formatSessionSummary(session: Record<string, unknown>): void {
    if (!session) return;

    const sessionName = session.session || "unknown";
    const taskId = session.taskId ? ` (${session.taskId})` : "";
    const repoName = session.repoName ? ` - ${session.repoName}` : "";

    log.cli(`${sessionName}${taskId}${repoName}`);
  }

  /**
   * Format session pr details for human-readable output
   */
  private formatSessionPrDetails(result: Record<string, unknown>): void {
    if (!result) return;

    const prBranch = result.prBranch || "unknown";
    const baseBranch = result.baseBranch || "main";
    const title = result.title || "Untitled PR";
    const body = result.body || "";

    // Header
    log.cli("✅ PR branch created successfully!");
    log.cli("");

    // PR Details Section
    log.cli("📝 PR Details:");
    log.cli(`   Title: ${title}`);
    log.cli(`   PR Branch: ${prBranch}`);
    log.cli(`   Base Branch: ${baseBranch}`);

    if (body && typeof body === "string" && body.trim()) {
      const truncatedBody = body.length > 100 ? `${body.substring(0, 100)  }...` : body;
      log.cli(`   Body: ${truncatedBody}`);
    }
    log.cli("");

    // Next Steps Section
    log.cli("🚀 Next Steps:");
    log.cli("   1. Review the PR branch in your repository");
    log.cli("   2. Create a pull request in your Git hosting platform (GitHub, GitLab, etc.)");
    log.cli("   3. Request reviews from team members");
    log.cli("   4. Merge the PR when approved");
    log.cli("");

    // Commands Section
    log.cli("📋 Useful Commands:");
    log.cli(`   • View PR branch: git checkout ${prBranch}`);
    log.cli("   • Approve and merge: minsky session approve");
    log.cli(`   • Switch back to main: git checkout ${baseBranch}`);
    log.cli("");

    // Status message
    if (result.taskUpdated) {
      log.cli("✅ Task status updated to IN-REVIEW");
    }
  }

  /**
   * Format rule details for human-readable output
   */
  private formatRuleDetails(rule: Record<string, unknown>): void {
    if (!rule) return;

    // Display rule information in a user-friendly format
    if (rule.id) log.cli(`Rule: ${rule.id}`);
    if (rule.description) log.cli(`Description: ${rule.description}`);
    if (rule.format) log.cli(`Format: ${rule.format}`);
    if (rule.globs && Array.isArray(rule.globs)) {
      log.cli(`Globs: ${rule.globs.join(", ")}`);
    }
    if (rule.tags && Array.isArray(rule.tags)) {
      log.cli(`Tags: ${rule.tags.join(", ")}`);
    }
    if (rule.path) log.cli(`Path: ${rule.path}`);
  }

  /**
   * Format rule summary for list views
   */
  private formatRuleSummary(rule: Record<string, unknown>): void {
    if (!rule) return;

    const ruleId = rule.id || "unknown";
    const description = rule.description ? ` - ${rule.description}` : "";
    const format = rule.format ? ` [${rule.format}]` : "";

    log.cli(`${ruleId}${format}${description}`);
  }
}

/**
 * Default exported instance for the CLI bridge
 * This singleton is used by the CLI to generate commands from the shared registry
 */
export const cliBridge = new CliCommandBridge();

/**
 * Register categorized CLI commands to a Commander.js program
 *
 * @param program The Commander.js program to add commands to
 * @param categories Array of command categories to register
 * @param createSubcommands Whether to create category subcommands
 */
export function registerCategorizedCliCommands(
  program: Command,
  categories: CommandCategory[],
  createSubcommands: boolean = true
): void {
  if (createSubcommands) {
    // Create category-based subcommands
    categories.forEach((category) => {
      const categoryCommand = cliBridge.generateCategoryCommand(category);
      if (categoryCommand) {
        program.addCommand(categoryCommand);
      }
    });
  } else {
    // Add all commands directly to the program
    categories.forEach((category) => {
      const commands = sharedCommandRegistry.getCommandsByCategory(category);
      commands.forEach((commandDef) => {
        const command = cliBridge.generateCommand(commandDef.id);
        if (command) {
          program.addCommand(command);
        }
      });
    });
  }
}
