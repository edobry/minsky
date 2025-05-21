/**
 * CLI Bridge
 *
 * This module bridges the shared command registry with the Commander.js CLI,
 * allowing shared commands to be exposed as CLI commands.
 */

import { Command } from "commander";
import {
  sharedCommandRegistry,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
  CommandCategory,
  SharedCommandRegistry,
  type SharedCommand,
  type CommandParameterDefinition,
} from "../command-registry.js";
import { addOptionsToCommand, parseOptionsToParameters } from "../schema-bridge.js";
import { getErrorHandler } from "../error-handling.js";
import { addOutputOptions } from "../../cli/utils/shared-options.js";
import type { OutputOptions } from "../../cli/utils/shared-options.js";
import { log } from "../../../utils/logger.js";

/**
 * CLI-specific execution context.
 */
export interface CliExecutionContext extends CommandExecutionContext {
  interface: "cli";
  // Commander.js command object if needed for specific CLI interactions
  commanderCommand?: Command;
}

/**
 * Create Commander option flags string from parameter definition
 */
function createCliOptionFlags(
  paramName: string,
  paramDef: CommandParameterDefinition
): string {
  const shortFlag = paramName.length === 1 
    ? `-${paramName}` 
    : "";
  
  const longFlag = `--${paramName}`;
  
  // Combine flags (short first if available)
  const flags = shortFlag 
    ? `${shortFlag}, ${longFlag}` 
    : longFlag;
  
  // Add value placeholder for non-boolean parameters
  return paramDef.schema.constructor.name !== "ZodBoolean"
    ? `${flags} <value>`
    : flags;
}

/**
 * Creates a Commander.js command from a shared command definition.
 *
 * @param commandDef The shared command definition.
 * @param rootCommand The root Commander command to attach this command to (optional).
 * @returns A configured Commander.js command.
 */
export function createCliCommand(
  commandDef: CommandDefinition<any, any>,
  rootCommand?: Command
): Command {
  const cliCmd = rootCommand
    ? rootCommand.command(commandDef.name)
    : new Command(commandDef.name);

  cliCmd.description(commandDef.description);

  // Add shared parameters as CLI options
  addOptionsToCommand(cliCmd, commandDef.parameters);

  // Add global output options (e.g., --json, --debug)
  addOutputOptions(cliCmd);

  cliCmd.action(async (options: Record<string, unknown> & OutputOptions, cmd: Command) => {
    const errorHandler = getErrorHandler("cli");
    try {
      // Prepare execution context
      const context: CliExecutionContext = {
        interface: "cli",
        debug: !!options.debug,
        format: options.format as string,
        commanderCommand: cmd,
      };

      // Parse and validate options against the command's Zod schemas
      const parsedParams = parseOptionsToParameters(
        options,
        commandDef.parameters
      );

      // Merge with global options if necessary (some might be handled by `parseOptionsToParameters` if defined in commandDef)
      // For this example, assuming global options like debug/format are directly on `options`
      // and specific command params are in `parsedParams`.

      const result = await commandDef.execute(parsedParams, context);

      // Handle output (actual output formatting will be done by the command's domain logic or response formatters)
      // For now, just log the result if not undefined
      if (result !== undefined) {
        // Output will be handled by specific response formatters or domain logic
        // This is a placeholder
        if (context.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Attempt a simple string conversion or rely on a text formatter.
          // In a real scenario, a shared response formatter would be used here.
          console.log(result);
        }
      }
    } catch (error) {
      errorHandler.handleError(error, { debug: !!options.debug });
    }
  });

  return cliCmd;
}

/**
 * Create a CLI command from a shared command
 */
function createCliCommandFromShared(parent: Command, sharedCommand: SharedCommand): Command {
  const { name, description, parameters, execute } = sharedCommand;
  
  // Create command
  const command = new Command(name);
  command.description(description);
  
  // Add options from command parameters
  for (const [paramName, paramDef] of Object.entries(parameters)) {
    try {
      // Skip parameters that should not be exposed to CLI
      if (paramDef.cliHidden) {
        continue;
      }
      
      const optionFlags = createCliOptionFlags(paramName, paramDef);
      const optionDescription = paramDef.description || "";
      
      // Add option
      if (paramDef.required) {
        command.requiredOption(optionFlags, optionDescription);
      } else {
        const option = command.option(optionFlags, optionDescription);
        
        // Set default value if provided
        if (paramDef.defaultValue !== undefined) {
          option.default(paramDef.defaultValue);
        }
      }
    } catch (error) {
      // Handle duplicate options gracefully
      log.warn(`Skipping duplicate option ${paramName} in command ${name}:`, error);
    }
  }
  
  // Set action handler
  command.action(async (options) => {
    try {
      // Execute the command with options
      const result = await execute(options, { interface: "cli" });
      
      // Output the result
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Command execution failed:", error);
      process.exit(1);
    }
  });
  
  // Add command to parent
  parent.addCommand(command);
  
  return command;
}

/**
 * Create a command group for a category
 */
function createCommandGroup(
  parent: Command, 
  category: CommandCategory, 
  registry: SharedCommandRegistry
): Command {
  // Create category command if this is a subcategory
  let categoryCommand: Command;

  // Convert category to command name (lowercase)
  const categoryName = category.toLowerCase();
  
  try {
    // Create new command for this category
    categoryCommand = new Command(categoryName);
    categoryCommand.description(`${category} commands`);
    
    // Add to parent
    parent.addCommand(categoryCommand);
  } catch (error) {
    // If command already exists, use existing one
    log.warn(`Command group ${categoryName} already exists, reusing:`, error);
    categoryCommand = parent.commands.find(cmd => cmd.name() === categoryName) || parent;
  }
  
  return categoryCommand;
}

/**
 * Register commands from a specific category to CLI
 */
export function registerCategorizedCliCommands(
  program: Command,
  categories: CommandCategory[] = Object.values(CommandCategory),
  useSubcommands = false
): void {
  log.debug(`Registering CLI commands for categories: ${categories.join(", ")}`);
  
  for (const category of categories) {
    // Get commands in category
    const commands = sharedCommandRegistry.getCommandsByCategory(category);
    
    if (commands.length === 0) {
      log.debug(`No commands found in category ${category}`);
      continue;
    }
    
    // Determine parent command (either program or category subcommand)
    const parent = useSubcommands 
      ? createCommandGroup(program, category, sharedCommandRegistry)
      : program;
    
    // Register each command
    for (const command of commands) {
      try {
        createCliCommandFromShared(parent, command);
      } catch (error) {
        log.error(`Failed to register command ${command.name}:`, error);
      }
    }
  }
}

/**
 * Register all commands to CLI
 */
export function registerAllCliCommands(program: Command, useSubcommands = false): void {
  registerCategorizedCliCommands(
    program,
    Object.values(CommandCategory),
    useSubcommands
  );
} 
