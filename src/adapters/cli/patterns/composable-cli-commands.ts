/**
 * Composable CLI Command Patterns
 * 
 * High-level composable patterns for creating CLI commands that use standardized
 * parameter validation, response formatting, and error handling. This integrates
 * all the type composition patterns from Tasks #322 and #329.
 */
import { z, ZodSchema } from "zod";
import { Command } from "commander";
import {
  createCliCommandSchema,
  createCliListingCommandSchema,
  createCliCrudCommandSchema,
  CliBaseParameters,
} from "../schemas/cli-parameter-schemas";
import {
  createCliSuccessResponse,
  createCliErrorResponse,
  formatCliOutput,
  formatTaskListOutput,
  formatSessionListOutput,
  getEffectiveOutputFormat,
  getEffectiveVerbosity,
  CliOutputOptions,
} from "../schemas/cli-response-schemas";
import {
  validateCliParameters,
  handleStandardizedCliError,
  withErrorHandling,
  withParameterValidation,
  CliExitCode,
} from "../utils/standardized-error-handler";
import {
  validateCliArguments,
  transformCliArguments,
} from "../../../domain/schemas/validation-utils";
import { log } from "../../../utils/logger";

// ========================
// CLI COMMAND BUILDER TYPES
// ========================

/**
 * CLI command handler function signature
 */
export type CliCommandHandler<T> = (
  params: T,
  options: CliOutputOptions
) => Promise<any> | any;

/**
 * CLI command configuration
 */
export interface CliCommandConfig<T> {
  /** Command name */
  name: string;
  /** Command description */
  description: string;
  /** Parameter schema */
  schema: ZodSchema<T>;
  /** Command handler */
  handler: CliCommandHandler<T>;
  /** Custom output formatter */
  formatter?: (result: any, options: CliOutputOptions) => string;
  /** Whether to include base CLI parameters */
  includeBaseParams?: boolean;
  /** Command aliases */
  aliases?: string[];
  /** Example usage */
  examples?: string[];
}

/**
 * CLI listing command configuration
 */
export interface CliListingCommandConfig<T> extends Omit<CliCommandConfig<T>, 'formatter'> {
  /** Custom list formatter */
  listFormatter?: (items: any[], options: CliOutputOptions) => string;
  /** Item type for default formatting */
  itemType?: 'task' | 'session' | 'generic';
}

/**
 * CLI CRUD command configuration
 */
export interface CliCrudCommandConfig<T> extends CliCommandConfig<T> {
  /** Whether this is a destructive operation */
  destructive?: boolean;
  /** Success message template */
  successMessage?: string;
}

// ========================
// CORE COMMAND BUILDERS
// ========================

/**
 * Creates a standardized CLI command with full type composition patterns
 */
export function createStandardizedCliCommand<T>(
  config: CliCommandConfig<T>
): Command {
  const command = new Command(config.name);
  
  // Set description and aliases
  command.description(config.description);
  if (config.aliases) {
    config.aliases.forEach(alias => command.alias(alias));
  }

  // Add examples to help text
  if (config.examples) {
    const exampleText = config.examples
      .map(example => `  $ ${example}`)
      .join('\n');
    command.addHelpText('after', `\nExamples:\n${exampleText}`);
  }

  // Create the composed schema
  const composedSchema = config.includeBaseParams !== false
    ? createCliCommandSchema(config.schema as any)
    : config.schema;

  // Set up the command action
  command.action(async (rawParams: unknown) => {
    const startTime = Date.now();
    
    try {
      // Validate parameters
      const validatedParams = validateCliParameters(
        composedSchema,
        rawParams,
        config.name
      );

      // Extract CLI options
      const options: CliOutputOptions = extractCliOptions(validatedParams);

      // Execute the handler
      const result = await config.handler(validatedParams, options);

      // Create success response
      const response = createCliSuccessResponse(
        { result },
        {
          command: config.name,
          format: getEffectiveOutputFormat(options),
          verbosity: getEffectiveVerbosity(options),
          executionTime: Date.now() - startTime,
        }
      );

      // Format and output the result
      formatCliOutput(response, options, config.formatter);

    } catch (error) {
      handleStandardizedCliError(error, config.name);
    }
  });

  return command;
}

/**
 * Creates a standardized CLI listing command
 */
