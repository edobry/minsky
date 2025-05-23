/**
 * Shared Command Registry
 *
 * Central registry for commands that can be exposed through multiple interfaces
 * (CLI, MCP, etc.). This provides a shared abstraction layer to reduce duplication
 * and ensure consistency.
 */

import { z } from "zod";
import { MinskyError } from "../../errors/index.js";

/**
 * Command category enum
 *
 * Used to organize commands into logical groups
 */
export enum CommandCategory {
  CORE = "CORE",
  GIT = "GIT",
  TASKS = "TASKS",
  SESSION = "SESSION",
  RULES = "RULES",
  INIT = "INIT",
}

/**
 * Command execution context
 *
 * Provides context about how a command was invoked
 */
export interface CommandExecutionContext {
  /** The interface that's invoking the command (cli, mcp, etc.) */
  interface: string;
  /** Debug mode flag */
  debug?: boolean;
  /** Format mode (json, text, etc.) */
  format?: string;
}

/**
 * Represents a command parameter with type information and metadata
 */
export interface CommandParameterDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Parameter schema used for validation */
  schema: T;
  /** Human-readable description */
  description?: string;
  /** Whether the parameter is required */
  required: boolean;
  /** Default value for the parameter */
  defaultValue?: z.infer<T>;
  /** Whether to hide the parameter in CLI interfaces */
  cliHidden?: boolean;
  /** Whether to hide the parameter in MCP interfaces */
  mcpHidden?: boolean;
}

/**
 * Type representing a map of parameter names to their definitions
 */
export type CommandParameterMap = Record<string, CommandParameterDefinition>;

/**
 * Represents a command execution handler function
 */
export type CommandExecutionHandler<
  T extends CommandParameterMap = CommandParameterMap,
  R = unknown,
> = (
  parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
  context: CommandExecutionContext
) => Promise<R>;

/**
 * Represents a command registration in the shared registry
 */
export interface CommandDefinition<
  T extends CommandParameterMap = CommandParameterMap,
  R = unknown,
> {
  /** Unique command identifier */
  id: string;
  /** Command category */
  category: CommandCategory;
  /** Human-readable name */
  name: string;
  /** Command description */
  description: string;
  /** Command parameters definition */
  parameters: T;
  /** Command execution handler */
  execute: CommandExecutionHandler<T, R>;
}

/**
 * Shared command interface that doesn't rely on generic types
 * for easier use in bridge implementations
 */
export interface SharedCommand {
  id: string;
  category: CommandCategory;
  name: string;
  description: string;
  parameters: CommandParameterMap;
  execute: (params: Record<string, any>, context: CommandExecutionContext) => Promise<any>;
}

/**
 * Registry for maintaining all available commands
 */
export interface CommandRegistry {
  /**
   * Register a new command in the registry
   *
   * @param commandDef Command definition to register
   */
  registerCommand<T extends CommandParameterMap, R>(commandDef: CommandDefinition<T, R>): void;

  /**
   * Get a command by its identifier
   *
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getCommand(id: string): SharedCommand | undefined;

  /**
   * Get all commands in a specific category
   *
   * @param category Command category
   * @returns Array of command definitions
   */
  getCommandsByCategory(category: CommandCategory): SharedCommand[];

  /**
   * List all registered commands
   *
   * @returns All registered command definitions
   */
  getAllCommands(): SharedCommand[];
}

/**
 * Implementation of the command registry
 */
export class SharedCommandRegistry implements CommandRegistry {
  private commands: Map<string, SharedCommand> = new Map();

  /**
   * Register a command in the registry
   *
   * @param commandDef Command definition
   * @param options Registration options
   * @throws {MinskyError} If command with same ID is already registered and allowOverwrite is false
   */
  registerCommand<T extends CommandParameterMap, R>(
    commandDef: CommandDefinition<T, R>,
    options: { allowOverwrite?: boolean } = {}
  ): void {
    if (this.commands.has(commandDef.id) && !options.allowOverwrite) {
      throw new MinskyError(`Command with ID '${commandDef.id}' is already registered`);
    }

    this.commands.set(commandDef.id, commandDef as unknown as SharedCommand);
  }

  /**
   * Get a command by its identifier
   *
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getCommand(id: string): SharedCommand | undefined {
    return this.commands.get(id);
  }

  /**
   * Get all commands in a specific category
   *
   * @param category Command category
   * @returns Array of command definitions
   */
  getCommandsByCategory(category: CommandCategory): SharedCommand[] {
    return Array.from(this.commands.values()).filter((cmd) => cmd.category === category);
  }

  /**
   * List all registered commands
   *
   * @returns All registered command definitions
   */
  getAllCommands(): SharedCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Check if a command is already registered
   *
   * @param id Command identifier
   * @returns True if command is registered, false otherwise
   */
  hasCommand(id: string): boolean {
    return this.commands.has(id);
  }

  /**
   * Clear all registered commands
   *
   * @deprecated Use a fresh registry instance instead of clearing state
   */
  clear(): void {
    this.commands.clear();
  }
}

/**
 * Create a new instance of the shared command registry
 *
 * This function should be used instead of a global singleton to ensure
 * proper isolation in tests and better dependency management.
 */
export function createSharedCommandRegistry(): SharedCommandRegistry {
  return new SharedCommandRegistry();
}

/**
 * Default instance for backwards compatibility
 *
 * @deprecated Use createSharedCommandRegistry() and dependency injection instead
 */
export const sharedCommandRegistry = createSharedCommandRegistry();
