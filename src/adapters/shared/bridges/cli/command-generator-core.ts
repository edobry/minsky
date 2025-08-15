/**
 * CLI Command Generator Core
 *
 * Core logic for generating Commander.js commands from shared command definitions.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { Command } from "commander";
import { log } from "../../../../utils/logger";
import { handleCliError } from "../../../cli/utils/error-handler";
import { outputResult } from "../../../cli/utils/index";
import {
  sharedCommandRegistry,
  type CommandExecutionContext,
  type SharedCommand,
} from "../../command-registry";
import { normalizeCliParameters } from "../parameter-mapper";
import {
  type CliCommandOptions,
  type CommandCustomizationManager,
} from "./command-customization-manager";
import { type ParameterProcessor } from "./parameter-processor";
import { type CommandResultFormatter } from "./result-formatter";

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
 * Dependencies for command generation
 */
export interface CommandGeneratorDependencies {
  customizationManager: CommandCustomizationManager;
  parameterProcessor: ParameterProcessor;
  resultFormatter: CommandResultFormatter;
}

/**
 * Core command generator implementation
 */
export class CommandGeneratorCore {
  constructor(private deps: CommandGeneratorDependencies) {}

  /**
   * Generate a CLI command from a shared command definition
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    log.debug(`generateCommand called with commandId: ${commandId}`);

    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        `[CLI Command Generator] Direct usage detected for command '${commandId}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commandDef = sharedCommandRegistry.getCommand(commandId);
    log.debug(`commandDef found: ${!!commandDef}`);
    if (!commandDef) {
      return null;
    }

    const options = this.deps.customizationManager.getCommandOptions(commandId);
    log.debug(`options retrieved: ${!!options}`);

    // Create the basic command
    const command = new Command(commandDef.name).description(commandDef.description);
    log.debug(`command created: ${command.name()}`);

    // Configure command based on options
    this.configureCommand(command, options);

    // Set up parameters
    this.setupCommandParameters(command, commandDef, options);

    // Add action handler
    this.setupCommandAction(command, commandDef, options);

    return command;
  }

  /**
   * Configure command with basic options (aliases, visibility, etc.)
   */
  private configureCommand(command: Command, options: CliCommandOptions): void {
    // Add aliases if specified
    if (options.aliases && options.aliases.length) {
      command.aliases(options.aliases);
    }

    // Hide from help if specified
    if (options.hidden) {
      // Alternative approach: use a special prefix that can be filtered out
      command.description(`[HIDDEN] ${command.description()}`);
    }
  }

  /**
   * Set up command parameters (arguments and options)
   */
  private setupCommandParameters(
    command: Command,
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): void {
    log.debug("Setting up command parameters");

    // Use parameter processor to handle parameter setup
    this.deps.parameterProcessor.setupCommandParameters(command, commandDef, options);

    log.debug("Command parameters setup complete");
  }

  /**
   * Set up command action handler
   */
  private setupCommandAction(
    command: Command,
    commandDef: SharedCommand,
    options: CliCommandOptions
  ): void {
    command.action(async (...args) => {
      // Last argument is always the Command instance in Commander.js
      const commandInstance = args[args.length - 1] as Command;
      // Previous arguments are positional arguments
      const positionalArgs = args.slice(0, args.length - 1);

      try {
        // Process parameters
        const rawParameters = this.deps.parameterProcessor.extractRawParameters(
          commandDef.parameters,
          commandInstance.opts(),
          positionalArgs,
          commandDef,
          options
        );

        // Propagate CLI flags to runtime toggles for better error reporting
        // Enable debug mode if requested
        if (rawParameters && (rawParameters as any).debug && !process.env.DEBUG) {
          process.env.DEBUG = "1";
        }
        // Show full SQL in errors if requested
        if (rawParameters && (rawParameters as any).showSql) {
          process.env.MINSKY_SHOW_SQL = "true";
        }

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
        this.handleCommandOutput(result, commandDef, options, context);
      } catch (error) {
        // Handle any errors using the CLI error handler
        handleCliError(error);
      }
    });
  }

  /**
   * Handle command output using appropriate formatter
   */
  private handleCommandOutput(
    result: any,
    commandDef: SharedCommand,
    options: CliCommandOptions,
    context: CliExecutionContext
  ): void {
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
        // Use result formatter for text output
        const formatter = this.deps.resultFormatter.getDefaultFormatter(commandDef);
        outputResult(result, {
          json: false,
          formatter,
        });
      }
    }
  }
}

/**
 * Create a command generator with the provided dependencies
 */
export function createCommandGenerator(deps: CommandGeneratorDependencies): CommandGeneratorCore {
  return new CommandGeneratorCore(deps);
}