export function createStandardizedListingCommand<T>(
  config: CliListingCommandConfig<T>
): Command {
  const command = new Command(config.name);
  
  command.description(config.description);
  if (config.aliases) {
    config.aliases.forEach(alias => command.alias(alias));
  }

  if (config.examples) {
    const exampleText = config.examples
      .map(example => `  $ ${example}`)
      .join('\n');
    command.addHelpText('after', `\nExamples:\n${exampleText}`);
  }

  // Create the composed schema for listing
  const composedSchema = createCliListingCommandSchema(config.schema as any);

  command.action(async (rawParams: unknown) => {
    const startTime = Date.now();
    
    try {
      const validatedParams = validateCliParameters(
        composedSchema,
        rawParams,
        config.name
      );

      const options: CliOutputOptions = extractCliOptions(validatedParams);
      const result = await config.handler(validatedParams, options);

      // Ensure result is an array for listing commands
      const items = Array.isArray(result) ? result : [result];

      const response = createCliSuccessResponse(
        { result: items, count: items.length },
        {
          command: config.name,
          format: getEffectiveOutputFormat(options),
          verbosity: getEffectiveVerbosity(options),
          executionTime: Date.now() - startTime,
        }
      );

      // Use specialized list formatter
      const formatter = createListFormatter(config.listFormatter, config.itemType);
      formatCliOutput(response, options, formatter);

    } catch (error) {
      handleStandardizedCliError(error, config.name);
    }
  });

  return command;
}

/**
 * Creates a standardized CLI CRUD command
 */
export function createStandardizedCrudCommand<T>(
  config: CliCrudCommandConfig<T>
): Command {
  const command = new Command(config.name);
  
  command.description(config.description);
  if (config.aliases) {
    config.aliases.forEach(alias => command.alias(alias));
  }

  if (config.examples) {
    const exampleText = config.examples
      .map(example => `  $ ${example}`)
      .join('\n');
    command.addHelpText('after', `\nExamples:\n${exampleText}`);
  }

  // Create the composed schema for CRUD operations
  const composedSchema = createCliCrudCommandSchema(
    config.schema as any,
    undefined,
    config.destructive
  );

  command.action(async (rawParams: unknown) => {
    const startTime = Date.now();
    
    try {
      const validatedParams = validateCliParameters(
        composedSchema,
        rawParams,
        config.name
      );

      const options: CliOutputOptions = extractCliOptions(validatedParams);
      
      // Handle force confirmation for destructive operations
      if (config.destructive && !validatedParams.force && !options.quiet) {
        // Note: In a real implementation, you'd want to add confirmation prompts here
        log.cli("⚠️  This is a destructive operation. Use --force to bypass this warning.");
      }

      const result = await config.handler(validatedParams, options);

      const response = createCliSuccessResponse(
        { result },
        {
          command: config.name,
          format: getEffectiveOutputFormat(options),
          verbosity: getEffectiveVerbosity(options),
          executionTime: Date.now() - startTime,
        }
      );

      // Add success message for CRUD operations
      if (config.successMessage && !options.quiet) {
        response.message = config.successMessage;
      }

      formatCliOutput(response, options, config.formatter);

    } catch (error) {
      handleStandardizedCliError(error, config.name);
    }
  });

  return command;
}

// ========================
// UTILITY FUNCTIONS
// ========================

/**
 * Extracts CLI options from validated parameters
 */
function extractCliOptions(params: any): CliOutputOptions {
  return {
    format: params.format,
    verbosity: params.verbosity,
    json: params.json,
    quiet: params.quiet,
    verbose: params.verbose,
    debug: params.debug,
  };
}

/**
 * Creates a list formatter based on configuration
 */
function createListFormatter(
  customFormatter?: (items: any[], options: CliOutputOptions) => string,
  itemType?: 'task' | 'session' | 'generic'
) {
  return (data: any, options: CliOutputOptions): string => {
    const items = data.result || [];
    
    if (customFormatter) {
      return customFormatter(items, options);
    }

    switch (itemType) {
      case 'task':
        return formatTaskListOutput(items, options);
      case 'session':
        return formatSessionListOutput(items, options);
      default:
        // Generic formatter
        if (items.length === 0) {
          return getEffectiveVerbosity(options) === "quiet" ? "" : "No items found.";
        }
        
        return items.map((item: any, index: number) => {
          if (typeof item === 'string') {
            return item;
          }
          
          const name = item.name || item.id || item.title || `Item ${index + 1}`;
          return getEffectiveVerbosity(options) === "quiet" ? name : `${index + 1}. ${name}`;
        }).join('\n');
    }
  };
}

