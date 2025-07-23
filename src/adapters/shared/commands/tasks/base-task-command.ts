/**
 * Base Task Command
 *
 * Abstract base class providing common functionality for all task commands.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { CommandCategory, type CommandExecutionContext } from "../../command-registry";
import { normalizeTaskId } from "../../../../domain/tasks";
import { ValidationError } from "../../../../errors/index";
import { log } from "../../../../utils/logger";

/**
 * Common interface for task command parameters
 */
export interface BaseTaskParams {
  taskId?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
  json?: boolean;
}

/**
 * Task command result interface
 */
export interface TaskCommandResult {
  success: boolean;
  taskId?: string;
  message?: string;
  [key: string]: any;
}

/**
 * Abstract base class for task commands
 */
export abstract class BaseTaskCommand {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: any;

  /**
   * Command category (always TASKS)
   */
  get category(): CommandCategory {
    return CommandCategory.TASKS;
  }

  /**
   * Execute the command (to be implemented by subclasses)
   */
  abstract execute(params: any, context: CommandExecutionContext): Promise<any>;

  /**
   * Validate and normalize task ID
   */
  protected validateAndNormalizeTaskId(taskId: string): string {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    return normalizedTaskId;
  }

  /**
   * Validate required parameter
   */
  protected validateRequired<T>(value: T | undefined, paramName: string): T {
    if (value === undefined || value === null) {
      throw new ValidationError(`Missing required parameter: ${paramName}`);
    }
    return value;
  }

  /**
   * Log debug message with command context
   */
  protected debug(message: string): void {
    log.debug(`[${this.id}] ${message}`);
  }

  /**
   * Log error message with command context
   */
  protected error(message: string, error?: any): void {
    log.error(`[${this.id}] ${message}`, error);
  }

  /**
   * Create task command parameters with common fields
   */
  protected createTaskParams(params: BaseTaskParams): any {
    return {
      taskId: params.taskId,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      backend: params.backend,
    };
  }

  /**
   * Format result based on JSON flag
   */
  protected formatResult(result: any, json: boolean = false): any {
    if (json) {
      // Return structured data for programmatic use
      return result;
    } else {
      // Return simple message for user-friendly output
      if (typeof result === "object" && result.message) {
        return result.message;
      }
      return result;
    }
  }

  /**
   * Create success result
   */
  protected createSuccessResult(
    taskId: string,
    message: string,
    additionalData: Record<string, any> = {}
  ): TaskCommandResult {
    return {
      success: true,
      taskId,
      message,
      ...additionalData,
    };
  }

  /**
   * Create error result
   */
  protected createErrorResult(
    message: string,
    taskId?: string,
    additionalData: Record<string, any> = {}
  ): TaskCommandResult {
    return {
      success: false,
      message,
      ...(taskId && { taskId }),
      ...additionalData,
    };
  }

  /**
   * Get command registration object
   */
  getRegistration() {
    return {
      id: this.id,
      category: this.category,
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      execute: this.execute.bind(this),
    };
  }
}

/**
 * Factory function type for creating task commands
 */
export type TaskCommandFactory = () => BaseTaskCommand;

/**
 * Task command registry for managing command instances
 */
export class TaskCommandRegistry {
  private commands = new Map<string, BaseTaskCommand>();

  /**
   * Register a task command
   */
  register(command: BaseTaskCommand): void {
    this.commands.set(command.id, command);
  }

  /**
   * Get a task command by ID
   */
  get(commandId: string): BaseTaskCommand | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Get all registered commands
   */
  getAll(): BaseTaskCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Get all command registrations
   */
  getAllRegistrations() {
    return this.getAll().map((cmd) => cmd.getRegistration());
  }

  /**
   * Clear all commands (useful for testing)
   */
  clear(): void {
    this.commands.clear();
  }
}

/**
 * Default task command registry instance
 */
export const taskCommandRegistry = new TaskCommandRegistry();
