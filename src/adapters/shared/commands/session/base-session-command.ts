/**
 * Base Session Command
 *
 * Abstract base class providing common functionality for all session commands.
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";
import { getErrorMessage, ValidationError } from "../../../../errors/index";
import { log } from "../../../../utils/logger";
import { CommandCategory, type CommandExecutionContext } from "../../command-registry";

/**
 * Common dependencies for session commands
 */
export interface SessionCommandDependencies {
  // Session domain functions - will be injected
  [key: string]: any;
}

/**
 * Default dependencies for session commands
 */
export const defaultSessionCommandDependencies: SessionCommandDependencies = {
  // Import session domain functions dynamically to avoid circular dependencies
};

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
 * Abstract base class for session commands
 */
export abstract class BaseSessionCommand<TParams, TResult> {
  constructor(protected deps: SessionCommandDependencies = defaultSessionCommandDependencies) {}

  /**
   * Get the Zod schema for validating parameters
   */
  abstract getParameterSchema(): Record<string, any>;

  /**
   * Execute the command with validated parameters
   */
  abstract executeCommand(params: TParams, context: CommandExecutionContext): Promise<TResult>;

  /**
   * Get the command ID (for registration)
   */
  abstract getCommandId(): string;

  /**
   * Get the command name
   */
  abstract getCommandName(): string;

  /**
   * Get the command description
   */
  abstract getCommandDescription(): string;

  /**
   * Get the command category
   */
  getCommandCategory(): string {
    return CommandCategory.SESSION;
  }

  /**
   * Execute the command with full validation and error handling
   */
  async execute(params: TParams, context: CommandExecutionContext): Promise<TResult> {
    try {
      log.debug(`Executing ${this.getCommandId()} command`, { params, context });

      // Execute the command
      const result = await this.executeCommand(params, context);

      return result;
    } catch (error) {
      // Enhanced error logging with command context
      this.logError(params, error);
      throw error;
    }
  }

  /**
   * Log command errors with consistent format
   */
  protected logError(params: TParams, error: any): void {
    const baseParams = params as BaseSessionCommandParams;
    log.error(`Error in ${this.getCommandId()}`, {
      session: baseParams.name,
      task: baseParams.task,
      repo: baseParams.repo,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
      command: this.getCommandId(),
      ...this.getAdditionalLogContext(params),
    });
  }

  /**
   * Get additional context for error logging (override in subclasses)
   */
  protected getAdditionalLogContext(params: TParams): Record<string, any> {
    return {};
  }

  /**
   * Create success result with consistent structure
   */
  protected createSuccessResult(
    data: any,
    message?: string,
    additionalData: Record<string, any> = {}
  ): any {
    return {
      success: true,
      ...data,
      ...(message && { message }),
      ...additionalData,
    };
  }

  /**
   * Create error result with consistent structure
   */
  protected createErrorResult(
    error: string | Error,
    additionalData: Record<string, any> = {}
  ): any {
    return {
      success: false,
      error: typeof error === "string" ? error : getErrorMessage(error),
      ...additionalData,
    };
  }

  /**
   * Get command registration data
   */
  getRegistrationData() {
    return {
      id: this.getCommandId(),
      category: this.getCommandCategory(),
      name: this.getCommandName(),
      description: this.getCommandDescription(),
      parameters: this.getParameterSchema(),
      execute: (params: Record<string, any>, context: CommandExecutionContext) =>
        this.execute(params as TParams, context),
    };
  }
}

/**
 * Factory type for creating session commands
 */
export type SessionCommandFactory<TParams, TResult> = (
  deps?: SessionCommandDependencies
) => BaseSessionCommand<TParams, TResult>;

/**
 * Session command registry for managing command instances
 */
export class SessionCommandRegistry {
  private commands = new Map<string, BaseSessionCommand<any, any>>();

  /**
   * Register a session command
   */
  register<TParams, TResult>(id: string, command: BaseSessionCommand<TParams, TResult>): void {
    this.commands.set(id, command);
  }

  /**
   * Get a session command by ID
   */
  get<TParams, TResult>(id: string): BaseSessionCommand<TParams, TResult> | undefined {
    return this.commands.get(id);
  }

  /**
   * Execute a command by ID
   */
  async execute<TParams, TResult>(
    id: string,
    params: TParams,
    context: CommandExecutionContext
  ): Promise<TResult> {
    const command = this.get<TParams, TResult>(id);
    if (!command) {
      throw new ValidationError(`Session command '${id}' not found`);
    }
    return await command.execute(params, context);
  }

  /**
   * Get all registered command IDs
   */
  getCommandIds(): string[] {
    return Array.from(this.commands.keys());
  }

  /**
   * Get all commands for registration
   */
  getAllCommands(): Array<{ id: string; registrationData: any }> {
    return Array.from(this.commands.entries()).map(([id, command]) => ({
      id,
      registrationData: command.getRegistrationData(),
    }));
  }

  /**
   * Clear all commands (useful for testing)
   */
  clear(): void {
    this.commands.clear();
  }
}

/**
 * Default session command registry instance
 */
export const sessionCommandRegistry = new SessionCommandRegistry();