// ========================
// HIGH-LEVEL COMMAND FACTORY FUNCTIONS
// ========================

/**
 * Creates a task list command with standardized patterns
 */
export function createTaskListCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedListingCommand({
    name: 'list',
    description: 'List tasks with filtering and formatting options',
    schema: z.object({
      status: z.array(z.string()).optional(),
      all: z.boolean().default(false),
      completed: z.boolean().default(false),
    }),
    handler,
    itemType: 'task',
    aliases: ['ls'],
    examples: [
      'minsky tasks list',
      'minsky tasks list --status TODO,IN-PROGRESS',
      'minsky tasks list --all --json',
    ],
  });
}

/**
 * Creates a task get command with standardized patterns
 */
export function createTaskGetCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedCliCommand({
    name: 'get',
    description: 'Get a specific task by ID',
    schema: z.object({
      taskId: z.string().min(1, "Task ID is required"),
      section: z.string().optional(),
    }),
    handler,
    examples: [
      'minsky tasks get 123',
      'minsky tasks get 123 --section requirements',
      'minsky tasks get 123 --json',
    ],
  });
}

/**
 * Creates a task create command with standardized patterns
 */
export function createTaskCreateCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedCrudCommand({
    name: 'create',
    description: 'Create a new task',
    schema: z.object({
      title: z.string().min(1, "Task title is required"),
      description: z.string().optional(),
      descriptionPath: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    }),
    handler,
    successMessage: "Task created successfully",
    examples: [
      'minsky tasks create "Fix bug in login"',
      'minsky tasks create "New feature" --description "Add user profiles"',
      'minsky tasks create "Migration" --description-path ./task-spec.md',
    ],
  });
}

/**
 * Creates a task delete command with standardized patterns
 */
export function createTaskDeleteCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedCrudCommand({
    name: 'delete',
    description: 'Delete a task',
    schema: z.object({
      taskId: z.string().min(1, "Task ID is required"),
    }),
    handler,
    destructive: true,
    successMessage: "Task deleted successfully",
    aliases: ['rm'],
    examples: [
      'minsky tasks delete 123',
      'minsky tasks delete 123 --force',
    ],
  });
}

/**
 * Creates a session list command with standardized patterns
 */
export function createSessionListCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedListingCommand({
    name: 'list',
    description: 'List sessions with filtering and formatting options',
    schema: z.object({
      current: z.boolean().default(false),
      showPaths: z.boolean().default(false),
    }),
    handler,
    itemType: 'session',
    aliases: ['ls'],
    examples: [
      'minsky session list',
      'minsky session list --current',
      'minsky session list --show-paths --verbose',
    ],
  });
}

/**
 * Creates a session create command with standardized patterns
 */
export function createSessionCreateCommand(
  handler: CliCommandHandler<any>
): Command {
  return createStandardizedCrudCommand({
    name: 'start',
    description: 'Create and start a new session',
    schema: z.object({
      name: z.string().optional(),
      task: z.string().optional(),
      description: z.string().optional(),
      autoStart: z.boolean().default(true),
    }),
    handler,
    successMessage: "Session created and started successfully",
    aliases: ['create'],
    examples: [
      'minsky session start --task 123',
      'minsky session start my-session --description "Working on feature X"',
      'minsky session start --task 123 --no-auto-start',
    ],
  });
}

// ========================
// COMMAND REGISTRATION HELPERS
// ========================

/**
 * Registers multiple commands to a parent command
 */
export function registerCommands(
  parentCommand: Command,
  commands: Command[]
): void {
  commands.forEach(command => {
    parentCommand.addCommand(command);
  });
}

/**
 * Creates a command group with standardized sub-commands
 */
export function createCommandGroup(
  name: string,
  description: string,
  commands: Command[]
): Command {
  const group = new Command(name);
  group.description(description);
  
  registerCommands(group, commands);
  
  return group;
}

// ========================
// TYPE EXPORTS
// ========================

export type {
  CliCommandHandler,
  CliCommandConfig,
  CliListingCommandConfig,
  CliCrudCommandConfig,
}; 
