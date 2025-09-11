/**
 * Database Session Command
 *
 * Base class for session commands that require database access.
 * Extends DatabaseCommand to provide type-safe persistence with session-specific functionality.
 */

import { DatabaseCommand, DatabaseCommandContext } from "./database-command";
import { CommandExecutionResult } from "../../adapters/shared/command-registry";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

/**
 * Common parameters for session commands
 */
export interface BaseSessionCommandParams {
  name?: string;
  task?: string;
  repo?: string;
  json?: boolean;
}

/**
 * Abstract base class for session commands that require database access
 */
export abstract class DatabaseSessionCommand<TParams = any, TResult = any> extends DatabaseCommand<TParams, TResult> {
  
  /**
   * Session commands belong to the session category
   */
  readonly category = "SESSION";

  /**
   * BACKWARD COMPATIBILITY: Support for old command interface
   * These methods delegate to the new properties for existing tests
   */
  getCommandId(): string {
    return this.id;
  }

  getCommandName(): string {
    return this.name;
  }

  getCommandDescription(): string {
    return this.description;
  }

  getParameterSchema(): any {
    return this.parameters;
  }

  /**
   * BACKWARD COMPATIBILITY: Support for old executeCommand method
   * Delegates to the new execute method with proper context handling
   */
  async executeCommand(params: any, context: any): Promise<any> {
    // If context doesn't have provider, this will be handled by CommandDispatcher
    // For direct test calls, we need to mock the provider
    if (!context.provider) {
      // Initialize PersistenceService for backward compatibility in tests
      try {
        const { PersistenceService } = await import("../../persistence/service");
        if (!PersistenceService.isInitialized()) {
          // Initialize with a mock provider for testing
          await PersistenceService.initialize({
            type: "sqlite",
            database: ":memory:",
          } as any);
        }
        context.provider = PersistenceService.getProvider();
      } catch (error) {
        // Fallback to simple mock if PersistenceService init fails
        context = {
          ...context,
          provider: {
            // Mock provider implementation for tests
            query: () => Promise.resolve([]),
            get: () => Promise.resolve(null),
            insert: () => Promise.resolve({}),
            update: () => Promise.resolve({}),
            delete: () => Promise.resolve({}),
            transaction: (fn: any) => fn({ query: () => Promise.resolve([]) }),
          } as any,
        };
      }
    }
    
    return this.execute(params, context as DatabaseCommandContext);
  }

  /**
   * Create success result with consistent structure
   */
  protected createSuccessResult(
    data: any,
    message?: string,
    additionalData: Record<string, any> = {}
  ): CommandExecutionResult<any> {
    return {
      success: true,
      data: {
        ...data,
        ...(message && { message }),
        ...additionalData,
      },
    };
  }

  /**
   * Create error result with consistent structure
   */
  protected createErrorResult(
    error: string | Error,
    additionalData: Record<string, any> = {}
  ): CommandExecutionResult<any> {
    return {
      success: false,
      error: {
        message: typeof error === "string" ? error : getErrorMessage(error),
        ...additionalData,
      },
    };
  }

  /**
   * Log command errors with consistent format
   * Only logs for debugging purposes, not user-facing output
   */
  protected logError(params: TParams, error: any): void {
    const baseParams = params as BaseSessionCommandParams;

    // Only log detailed error information for debugging, not to user interface
    // The CLI error handler will provide user-friendly error messages
    log.debug(`Error in ${this.id}`, {
      session: baseParams.name,
      task: baseParams.task,
      repo: baseParams.repo,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      command: this.id,
      ...this.getAdditionalLogContext(params),
    });
  }

  /**
   * Get additional context for error logging (override in subclasses)
   */
  protected getAdditionalLogContext(params: TParams): Record<string, any> {
    return {};
  }
}
