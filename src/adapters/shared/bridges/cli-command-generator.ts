/**
 * CLI Command Generator
 *
 * This module handles the generation of Commander.js commands from shared command definitions.
 * It provides the core logic for converting shared commands into CLI commands with proper
 * parameter mapping, options handling, and execution context.
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
import {
  formatSessionDetails,
  formatSessionSummary,
  formatSessionPrDetails,
  formatSessionApprovalDetails,
  formatDebugEchoDetails,
  formatRuleDetails,
  formatRuleSummary,
} from "./cli-result-formatters";
import { formatTaskIdForDisplay } from "../../../domain/tasks/task-id-utils";

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
  outputFormatter?: (result: any) => void;
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
 * CLI Command Generator
 *
 * Handles the generation of Commander.js commands from shared command definitions.
 * This class provides the core logic for converting shared commands into CLI commands
 * with proper parameter mapping, options handling, and execution context.
 */
export class CliCommandGenerator {
  private customizations: Map<string, CliCommandOptions> = new Map();
  private categoryCustomizations: Map<CommandCategory, CategoryCommandOptions> = new Map();

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.customizations.set(commandId!, options as any);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    (this.categoryCustomizations as any).set(category, options as any);
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
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    log.debug(`generateCommand called with commandId: ${commandId}`);

