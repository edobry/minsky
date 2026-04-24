/**
 * Shared Command Registry
 *
 * Central registry for commands that can be exposed through multiple interfaces
 * (CLI, MCP, etc.). This provides a shared abstraction layer to reduce duplication
 * and ensure consistency.
 */

import { z } from "zod";
import { MinskyError } from "../../errors/index";
import {
  validateCommandDefinition,
  validateCommandRegistrationOptions,
} from "../../schemas/command-registry";

/** Brand symbol for validated command context (ADR-004 Phase 2) */
declare const ValidatedBrand: unique symbol;

/**
 * Branded type ensuring execute() only accepts context that passed validate().
 * Cannot be constructed directly — only returned by validate().
 */
export type ValidatedContext<C> = C & { readonly [ValidatedBrand]: true };

/**
 * Command category enum
 *
 * Used to organize commands into logical groups
 */
export enum CommandCategory {
  CORE = "CORE",
  GIT = "GIT",
  REPO = "REPO",
  TASKS = "TASKS",
  SESSION = "SESSION",
  PERSISTENCE = "PERSISTENCE",
  RULES = "RULES",
  INIT = "INIT",
  CONFIG = "CONFIG",
  DEBUG = "DEBUG",
  AI = "AI",
  TOOLS = "TOOLS",
  MCP = "MCP",
  KNOWLEDGE = "KNOWLEDGE",
  PROVENANCE = "PROVENANCE",
  MEMORY = "MEMORY",
  COMPILE = "COMPILE",
}

/**
 * Command execution context
 */
export interface CommandExecutionContext {
  /** The interface that's invoking the command (cli, mcp, etc.) */
  interface?: string;
  /** Debug mode flag */
  debug?: boolean;
  /** Verbose mode flag */
  verbose?: boolean;
  /** Format mode (json, text, etc.) */
  format?: string;
  /** Workspace path for the current context */
  workspacePath?: string;
  /** DI container — provides access to services via typed dependency resolution. */
  container?: import("../../composition/types").AppContainerInterface;
}

/**
 * Represents a command parameter with type information and metadata
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CommandParameterDefinition<T extends z.ZodType = z.ZodType<any>> {
  /** Parameter schema used for validation */
  schema: T;
  /** Human-readable description */
  description?: string;
  /** Human-readable description (alias for description) */
  help?: string;
  /** Human-readable description */
  spec?: string;
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
  T extends CommandParameterMap = Record<string, CommandParameterDefinition>,
  R = unknown,
> = (
  parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
  context: CommandExecutionContext
) => Promise<R>;

/**
 * Represents a command registration in the shared registry
 */

export interface CommandDefinition<
  T extends CommandParameterMap = Record<string, CommandParameterDefinition>,
  R = unknown,
  C = void,
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
  execute: (
    parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
    context: CommandExecutionContext,
    validated?: ValidatedContext<C>
  ) => Promise<R>;
  /**
   * Optional precondition validation. Runs before execute().
   * Must throw on failure (ValidationError). Must not perform mutations.
   * If defined, the framework guarantees it runs before execute().
   * May return a ValidatedContext that is threaded through to execute(),
   * or return void for simple guard-style validators.
   */
  validate?: (
    parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
    context: CommandExecutionContext
  ) => Promise<ValidatedContext<C> | void>;
  /**
   * Whether this command requires the project to be initialized before execution.
   * Defaults to true. Set to false for commands like `init`, `setup`, and `mcp.register`
   * that are responsible for initialization themselves.
   */
  requiresSetup?: boolean;
}

/**
 * Infers the params object type from a CommandParameterMap.
 *
 * Given a parameter map like `{ taskId: { schema: z.string(), ... }, force: { schema: z.boolean(), ... } }`,
 * this produces the type `{ taskId: string; force: boolean }`.
 */
export type InferParams<T extends CommandParameterMap> = {
  [K in keyof T]: z.infer<T[K]["schema"]>;
};

