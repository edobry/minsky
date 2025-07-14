/**
 * CLI Bridge
 *
 * This module bridges the command registry with the Commander.js CLI,
 * eliminating all type casting while maintaining parameter types through 
 * the execution chain.
 */
import { Command } from "commander";
import {
  SharedCommandRegistry,
  SharedCommand,
  createSharedCommandRegistry,
  CommandCategory,
  CommandExecutionContext,
} from "../command-registry.js";
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
 * CLI command options
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
 * Category command options
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
 * CLI command bridge implementation
 */
export class CliCommandBridge {
  private registry: SharedCommandRegistry;
  private customizations: Map<string, CliCommandOptions> = new Map();
  private categoryCustomizations: Map<CommandCategory, CategoryCommandOptions> = new Map();

  constructor(registry?: SharedCommandRegistry) {
    this.registry = registry || createSharedCommandRegistry();
  }

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.customizations.set(commandId, options);
    log.debug(`Registered CLI customization for command: ${commandId}`);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.categoryCustomizations.set(category, options);
    log.debug(`Registered CLI customization for category: ${category}`);
  }

  /**
   * Get command options with proper fallbacks
   */
  private getCommandOptions(commandId: string): CliCommandOptions {
    return this.customizations.get(commandId) || {};
  }

  /**
   * Generate a CLI command from a command definition
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    log.debug(`generateCommand called with commandId: ${commandId}`);

    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        `[CLI Bridge] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commandDef = this.registry.getCommand(commandId);
    log.debug(`commandDef found: ${!!commandDef}`);
    if (!commandDef) {
      return null;
    }

    const options = this.getCommandOptions(commandId);
    log.debug(`options retrieved: ${!!options}`);

    // Create the basic command
    const command = new Command(commandDef.name).description(commandDef.description);
    log.debug(`command created: ${command.name()}`);

    // Add aliases if specified
    if (options.aliases && options.aliases.length) {
      command.aliases(options.aliases);
    }

    // Hide from help if specified
    if (options.hidden) {
      // Alternative approach: use a special prefix that can be filtered out
      command.description(`[HIDDEN] ${command.description()}`);
    }

    // Create parameter mappings
    log.debug("About to create parameter mappings");
    const mappings = this.createCommandParameterMappings(commandDef, options);
    log.debug(`Parameter mappings created: ${mappings.length}`);

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
        const normalizedParams = normalizeCliParameters(
          commandDef.parameters,
          rawParameters
        );

        // Execute the command with parameters and context - NO TYPE CASTING NEEDED
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
        await handleCliError(error, {
          debug: !!rawParameters?.debug,
        });
      }
    });

    return command;
  }

  /**
   * Generate a category command with type safety
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    const customOptions = this.categoryCustomizations.get(category) || {};
    
    const commands = this.registry.getCommandsByCategory(category);
    if (commands.length === 0) {
      return null;
    }

    // Create category command
    const categoryName = customOptions.name || category.toLowerCase();
    const categoryDescription = customOptions.description || `${category} commands`;

    const categoryCommand = new Command(categoryName).description(categoryDescription);

    // Add aliases if specified
    if (customOptions.aliases) {
      categoryCommand.aliases(customOptions.aliases);
    }

    // Add subcommands for each command in the category
    commands.forEach((commandDef) => {
      // Apply command-specific options from category customization
      const commandOptions = customOptions.commandOptions?.[commandDef.id] || {};
      this.registerCommandCustomization(commandDef.id, commandOptions);

      const subcommand = this.generateCommand(commandDef.id, context);
      if (subcommand) {
        if (customOptions.usePrefix) {
          // Create nested structure: category prefix command
          const prefixedName = `${categoryName}-${commandDef.name.toLowerCase()}`;
          const newParentCommand = new Command(prefixedName)
            .description(commandDef.description)
            .action((...args) => subcommand.parseAsync(args));
          
          categoryCommand.addCommand(newParentCommand);
        } else {
          // Add as direct subcommand
          categoryCommand.addCommand(subcommand);
        }
      }
    });

    return categoryCommand;
  }

  /**
   * Generate all category commands and add them to the program
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    const categories = Object.values(CommandCategory);
    
    categories.forEach(category => {
      const categoryCommand = this.generateCategoryCommand(category, context);
      if (categoryCommand) {
        program.addCommand(categoryCommand);
      }
    });
  }

  /**
   * Create parameter mappings for a command with type safety
   */
  private createCommandParameterMappings(
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): ParameterMapping[] {
    return createParameterMappings(commandDef.parameters, {
      useFirstRequiredParamAsArgument: options.useFirstRequiredParamAsArgument,
      forceOptions: options.forceOptions,
      customMappings: options.parameters || {},
    });
  }

  /**
   * Extract raw parameters from CLI inputs
   */
  private extractRawParameters(
    parameters: Record<string, any>,
    options: Record<string, any>,
    positionalArgs: any[],
    mappings: ParameterMapping[]
  ): Record<string, any> {
    const result: Record<string, any> = { ...options };

    // Map positional arguments based on parameter mappings
    mappings.forEach((mapping, index) => {
      if (mapping.isArgument && index < positionalArgs.length) {
        result[mapping.parameterName] = positionalArgs[index];
      }
    });

    return result;
  }

  /**
   * Get default formatter for a command with type safety
   */
  private getDefaultFormatter(commandDef: SharedCommand): (result: any) => void {
    return (result: any) => {
      if (typeof result === "object") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    };
  }

  /**
   * Session command formatters
   */
  private getSessionFormatter(commandId: string): (result: any) => void {
    switch (commandId) {
    case "session-list":
      return (result: any) => {
        if (result.sessions && Array.isArray(result.sessions)) {
          result.sessions.forEach((session: any) => this.formatSessionSummary(session));
        }
      };
    case "session-get":
    case "session-inspect":
      return (result: any) => this.formatSessionDetails(result);
    case "session-start":
      return (result: any) => this.formatSessionStartSuccess(result);
    default:
      return (result: any) => console.log(JSON.stringify(result, null, 2));
    }
  }

  /**
   * Task command formatters
   */
  private getTaskFormatter(commandId: string): (result: any) => void {
    switch (commandId) {
    case "tasks-list":
      return (result: any) => {
        if (result.tasks && Array.isArray(result.tasks)) {
          result.tasks.forEach((task: any) => {
            console.log(`${task.id}: ${task.title} [${task.status}]`);
          });
        }
      };
    default:
      return (result: any) => console.log(JSON.stringify(result, null, 2));
    }
  }

  /**
   * Git command formatters
   */
  private getGitFormatter(commandId: string): (result: any) => void {
    return (result: any) => console.log(result.output || JSON.stringify(result, null, 2));
  }

  /**
   * Rule command formatters
   */
  private getRuleFormatter(commandId: string): (result: any) => void {
    switch (commandId) {
    case "rules-list":
      return (result: any) => {
        if (result.rules && Array.isArray(result.rules)) {
          result.rules.forEach((rule: any) => this.formatRuleSummary(rule));
        }
      };
    case "rules-get":
      return (result: any) => this.formatRuleDetails(result);
    default:
      return (result: any) => console.log(JSON.stringify(result, null, 2));
    }
  }

  /**
   * Debug command formatters
   */
  private getDebugFormatter(commandId: string): (result: any) => void {
    switch (commandId) {
    case "debug-echo":
      return (result: any) => this.formatDebugEchoDetails(result);
    default:
      return (result: any) => console.log(JSON.stringify(result, null, 2));
    }
  }

  // Formatter helper methods (simplified versions of the existing ones)
  private formatSessionDetails(session: Record<string, any>): void {
    console.log(`Session: ${session.name || session.id}`);
    if (session.taskId) console.log(`Task: ${session.taskId}`);
    if (session.status) console.log(`Status: ${session.status}`);
    if (session.branch) console.log(`Branch: ${session.branch}`);
  }

  private formatSessionStartSuccess(session: Record<string, any>): void {
    console.log("✅ Session started successfully:");
    console.log(`Session: ${session.session || session.name}`);
    console.log(`Branch: ${session.branch}`);
    if (session.taskId) console.log(`Task: ${session.taskId}`);
  }

  private formatSessionSummary(session: Record<string, any>): void {
    const status = session.status ? `[${session.status}]` : "";
    console.log(`${session.name || session.id} ${status}`);
  }

  private formatDebugEchoDetails(result: Record<string, any>): void {
    console.log(`Echo Result: ${result.message || result.echo}`);
    if (result.timestamp) console.log(`Timestamp: ${result.timestamp}`);
  }

  private formatRuleDetails(rule: Record<string, any>): void {
    console.log(`Rule: ${rule.name || rule.id}`);
    if (rule.description) console.log(`Description: ${rule.description}`);
    if (rule.content) console.log(`Content:\n${rule.content}`);
  }

  private formatRuleSummary(rule: Record<string, any>): void {
    console.log(`${rule.name || rule.id}: ${rule.description || "No description"}`);
  }

  /**
   * Get the underlying command registry
   */
  getRegistry(): SharedCommandRegistry {
    return this.registry;
  }
}

/**
 * Factory function to create a CLI bridge
 */
export function createCliBridge(registry?: SharedCommandRegistry): CliCommandBridge {
  return new CliCommandBridge(registry);
}

/**
 * Default CLI bridge instance
 */
export const cliBridge = createCliBridge(); 