    // Warn about direct usage in development (but not when called via factory)
    if ((process.env as any).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        `[CLI Command Generator] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commandDef = (sharedCommandRegistry as any).getCommand(commandId);
    log.debug(`commandDef found: ${!!commandDef}`);
    if (!commandDef) {
      return null as any;
    }

    const options = this.getCommandOptions(commandId);
    log.debug(`options retrieved: ${!!options}`);

    // Create the basic command
    const command = (new Command(commandDef.name) as any).description(
      (commandDef as any).description
    );
    log.debug(`command created: ${(command as any).name()}`);

    // Add aliases if specified
    if (options.aliases && options.aliases.length) {
      command.aliases(options.aliases);
    }

    // Hide from help if specified
    if ((options as any).hidden) {
      // Alternative approach: use a special prefix that can be filtered out
      (command as any).description(`[HIDDEN] ${(command as any).description()}`);
    }

    // Create parameter mappings
    log.debug("About to create parameter mappings");
    const mappings = this.createCommandParameterMappings(commandDef!, options as any);
    log.debug(`Parameter mappings created: ${(mappings as any).length}`);

    // Add arguments to the command
    addArgumentsFromMappings(command!, mappings);

    // Add options to the command
    (createOptionsFromMappings(mappings) as any).forEach((option) => {
      command.addOption(option);
    });

    // Add action handler
    command.action(async (...args) => {
      // Last argument is always the Command instance in Commander.js
      const commandInstance = args[(args as any).length - 1] as Command;
      // Previous arguments are positional arguments
      const positionalArgs = args.slice(0, (args as any).length - 1);

      try {
        // Create combined parameters from options and arguments
        const rawParameters = this.extractRawParameters(
          (commandDef as any).parameters!,
          (commandInstance as any).opts()!,
          positionalArgs,
          mappings
        );

        // Create execution context
        const context: CliExecutionContext = {
          interface: "cli",
          debug: !!(rawParameters as any).debug,
          format: (rawParameters as any).json ? "json" : "text",
          cliSpecificData: {
            command: commandInstance,
            rawArgs: (commandInstance as any).args,
          },
        };

        // Normalize parameters
        const normalizedParams = normalizeCliParameters(
          (commandDef as any).parameters!,
          rawParameters
        );

        // Execute the command with parameters and context
        const result = await (commandDef as any).execute(normalizedParams, context as any);

        // Handle output
        if ((options as any).outputFormatter) {
          // Use custom formatter if provided
          (options as any).outputFormatter(result as any);
        } else {
          // Use standard outputResult utility with JSON handling
          if ((context as any).format === "json") {
            // For JSON output, bypass the default formatter and output JSON directly
            outputResult(result as any, {
              json: true,
            });
          } else {
            // Use default formatter for text output
            outputResult(result as any, {
              json: false,
              formatter: this.getDefaultFormatter(commandDef),
            });
          }
        }
      } catch (error) {
        // Handle any errors using the CLI error handler
        handleCliError(error as any);
      }
    });

    return command;
  }

  /**
   * Generate CLI commands for all commands in a category
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    // Add safety check for undefined category
    if (!category) {
      log.error(
        "[CLI Command Generator] Invalid category passed to generateCategoryCommand: category is undefined or null"
      );
      return null;
    }

    // Warn about direct usage in development (but not when called via factory)
    if ((process.env as any).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        `[CLI Command Generator] Direct usage detected for category '${category}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commands = (sharedCommandRegistry as any).getCommandsByCategory(category);
    if ((commands as any).length === 0) {
      return null as any;
    }

    const customOptions = (this.categoryCustomizations as any).get(category) || {};

    // Create the base category command
    const categoryName = (customOptions as any).name || (category as any).toLowerCase();
    const categoryCommand = (new Command(categoryName) as any).description(
      (customOptions as any).description || `${category} commands`
    );

    // Add aliases if specified
    if (customOptions.aliases && customOptions.aliases.length) {
      (categoryCommand as any).aliases(customOptions.aliases);
    }

    // Group commands by their nested structure
    const commandGroups = new Map<string, Command>();

    // Add all commands in this category as subcommands
    commands.forEach((commandDef) => {
      const commandOptions = customOptions.commandOptions?.[(commandDef as any).id];
      if (commandOptions) {
        this.registerCommandCustomization((commandDef as any).id!, commandOptions);
      }

      // Parse command name for nested structure (e.g., "status get" -> ["status", "get"])
      const nameParts = (commandDef.name as any).split(" ");

      if ((nameParts as any).length === 1) {
        // Simple command - add directly to category
        const subcommand = this.generateCommand((commandDef as any).id!, context as any);
        if (subcommand) {
          (categoryCommand as any).addCommand(subcommand!);
        }
      } else if ((nameParts as any).length === 2) {
        // Nested command - create/get the parent command and add as subcommand
        const parentName = nameParts[0];
        const childName = nameParts[1];

        if (!parentName || !childName) {
          log.warn(`Invalid command name structure: ${(commandDef as any).name}`);
          return;
        }

        // Get or create the parent command
        let parentCommand = commandGroups.get(parentName);
        if (!parentCommand) {
          const newParentCommand = new Command(parentName).description(`${parentName} commands`);
          commandGroups.set(parentName, newParentCommand);
          (categoryCommand as any).addCommand(newParentCommand);
          parentCommand = newParentCommand;
        }

        // Create the child command with the correct name
        const childCommand = this.generateCommand((commandDef as any).id!, context as any);
        if (childCommand) {
          // Update the child command name to just the child part
          (childCommand as any).name(childName);
          // Add the command to the parent
          if (parentCommand && childCommand) {
            parentCommand.addCommand(childCommand!);
          }
        }
      } else {
        // More complex nesting - handle it recursively or warn
        log.warn(`Complex command nesting not yet supported: ${(commandDef as any).name}`);
        const subcommand = this.generateCommand((commandDef as any).id!, context as any);
        if (subcommand) {
          (categoryCommand as any).addCommand(subcommand!);
        }
      }
    });

    return categoryCommand;
  }