/**
 * Helper to define a command with full type inference on parameters.
 *
 * This eliminates the need for `as any` casts on command registration objects
 * by inferring the parameter map type from the literal and threading it through
 * to the execute handler's `params` argument.
 *
 * @example
 * ```ts
 * const myCommand = defineCommand({
 *   id: "tasks.list",
 *   category: CommandCategory.TASKS,
 *   name: "list",
 *   description: "List tasks",
 *   parameters: {
 *     status: { schema: z.string(), description: "Filter by status", required: false },
 *     limit: { schema: z.number(), description: "Max results", required: false },
 *   },
 *   // params is inferred as { status: string; limit: number }
 *   execute: async (params, ctx) => {
 *     const { status, limit } = params;
 *     // ...
 *   },
 * });
 * ```
 */
export function defineCommand<T extends CommandParameterMap, R = unknown, C = void>(
  def: CommandDefinition<T, R, C>
): CommandDefinition<T, R, C> {
  return def;
}

/**
 * Shared command interface that preserves type information
 */
export interface SharedCommand<
  T extends CommandParameterMap = CommandParameterMap,
  R = unknown,
  C = void,
> {
  id: string;
  category: CommandCategory;
  name: string;
  description: string;
  parameters: T;
  execute: (
    parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
    context: CommandExecutionContext,
    validated?: ValidatedContext<C>
  ) => Promise<R>;
  validate?: (
    parameters: { [K in keyof T]: z.infer<T[K]["schema"]> },
    context: CommandExecutionContext
  ) => Promise<ValidatedContext<C> | void>;
  requiresSetup?: boolean;
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
  registerCommand<
    T extends CommandParameterMap = Record<string, CommandParameterDefinition>,
    R = unknown,
  >(
    commandDef: CommandDefinition<T, R>
  ): void;

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

  /**
   * Remove a command from the registry.
   *
   * Intended primarily for test teardown; production code should not
   * unregister commands during normal operation.
   *
   * @param id Command identifier
   * @returns True if a command was removed; false if no command with that id existed
   */
  unregisterCommand(id: string): boolean;
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
  registerCommand<
    T extends CommandParameterMap = Record<string, CommandParameterDefinition>,
    R = unknown,
  >(commandDef: CommandDefinition<T, R>, options: { allowOverwrite?: boolean } = {}): void {
    // Validate the command definition using schema validation
    const validatedDef = validateCommandDefinition(commandDef);
    const validatedOptions = validateCommandRegistrationOptions(options);

    if (this.commands.has(validatedDef.id) && !validatedOptions.allowOverwrite) {
      throw new MinskyError(`Command with ID '${validatedDef.id}' is already registered`);
    }

    // Store with preserved type information (no casting required)
    this.commands.set(validatedDef.id, commandDef as SharedCommand);
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
   * Check if a command is registered
   *
   * @param id Command identifier
   * @returns True if command exists
   */
  hasCommand(id: string): boolean {
    return this.commands.has(id);
  }

  /**
   * Get the number of registered commands
   *
   * @returns Command count
   */
  getCommandCount(): number {
    return this.commands.size;
  }

  /**
   * Clear all registered commands
   *
   * @deprecated Use a fresh registry instance instead of clearing state
   */
  clear(): void {
    this.commands.clear();
  }

  /**
   * Remove a single command from the registry.
   *
   * Intended primarily for test teardown so test-only commands do not
   * persist in the global registry across tests. Returns true if a command
   * was removed; false if the id was not registered.
   */
  unregisterCommand(id: string): boolean {
    return this.commands.delete(id);
  }
}

/**
 * Factory function to create a new command registry
 *
 * @returns New command registry instance
 */
export function createSharedCommandRegistry(): SharedCommandRegistry {
  return new SharedCommandRegistry();
}

/**
 * Default command registry instance
 *
 * @deprecated Use createSharedCommandRegistry() and dependency injection instead
 */
export const _sharedCommandRegistry = createSharedCommandRegistry();

/**
 * Default command registry instance (non-underscore version)
 * Used by files that follow variable-naming-protocol
 */
export const sharedCommandRegistry = _sharedCommandRegistry;
