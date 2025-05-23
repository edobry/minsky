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
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
  type SharedCommand,
} from "../command-registry.js";
import { getErrorHandler } from "../error-handling.js";
import { ensureError } from "../../../errors/index.js";
import { handleCliError, outputResult } from "../../cli/utils/index.js";
import { log } from "../../../utils/logger.js";
import {
  type ParameterMapping,
  type ParameterMappingOptions,
  createParameterMappings,
  createOptionsFromMappings,
  addArgumentsFromMappings,
  normalizeCliParameters,
} from "./parameter-mapper.js";

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
   */
  generateCommand(commandId: string): Command | null {
    const commandDef = sharedCommandRegistry.getCommand(commandId);
    if (!commandDef) {
      return null;
    }

    const options = this.getCommandOptions(commandId);

    // Create the basic command
    const command = new Command(commandDef.name).description(commandDef.description);

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
    const mappings = this.createCommandParameterMappings(commandDef, options);

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
   */
  generateCategoryCommand(category: CommandCategory): Command | null {
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
        const subcommand = this.generateCommand(commandDef.id);
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
        const childCommand = this.generateCommand(commandDef.id);
        if (childCommand) {
          // Update the child command name to just the child part
          childCommand.name(childName);
          parentCommand.addCommand(childCommand);
        }
      } else {
        // More complex nesting - handle it recursively or warn
        log.warn(`Complex command nesting not yet supported: ${commandDef.name}`);
        const subcommand = this.generateCommand(commandDef.id);
        if (subcommand) {
          categoryCommand.addCommand(subcommand);
        }
      }
    });

    return categoryCommand;
  }

  /**
   * Generate CLI commands for all categories
   */
  generateAllCategoryCommands(program: Command): void {
    // Get unique categories from all commands
    const categories = new Set<CommandCategory>();
    sharedCommandRegistry.getAllCommands().forEach((cmd) => {
      categories.add(cmd.category);
    });

    // Generate commands for each category
    categories.forEach((category) => {
      const categoryCommand = this.generateCategoryCommand(category);
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
    const mappings = createParameterMappings(commandDef.parameters, options.parameters || {});

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
    parameters: CommandParameterMap,
    options: Record<string, any>,
    positionalArgs: any[],
    mappings: ParameterMapping[]
  ): Record<string, any> {
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
  private getDefaultFormatter(commandDef: SharedCommand): (result: any) => void {
    // Very simple default formatter
    return (result: any) => {
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
        // If the result has a simple shape, format it nicely
        Object.entries(result).forEach(([key, value]) => {
          if (typeof value !== "object" || value === null) {
            log.cli(`${key}: ${value}`);
          }
        });
      } else if (result !== undefined) {
        // Just print the result as is
        log.cli(String(result));
      }
    };
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
