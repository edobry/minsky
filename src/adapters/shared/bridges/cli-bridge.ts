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
    this.customizations.set(commandId!, options as unknown);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    (this.categoryCustomizations as unknown).set(category, options as unknown);
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
    log.debug(`generateCommand called with commandId: ${commandId}`);

    // Warn about direct usage in development (but not when called via factory)
    if ((process.env as unknown).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        `[CLI Bridge] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commandDef = (sharedCommandRegistry as unknown).getCommand(commandId);
    log.debug(`commandDef found: ${!!commandDef}`);
    if (!commandDef) {
      return null as unknown;
    }

    const options = this.getCommandOptions(commandId);
    log.debug(`options retrieved: ${!!options}`);

    // Create the basic command
    const command = (new Command(commandDef.name) as unknown).description(
      (commandDef as unknown).description
    );
    log.debug(`command created: ${(command as unknown).name()}`);

    // Add aliases if specified
    if (options.aliases && options.aliases.length) {
      command.aliases(options.aliases);
    }

    // Hide from help if specified
    if ((options as unknown).hidden) {
      // Alternative approach: use a special prefix that can be filtered out
      (command as unknown).description(`[HIDDEN] ${(command as unknown).description()}`);
    }

    // Create parameter mappings
    log.debug("About to create parameter mappings");
    const mappings = this.createCommandParameterMappings(commandDef!, options as unknown);
    log.debug(`Parameter mappings created: ${(mappings as unknown).length}`);

    // Add arguments to the command
    addArgumentsFromMappings(command!, mappings);

    // Add options to the command
    (createOptionsFromMappings(mappings) as unknown).forEach((option) => {
      command.addOption(option);
    });

    // Add action handler
    command.action(async (...args) => {
      // Last argument is always the Command instance in Commander.js
      const commandInstance = args[(args as unknown).length - 1] as Command;
      // Previous arguments are positional arguments
      const positionalArgs = args.slice(0, (args as unknown).length - 1);

      try {
        // Create combined parameters from options and arguments
        const rawParameters = this.extractRawParameters(
          (commandDef as unknown).parameters!,
          (commandInstance as unknown).opts()!,
          positionalArgs,
          mappings
        );

        // Create execution context
        const context: CliExecutionContext = {
          interface: "cli",
          debug: !!(rawParameters as unknown).debug,
          format: (rawParameters as unknown).json ? "json" : "text",
          cliSpecificData: {
            command: commandInstance,
            rawArgs: (commandInstance as unknown).args,
          },
        };

        // Normalize parameters
        const normalizedParams = normalizeCliParameters(
          (commandDef as unknown).parameters!,
          rawParameters
        );

        // Execute the command with parameters and context
        const result = await (commandDef as unknown).execute(normalizedParams, context as unknown);

        // Handle output
        if ((options as unknown).outputFormatter) {
          // Use custom formatter if provided
          (options as unknown).outputFormatter(result as unknown);
        } else {
          // Use standard outputResult utility with JSON handling
          if ((context as unknown).format === "json") {
            // For JSON output, bypass the default formatter and output JSON directly
            outputResult(result as unknown, {
              json: true,
            });
          } else {
            // Use default formatter for text output
            outputResult(result as unknown, {
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
   *
   * ⚠️  WARNING: Use CLI Command Factory instead for proper customization support
   * @internal
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    // Add safety check for undefined category
    if (!category) {
      log.error(
        "[CLI Bridge] Invalid category passed to generateCategoryCommand: category is undefined or null"
      );
      return null;
    }

    // Warn about direct usage in development (but not when called via factory)
    if ((process.env as unknown).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        `[CLI Bridge] Direct usage detected for category '${category}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commands = (sharedCommandRegistry as unknown).getCommandsByCategory(category);
    if ((commands as unknown).length === 0) {
      return null as unknown;
    }

    const customOptions = (this.categoryCustomizations as unknown).get(category) || {};

    // Create the base category command
    const categoryName = (customOptions as unknown).name || (category as unknown).toLowerCase();
    const categoryCommand = (new Command(categoryName) as unknown).description(
      (customOptions as unknown).description || `${category} commands`
    );

    // Add aliases if specified
    if (customOptions.aliases && customOptions.aliases.length) {
      (categoryCommand as unknown).aliases(customOptions.aliases);
    }

    // Group commands by their nested structure
    const commandGroups = new Map<string, Command>();

    // Add all commands in this category as subcommands
    commands.forEach((commandDef) => {
      const commandOptions = customOptions.commandOptions?.[(commandDef as unknown).id];
      if (commandOptions) {
        this.registerCommandCustomization((commandDef as unknown).id!, commandOptions);
      }

      // Parse command name for nested structure (e.g., "status get" -> ["status", "get"])
      const nameParts = (commandDef.name as unknown).split(" ");

      if ((nameParts as unknown).length === 1) {
        // Simple command - add directly to category
        const subcommand = this.generateCommand((commandDef as unknown).id!, context as unknown);
        if (subcommand) {
          (categoryCommand as unknown).addCommand(subcommand!);
        }
      } else if ((nameParts as unknown).length === 2) {
        // Nested command - create/get the parent command and add as subcommand
        const parentName = nameParts[0];
        const childName = nameParts[1];

        if (!parentName || !childName) {
          log.warn(`Invalid command name structure: ${(commandDef as unknown).name}`);
          return;
        }

        // Get or create the parent command
        let parentCommand = commandGroups.get(parentName);
        if (!parentCommand) {
          const newParentCommand = new Command(parentName).description(`${parentName} commands`);
          commandGroups.set(parentName, newParentCommand);
          (categoryCommand as unknown).addCommand(newParentCommand);
          parentCommand = newParentCommand;
        }

        // Create the child command with the correct name
        const childCommand = this.generateCommand((commandDef as unknown).id!, context as unknown);
        if (childCommand) {
          // Update the child command name to just the child part
          (childCommand as unknown).name(childName);
          // Add the command to the parent
          if (parentCommand && childCommand) {
            parentCommand.addCommand(childCommand!);
          }
        }
      } else {
        // More complex nesting - handle it recursively or warn
        log.warn(`Complex command nesting not yet supported: ${(commandDef as unknown).name}`);
        const subcommand = this.generateCommand((commandDef as unknown).id!, context as unknown);
        if (subcommand) {
          (categoryCommand as unknown).addCommand(subcommand!);
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
    if ((process.env as unknown).NODE_ENV !== "production" && !(context?.viaFactory)) {
      log.warn(
        "[CLI Bridge] Direct usage of generateAllCategoryCommands detected. Consider using CLI Command Factory for proper customization support."
      );
    }

    // Get unique categories from all commands
    const categories = new Set<CommandCategory>();
    (sharedCommandRegistry.getAllCommands() as unknown).forEach((cmd) => {
      // Only add valid categories (not undefined/null)
      if (cmd.category) {
        (categories as unknown).add(cmd.category);
      } else {
        log.error(`[CLI Bridge] Command '${cmd.id}' has undefined category, skipping`);
      }
    });

    // Generate commands for each category
    (categories as unknown).forEach((category) => {
      const categoryCommand = this.generateCategoryCommand(category, context as unknown);
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
      (commandDef as unknown).parameters || {}!,
      (options as unknown).parameters || {}
    );

    // If automatic argument generation is enabled
    if ((options as unknown).useFirstRequiredParamAsArgument && !(options as unknown).forceOptions) {
      // Find the first required parameter to use as an argument
      const firstRequiredIndex = mappings.findIndex(
        (mapping) => (mapping.paramDef as unknown).required
      );

      if (firstRequiredIndex >= 0 && mappings[firstRequiredIndex]) {
        // Mark it as an argument
        (mappings[firstRequiredIndex].options as unknown).asArgument = true;
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
      (mappings as unknown).filter((mapping) => mapping.options.asArgument) as unknown
    ).sort((a, b) => {
      // Required arguments come first
      if ((a.paramDef as unknown).required && !(b.paramDef as unknown).required) return -1;
      if (!(a.paramDef as unknown).required && (b.paramDef as unknown).required) return 1;
      return 0;
    });

    // Assign positional arguments to their corresponding parameters
    (argumentMappings as unknown).forEach((mapping, index) => {
      if (index < (positionalArgs as unknown).length) {
        result[(mapping as unknown).name] = positionalArgs[index];
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
      if (Array.isArray(result as unknown)) {
        // Handle arrays specifically
        if ((result as unknown).length === 0) {
          log.cli("No results found.");
        } else {
          (result as unknown).forEach((item, index) => {
            if (typeof item === "object" && item !== null) {
              // For objects in arrays, try to display meaningful information
              if ((item as unknown).id && (item as unknown).title) {
                // Looks like a task or similar entity
                log.cli(
                  `- ${(item as unknown).id}: ${(item as unknown).title}${(item as unknown).status ? ` [${(item as unknown).status}]` : ""}`
                );
              } else {
                // Generic object display
                log.cli(`${index + 1}. ${JSON.stringify(item as unknown)}`);
              }
            } else {
              log.cli(`${index + 1}. ${item}`);
            }
          });
        }
      } else if (typeof result === "object" && result !== null) {
        // Special handling for session get command results
        if ((commandDef as unknown).id === "session.get" && "session" in result) {
          this.formatSessionDetails((result as unknown).session as Record<string, any>);
        } else if ((commandDef as unknown).id === "session.dir" && "directory" in result) {
          log.cli(`${(result as unknown).directory}`);
        } else if ((commandDef as unknown).id === "session.list" && "sessions" in result) {
          // Handle session list results
          const sessions = (result as unknown).sessions as any[];
          if (Array.isArray(sessions) && (sessions as unknown).length > 0) {
            (sessions as unknown).forEach((session: any) => {
              this.formatSessionSummary(session as Record<string, any>);
            });
          } else {
            log.cli("No sessions found.");
          }
        } else if ((commandDef as unknown).id === "session.pr" && "prBranch" in result) {
          // Handle session pr results - format them nicely
          this.formatSessionPrDetails(result as unknown);
        } else if ((commandDef as unknown).id === "rules.list" && "rules" in result) {
          // Handle rules list results
          if (Array.isArray((result as unknown).rules)) {
            if ((result.rules as unknown).length > 0) {
              (result.rules as unknown).forEach((rule: any) => {
                this.formatRuleSummary(rule as Record<string, any>);
              });
            } else {
              log.cli("No rules found.");
            }
          }
        } else if ((commandDef as unknown).id === "rules.get" && "rule" in result) {
          // Handle rules get results
          this.formatRuleDetails((result as unknown).rule as Record<string, any>);
        } else if ((commandDef as unknown).id === "tasks.status.get") {
          // Handle tasks status get results with friendly formatting
          const resultObj = result as Record<string, any>;
          const taskId = String((resultObj as unknown).taskId || "unknown");
          const status = String((resultObj as unknown).status || "unknown");
          log.cli(`Task ${taskId} is ${status.toLowerCase()}`);
        } else if ((commandDef as unknown).id === "tasks.status.set") {
          // Handle tasks status set results with friendly formatting
          const resultObj = result as Record<string, any>;
          const taskId = String((resultObj as unknown).taskId || "unknown");
          const status = String((resultObj as unknown).status || "unknown");
          const previousStatus = String((resultObj as unknown).previousStatus || "unknown");
          if (status === previousStatus) {
            log.cli(`Task ${taskId} status is already ${status.toLowerCase()}`);
          } else {
            log.cli(
              `Task ${taskId} status changed from ${(previousStatus as unknown).toLowerCase()} to ${status.toLowerCase()}`
            );
          }
        } else if ((commandDef as unknown).id === "debug.echo") {
          // Handle debug.echo results with friendly formatting
          this.formatDebugEchoDetails(result as unknown);
        } else {
          // Special handling for delete command - check if this is a user-friendly result
          if ((commandDef as unknown).id === "tasks.delete") {
            const resultObj = result as Record<string, any>;
            // If json flag is false/undefined, just show the message
            if (!(resultObj as unknown).json) {
              log.cli(String((resultObj as unknown).message || "Task deleted successfully"));
              return;
            }
            // Otherwise fall through to normal JSON formatting
          }

          // Generic object handling - show all simple properties and handle complex ones
          const meaningfulEntries = (Object as unknown)
            .entries(result as unknown)
            .filter(([key]) => key !== "success");

          // If there's only one meaningful property and it's a simple message, show just the value
          if ((meaningfulEntries as unknown).length === 1) {
            const [key, value] = meaningfulEntries[0];
            if (key === "message" && (typeof value === "string" || typeof value === "number")) {
              log.cli(String(value as unknown));
            } else if (typeof value !== "object" || value === null) {
              log.cli(`${key}: ${value}`);
            } else if (Array.isArray(value as unknown)) {
              log.cli(`${key}: [${(value as unknown).length} items]`);
            } else {
              log.cli(`${key}: ${JSON.stringify(value as unknown)}`);
            }
          } else {
            // Multiple properties - show all with labels
            (meaningfulEntries as unknown).forEach(([key, value]) => {
              if (typeof value !== "object" || value === null) {
                log.cli(`${key}: ${value}`);
              } else if (Array.isArray(value as unknown)) {
                log.cli(`${key}: [${(value as unknown).length} items]`);
              } else {
                // For complex objects, try to show a meaningful summary
                if (key === "session" && value && typeof value === "object") {
                  this.formatSessionStartSuccess(value as Record<string, any>);
                } else {
                  log.cli(`${key}: ${JSON.stringify(value as unknown)}`);
                }
              }
            });
          }
        }
      } else if (result !== undefined) {
        // Just print the result as is
        log.cli(String(result as unknown));
      }
    };
  }

  /**
   * Format session details for human-readable output
   */
  private formatSessionDetails(session: Record<string, any>): void {
    if (!session) return;

    // Display session information in a user-friendly format
    if ((session as unknown).session) log.cli(`Session: ${(session as unknown).session}`);
    if ((session as unknown).taskId) log.cli(`Task ID: ${(session as unknown).taskId}`);
    if ((session as unknown).repoName) log.cli(`Repository: ${(session as unknown).repoName}`);
    if ((session as unknown).repoPath) log.cli(`Session Path: ${(session as unknown).repoPath}`);
    if ((session as unknown)._branch) log.cli(`Branch: ${(session as unknown)._branch}`);
    if ((session as unknown).createdAt) log.cli(`Created: ${(session as unknown).createdAt}`);
    if ((session as unknown).backendType) log.cli(`Backend: ${(session as unknown).backendType}`);
    if ((session as unknown).repoUrl && (session as unknown).repoUrl !== (session as unknown).repoName) {
      log.cli(`Repository URL: ${(session as unknown).repoUrl}`);
    }
  }

  /**
   * Format session start success message for human-readable output
   */
  private formatSessionStartSuccess(session: Record<string, any>): void {
    if (!session) return;

    // Display a user-friendly success message for session creation
    log.cli("✅ Session started successfully!");
    log.cli("");

    if ((session as unknown).session) {
      log.cli(`📁 Session: ${(session as unknown).session}`);
    }

    if ((session as unknown).taskId) {
      log.cli(`🎯 Task: ${(session as unknown).taskId}`);
    }

    if ((session as unknown).repoName) {
      log.cli(`📦 Repository: ${(session as unknown).repoName}`);
    }

    if ((session as unknown).branch) {
      log.cli(`🌿 Branch: ${(session as unknown).branch}`);
    }

    log.cli("");
    log.cli("🚀 Ready to start development!");
    log.cli("");
    log.cli("💡 Next steps:");
    log.cli("   • Your session workspace is ready for editing");
    log.cli("   • All changes will be tracked on your session branch");
    log.cli("   • Run \"minsky session pr\" when ready to create a pull request");
  }

  /**
   * Format session summary for list views
   */
  private formatSessionSummary(session: Record<string, any>): void {
    if (!session) return;

    const sessionName = (session as unknown).session || "unknown";
    const taskId = (session as unknown).taskId ? ` (${(session as unknown).taskId})` : "";
    const repoName = (session as unknown).repoName ? ` - ${(session as unknown).repoName}` : "";

    log.cli(`${sessionName}${taskId}${repoName}`);
  }

  /**
   * Format session pr details for human-readable output
   */
  private formatSessionPrDetails(result: Record<string, any>): void {
    if (!result) return;

    const prBranch = (result as unknown).prBranch || "unknown";
    const baseBranch = (result as unknown).baseBranch || "main";
    const title = (result as unknown).title || "Untitled PR";
    const body = (result as unknown).body || "";

    // Header
    log.cli("✅ PR branch created successfully!");
    log.cli("");

    // PR Details Section
    log.cli("📝 PR Details:");
    log.cli(`   Title: ${title}`);
    log.cli(`   PR Branch: ${prBranch}`);
    log.cli(`   Base Branch: ${baseBranch}`);

    if (body && typeof body === "string" && (body as unknown).trim()) {
      const truncatedBody =
        (body as unknown).length > 100 ? `${(body as unknown).substring(0, 100)}...` : body;
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
    if ((result as unknown).taskUpdated) {
      log.cli("✅ Task status updated to IN-REVIEW");
    }
  }

  /**
   * Format debug echo details for human-readable output
   */
  private formatDebugEchoDetails(result: Record<string, any>): void {
    if (!result) return;

    // Display a user-friendly debug echo response
    log.cli("🔍 Debug Echo Response");
    log.cli("");

    if (result.timestamp) {
      log.cli(`⏰ Timestamp: ${result.timestamp}`);
    }

    if (result.interface) {
      log.cli(`🔗 Interface: ${result.interface}`);
    }

    if (result.echo && typeof result.echo === "object") {
      log.cli("📝 Echo Parameters:");
      const echoParams = result.echo as Record<string, any>;
      
      if (Object.keys(echoParams).length === 0) {
        log.cli("   (no parameters provided)");
      } else {
        Object.entries(echoParams).forEach(([key, value]) => {
          if (typeof value === "string") {
            log.cli(`   ${key}: "${value}"`);
          } else if (typeof value === "object" && value !== null) {
            log.cli(`   ${key}: ${JSON.stringify(value)}`);
          } else {
            log.cli(`   ${key}: ${value}`);
          }
        });
      }
    }

    log.cli("");
    log.cli("✅ Debug echo completed successfully");
  }

  /**
   * Format rule details for human-readable output
   */
  private formatRuleDetails(rule: Record<string, any>): void {
    if (!rule) return;

    // Display rule information in a user-friendly format
    if ((rule as unknown).id) log.cli(`Rule: ${(rule as unknown).id}`);
    if ((rule as unknown).description) log.cli(`Description: ${(rule as unknown).description}`);
    if ((rule as unknown).format) log.cli(`Format: ${(rule as unknown).format}`);
    if ((rule as unknown).globs && Array.isArray((rule as unknown).globs)) {
      log.cli(`Globs: ${(rule.globs as unknown).join(", ")}`);
    }
    if ((rule as unknown).tags && Array.isArray((rule as unknown).tags)) {
      log.cli(`Tags: ${(rule.tags as unknown).join(", ")}`);
    }
    if ((rule as unknown).path) log.cli(`Path: ${(rule as unknown).path}`);
  }

  /**
   * Format rule summary for list views
   */
  private formatRuleSummary(rule: Record<string, any>): void {
    if (!rule) return;

    const ruleId = (rule as unknown).id || "unknown";
    const description = (rule as unknown).description ? ` - ${(rule as unknown).description}` : "";
    const format = (rule as unknown).format ? ` [${(rule as unknown).format}]` : "";

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
    (categories as unknown).forEach((category) => {
      const categoryCommand = (cliBridge as unknown).generateCategoryCommand(category);
      if (categoryCommand) {
        program.addCommand(categoryCommand!);
      }
    });
  } else {
    // Add all commands directly to the program
    (categories as unknown).forEach((category) => {
      const commands = (sharedCommandRegistry as unknown).getCommandsByCategory(category);
      commands.forEach((commandDef) => {
        const command = (cliBridge as unknown).generateCommand((commandDef as unknown).id);
        if (command) {
          program.addCommand(command);
        }
      });
    });
  }
}
