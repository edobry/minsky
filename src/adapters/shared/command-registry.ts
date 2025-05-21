/**
 * Shared Command Registry
 * 
 * This module provides the core abstractions for a unified command registry
 * that can be used by both CLI and MCP adapters. It allows commands to be
 * registered once and exposed through multiple interfaces.
 */

import { z } from "zod";
import { MinskyError } from "../../errors/index.js";

/**
 * Represents a command parameter with type information and metadata
 */
export interface CommandParameter<T extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Parameter schema used for validation */
  schema: T;
  /** Human-readable description */
  description: string;
  /** Whether the parameter is required */
  required: boolean;
  /** Default value for the parameter */
  defaultValue?: z.infer<T>;
}

/**
 * Type representing a map of parameter names to their definitions
 */
export type CommandParameterMap = Record<string, CommandParameter>;

/**
 * Type representing a command execution context
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
 * Represents a command execution handler function
 */
export type CommandExecutionHandler<
  T extends CommandParameterMap = CommandParameterMap,
  R = unknown
> = (
  parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
  context: CommandExecutionContext
) => Promise<R>;

/**
 * Command category identifiers
 */
export enum CommandCategory {
  GIT = "git",
  TASK = "task",
  SESSION = "session",
  RULE = "rule",
  INIT = "init",
  CORE = "core",
}

/**
 * Represents a command registration in the shared registry
 */
export interface CommandDefinition<
  T extends CommandParameterMap = CommandParameterMap,
  R = unknown
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
 * Registry for maintaining all available commands
 */
export interface CommandRegistry {
  /**
   * Register a new command in the registry
   * 
   * @param commandDef Command definition to register
   */
  registerCommand<T extends CommandParameterMap, R>(
    commandDef: CommandDefinition<T, R>
  ): void;

  /**
   * Get a command by its identifier
   * 
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getCommand(id: string): CommandDefinition | undefined;

  /**
   * Get all commands in a specific category
   * 
   * @param category Command category
   * @returns Array of command definitions
   */
  getCommandsByCategory(category: CommandCategory): CommandDefinition[];

  /**
   * List all registered commands
   * 
   * @returns All registered command definitions
   */
  getAllCommands(): CommandDefinition[];
}

/**
 * Core implementation of the command registry
 */
export class SharedCommandRegistry implements CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();

  /**
   * Register a command in the registry
   * 
   * @param commandDef Command definition
   * @throws {MinskyError} If command with same ID is already registered
   */
  registerCommand<T extends CommandParameterMap, R>(
    commandDef: CommandDefinition<T, R>
  ): void {
    if (this.commands.has(commandDef.id)) {
      throw new MinskyError(`Command with ID '${commandDef.id}' is already registered`);
    }
    
    this.commands.set(commandDef.id, commandDef);
  }

  /**
   * Get a command by its identifier
   * 
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getCommand(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  /**
   * Get all commands in a specific category
   * 
   * @param category Command category
   * @returns Array of command definitions
   */
  getCommandsByCategory(category: CommandCategory): CommandDefinition[] {
    return Array.from(this.commands.values())
      .filter(cmd => cmd.category === category);
  }

  /**
   * List all registered commands
   * 
   * @returns All registered command definitions
   */
  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }
}

/**
 * Create a singleton instance of the shared command registry
 */
export const sharedCommandRegistry = new SharedCommandRegistry(); 