  /**
   * Generate CLI commands for all categories
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    // Warn about direct usage in development (but not when called via factory)
    if ((process.env as any).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        "[CLI Command Generator] Direct usage of generateAllCategoryCommands detected. Consider using CLI Command Factory for proper customization support."
      );
    }

    // Get unique categories from all commands
    const categories = new Set<CommandCategory>();
    (sharedCommandRegistry.getAllCommands() as any).forEach((cmd) => {
      // Only add valid categories (not undefined/null)
      if (cmd.category) {
        (categories as any).add(cmd.category);
      } else {
        log.error(`[CLI Command Generator] Command '${cmd.id}' has undefined category, skipping`);
      }
    });

    // Generate commands for each category
    (categories as any).forEach((category) => {
      const categoryCommand = this.generateCategoryCommand(category, context as any);
      if (categoryCommand) {
        program.addCommand(categoryCommand!);
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
    const mappings = createParameterMappings(
      (commandDef as any).parameters || {}!,
      (options as any).parameters || {}
    );

    // If automatic argument generation is enabled
    if ((options as any).useFirstRequiredParamAsArgument && !(options as any).forceOptions) {
      // Find the first required parameter to use as an argument
      const firstRequiredIndex = mappings.findIndex(
        (mapping) => (mapping.paramDef as any).required
      );

      if (firstRequiredIndex >= 0 && mappings[firstRequiredIndex]) {
        // Mark it as an argument
        (mappings[firstRequiredIndex].options as any).asArgument = true;
      }
    }

    return mappings;
  }

  /**
   * Extract raw parameters from CLI options and arguments
   */
  private extractRawParameters(
    parameters: Record<string, any>,
    options: Record<string, any>,
    positionalArgs: any[],
    mappings: ParameterMapping[]
  ): Record<string, any> {
    const result = { ...options };

    // Map positional arguments to parameter names
    const argumentMappings = (
      (mappings as any).filter((mapping) => mapping.options.asArgument) as any
    ).sort((a, b) => {
      // Required arguments come first
      if ((a.paramDef as any).required && !(b.paramDef as any).required) return -1;
      if (!(a.paramDef as any).required && (b.paramDef as any).required) return 1;
      return 0;
    });

    // Assign positional arguments to their corresponding parameters
    (argumentMappings as any).forEach((mapping, index) => {
      if (index < (positionalArgs as any).length) {
        result[(mapping as any).name] = positionalArgs[index];
      }
    });

    return result;
  }

