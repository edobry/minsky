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
   * Validate and normalize task ID for multi-backend support
   */
  protected validateAndNormalizeTaskId(taskId: string): string {
    // Import unified task ID utilities
    const {
      isQualifiedTaskId,
      isLegacyTaskId,
      migrateUnqualifiedTaskId,
    } = require("../../../../domain/tasks/unified-task-id");

    // First, check if it's already a qualified ID
    if (isQualifiedTaskId(taskId)) {
      return taskId; // Already qualified, return as-is
    }

    // Check if it's a legacy format that can be migrated
    if (isLegacyTaskId(taskId)) {
      const normalizedTaskId = migrateUnqualifiedTaskId(taskId, "md"); // Default to markdown backend
      this.debug(`Migrated legacy task ID '${taskId}' to '${normalizedTaskId}'`);
      return normalizedTaskId;
    }

    // Invalid format
    throw new ValidationError(
      `Invalid task ID: '${taskId}'. Please provide either a qualified task ID (md#123, gh#456) or legacy format (123, task#123, #123).`
    );
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
   * Format command results for output
   */
  protected formatResult(result: any, json: boolean = false): any {
    if (json) {
      // Return structured data for programmatic use
      return result;
    } else {
      // Handle special case for task lists - display actual tasks
      if (typeof result === "object" && result.tasks && Array.isArray(result.tasks)) {
        // Import formatTaskIdForDisplay locally to avoid circular dependencies
        const { formatTaskIdForDisplay } = require("../../../../domain/tasks/task-id-utils");

        if (result.tasks.length === 0) {
          return "No tasks found.";
        }

        // Format each task for display
        const taskList = result.tasks
          .map((task: any) => {
            const displayId = formatTaskIdForDisplay(task.id);
            return `${displayId}: ${task.title} [${task.status}]`;
          })
          .join("\n");

        return taskList;
      }

      // Handle individual task details
      if (typeof result === "object" && result.task && !Array.isArray(result.task)) {
        const { formatTaskIdForDisplay } = require("../../../../domain/tasks/task-id-utils");
        const task = result.task;
        const displayId = formatTaskIdForDisplay(task.id);

        let output = `${displayId}: ${task.title}\n`;
        output += `Status: ${task.status}\n`;

        if (task.description && task.description.trim()) {
          output += `Description: ${task.description.trim()}\n`;
        }

        if (task.specPath) {
          output += `Spec: ${task.specPath}\n`;
        }

        return output.trim();
      }

      // Return simple message for other results
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
