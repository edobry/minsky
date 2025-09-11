/**
 * Database Command Abstract Base Class
 *
 * Foundation infrastructure for type-safe database command architecture.
 * Provides compile-time type safety and guaranteed provider injection.
 */

import { z } from "zod";
import type { PersistenceProvider } from "../persistence/types";
import {
  type CommandExecutionContext,
  type CommandParameterDefinition,
  type CommandParameterMap,
  type CommandExecutionHandler,
  CommandCategory,
} from "../../adapters/shared/command-registry";

/**
 * Enhanced execution context for database commands
 * Guarantees persistence provider availability at runtime
 */
export interface DatabaseCommandContext extends CommandExecutionContext {
  /** Guaranteed initialized persistence provider */
  provider: PersistenceProvider;
}

/**
 * Abstract base class for commands that require database access
 *
 * This class provides:
 * - Compile-time type safety for database commands
 * - Guaranteed provider injection via enhanced context
 * - Clear separation between database and non-database commands
 * - Type contracts for dispatch-level provider injection
 */
export abstract class DatabaseCommand<
  TParams extends CommandParameterMap = Record<string, CommandParameterDefinition>,
  TResult = any,
> {
  /** Unique command identifier */
  abstract readonly id: string;

  /** Command category */
  abstract readonly category: CommandCategory;

  /** Human-readable name */
  abstract readonly name: string;

  /** Command description */
  abstract readonly description: string;

  /** Command parameters definition with full type information */
  abstract readonly parameters: TParams;

  /**
   * Execute the database command with typed parameters and guaranteed provider access
   *
   * @param params - Fully typed parameters from Zod schema validation
   * @param context - Enhanced context with guaranteed persistence provider
   * @returns Command result
   */
  abstract execute(
    params: { [K in keyof TParams]: z.infer<TParams[K]["schema"]> },
    context: DatabaseCommandContext
  ): Promise<TResult>;

  /**
   * Type guard to identify database commands at runtime
   * Used by the command dispatcher for provider injection logic
   */
  static isDatabaseCommand(command: any): command is DatabaseCommand {
    return command instanceof DatabaseCommand;
  }

  /**
   * Get the standard execution handler that can be used with the shared command registry
   * This bridges the abstract class with the existing command registry interface
   */
  getExecutionHandler(): CommandExecutionHandler<TParams, TResult> {
    return async (params, context) => {
      // This will be called by the CommandDispatcher which will ensure
      // the context is properly enhanced with a DatabaseCommandContext
      return this.execute(params, context as DatabaseCommandContext);
    };
  }
}

/**
 * Type predicate function for identifying database commands
 * Alternative to the static method for functional programming patterns
 */
export function isDatabaseCommand(command: any): command is DatabaseCommand {
  return DatabaseCommand.isDatabaseCommand(command);
}

/**
 * Helper type to extract parameter types from a DatabaseCommand
 * Useful for creating strongly-typed command parameters
 */
export type DatabaseCommandParameters<T extends DatabaseCommand> =
  T extends DatabaseCommand<infer P, any> ? P : never;

/**
 * Helper type to extract result type from a DatabaseCommand
 * Useful for creating strongly-typed command result handlers
 */
export type DatabaseCommandResult<T extends DatabaseCommand> =
  T extends DatabaseCommand<any, infer R> ? R : never;