  /**
   * Get a default formatter for command results
   */
  private getDefaultFormatter(commandDef: SharedCommand): (result: any) => void {
    // Very simple default formatter
    return (result: any) => {
      if (Array.isArray(result as any)) {
        // Handle arrays specifically
        if ((result as any).length === 0) {
          log.cli("No results found.");
        } else {
          (result as any).forEach((item, index) => {
            if (typeof item === "object" && item !== null) {
              // For objects in arrays, try to display meaningful information
              if ((item as any).id && (item as any).title) {
                // Looks like a task or similar entity
                log.cli(
                  `- ${formatTaskIdForDisplay((item as any).id)}: ${(item as any).title}${(item as any).status ? ` [${(item as any).status}]` : ""}`
                );
              } else {
                // Generic object display
                log.cli(`${index + 1}. ${JSON.stringify(item as any)}`);
              }
            } else {
              log.cli(`${index + 1}. ${item}`);
            }
          });
        }
      } else if (typeof result === "object" && result !== null) {
        // Special handling for session get command results
        if ((commandDef as any).id === "session.get" && "session" in result) {
          formatSessionDetails((result as any).session as Record<string, any>);
        } else if ((commandDef as any).id === "session.dir" && "directory" in result) {
          log.cli(`${(result as any).directory}`);
        } else if ((commandDef as any).id === "session.list" && "sessions" in result) {
          // Handle session list results
          const sessions = (result as any).sessions as any[];
          if (Array.isArray(sessions) && (sessions as any).length > 0) {
            (sessions as any).forEach((session: any) => {
              formatSessionSummary(session as Record<string, any>);
            });
          } else {
            log.cli("No sessions found.");
          }
        } else if ((commandDef as any).id === "session.pr" && "prBranch" in result) {
          // Handle session pr results - format them nicely
          formatSessionPrDetails(result as any);
        } else if ((commandDef as any).id === "session.approve" && ((result as any).result && "session" in (result as any).result)) {
          // Handle session approve results - format them nicely
          formatSessionApprovalDetails((result as any).result);
        } else if ((commandDef as any).id === "rules.list" && "rules" in result) {
          // Handle rules list results
          if (Array.isArray((result as any).rules)) {
            if ((result.rules as any).length > 0) {
              (result.rules as any).forEach((rule: any) => {
                formatRuleSummary(rule as Record<string, any>);
              });
            } else {
              log.cli("No rules found.");
            }
          }
        } else if ((commandDef as any).id === "rules.get" && "rule" in result) {
          // Handle rules get results
          formatRuleDetails((result as any).rule as Record<string, any>);
        } else if ((commandDef as any).id === "tasks.status.get") {
          // Handle tasks status get results with friendly formatting
          const resultObj = result as Record<string, any>;
          const taskId = String((resultObj as any).taskId || "unknown");
          const status = String((resultObj as any).status || "unknown");
          log.cli(`Task ${formatTaskIdForDisplay(taskId)} is ${status.toLowerCase()}`);
        } else if ((commandDef as any).id === "tasks.status.set") {
          // Handle tasks status set results with friendly formatting
          const resultObj = result as Record<string, any>;
          const taskId = String((resultObj as any).taskId || "unknown");
          const status = String((resultObj as any).status || "unknown");
          const previousStatus = String((resultObj as any).previousStatus || "unknown");
          if (status === previousStatus) {
            log.cli(`Task ${formatTaskIdForDisplay(taskId)} status is already ${status.toLowerCase()}`);
          } else {
            log.cli(
              `Task ${formatTaskIdForDisplay(taskId)} status changed from ${(previousStatus as any).toLowerCase()} to ${status.toLowerCase()}`
            );
          }
        } else if ((commandDef as any).id === "debug.echo") {
          // Handle debug.echo results with friendly formatting
          formatDebugEchoDetails(result as any);
        } else {
          // Special handling for delete command - check if this is a user-friendly result
          if ((commandDef as any).id === "tasks.delete") {
            const resultObj = result as Record<string, any>;
            // If json flag is false/undefined, just show the message
            if (!(resultObj as any).json) {
              log.cli(String((resultObj as any).message || "Task deleted successfully"));
              return;
            }
            // Otherwise fall through to normal JSON formatting
          }

          // Generic object handling - show all simple properties and handle complex ones
          const meaningfulEntries = (Object as any)
            .entries(result as any)
            .filter(([key]) => key !== "success");

          // If there's only one meaningful property and it's a simple message, show just the value
          if ((meaningfulEntries as any).length === 1) {
            const [key, value] = meaningfulEntries[0];
            if (key === "message" && (typeof value === "string" || typeof value === "number")) {
              log.cli(String(value as any));
            } else if (typeof value !== "object" || value === null) {
              log.cli(`${key}: ${value}`);
            } else if (Array.isArray(value as any)) {
              log.cli(`${key}: [${(value as any).length} items]`);
            } else {
              log.cli(`${key}: ${JSON.stringify(value as any)}`);
            }
          } else {
            // Multiple properties - show all with labels
            (meaningfulEntries as any).forEach(([key, value]) => {
              if (typeof value !== "object" || value === null) {
                log.cli(`${key}: ${value}`);
              } else if (Array.isArray(value as any)) {
                log.cli(`${key}: [${(value as any).length} items]`);
              } else {
                // For complex objects, try to show a meaningful summary
                if (key === "session" && value && typeof value === "object") {
                  this.formatSessionStartSuccess(value as Record<string, any>);
                } else {
                  log.cli(`${key}: ${JSON.stringify(value as any)}`);
                }
              }
            });
          }
        }
      } else if (result !== undefined) {
        // Just print the result as is
        log.cli(String(result as any));
      }
    };
  }

  /**
   * Format session start success message for human-readable output
   */
  private formatSessionStartSuccess(session: Record<string, any>): void {
    if (!session) return;

    // Display a user-friendly success message for session creation
    log.cli("✅ Session started successfully!");
    log.cli("");

    if ((session as any).session) {
      log.cli(`📁 Session: ${(session as any).session}`);
    }

    if ((session as any).taskId) {
      log.cli(`🎯 Task: ${(session as any).taskId}`);
    }

    if ((session as any).repoName) {
      log.cli(`📦 Repository: ${(session as any).repoName}`);
    }

    if ((session as any).branch) {
      log.cli(`🌿 Branch: ${(session as any).branch}`);
    }

    log.cli("");
    log.cli("🚀 Ready to start development!");
    log.cli("");
    log.cli("💡 Next steps:");
    log.cli("   • Your session workspace is ready for editing");
    log.cli("   • All changes will be tracked on your session branch");
    log.cli("   • Run \"minsky session pr\" when ready to create a pull request");
  }
}

/**
 * Default exported instance for the CLI command generator
 */
export const cliCommandGenerator = new CliCommandGenerator();
