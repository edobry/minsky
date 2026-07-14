/**
 * Base Task Command
 *
 * Abstract base class providing common functionality for all task commands.
 * Extracted from tasks.ts as part of modularization effort.
 */
import {
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type InferParams,
} from "../../command-registry";
import { ValidationError } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import { isQualifiedTaskId } from "@minsky/domain/tasks/task-id";

/**
 * Common task-scoping fields shared across task commands.
 *
 * NOT a handler param type (mt#2779): execute handlers derive their param
 * types from the command's params map via `InferParams<TMap>`. This interface
 * only types the field-projection input of `createTaskParams`, which accepts
 * any params object that MAY carry the common scoping fields.
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
  [key: string]: unknown;
}

/**
 * Abstract base class for task commands.
 *
 * The generic is the command's params MAP type (`typeof <map const>`), not a
 * hand-rolled interface (mt#2779): `parameters` is typed as the map itself and
 * `execute`'s param type is DERIVED from it via `InferParams`, so a handler
 * reading an undeclared `params.<key>` is a compile error. Subclasses:
 *
 * ```ts
 * export class TasksFooCommand extends BaseTaskCommand<typeof tasksFooParams> {
 *   readonly parameters = tasksFooParams;
 *   async execute(params: InferParams<typeof tasksFooParams>, ctx: CommandExecutionContext) { ... }
 * }
 * ```
 */
export abstract class BaseTaskCommand<
  TMap extends CommandParameterMap = CommandParameterMap,
  TResult = unknown,
> {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: TMap;

  /**
   * Command category (always TASKS)
   */
  get category(): CommandCategory {
    return CommandCategory.TASKS;
  }

  /**
   * Execute the command (to be implemented by subclasses)
   */
  abstract execute(params: InferParams<TMap>, context: CommandExecutionContext): Promise<TResult>;

  /**
   * Validate task ID for multi-backend support (qualified IDs only)
   */
  protected validateAndNormalizeTaskId(taskId: string): string {
    // Check if it's a qualified ID
    if (isQualifiedTaskId(taskId)) {
      return taskId; // Already qualified, return as-is
    }

    // Invalid format
    throw new ValidationError(
      `Invalid task ID: '${taskId}'. Please provide a qualified task ID (md#123, gh#456).`
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
  protected debug(message: string, context?: Record<string, unknown>): void {
    if (context) {
      log.debug(`[${this.id}] ${message}`, context);
    } else {
      log.debug(`[${this.id}] ${message}`);
    }
  }

  /**
   * Log error message with command context
   */
  protected error(message: string, error?: unknown): void {
    log.error(`[${this.id}] ${message}`, error as Record<string, unknown>);
  }

  /**
   * Create task command parameters with common fields
   */
  protected createTaskParams(params: BaseTaskParams): Record<string, unknown> {
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
  protected formatResult(result: unknown, json: boolean = false): unknown {
    if (json) {
      // Return structured data for programmatic use
      return result;
    } else {
      // Handle special case for task lists - display actual tasks
      if (
        typeof result === "object" &&
        result !== null &&
        "tasks" in result &&
        Array.isArray((result as Record<string, unknown>).tasks)
      ) {
        // Import formatTaskIdForDisplay locally to avoid circular dependencies
        const { formatTaskIdForDisplay } = require("@minsky/domain/tasks/task-id-utils");
        const tasks = (result as Record<string, unknown>).tasks as Array<Record<string, unknown>>;

        if (tasks.length === 0) {
          return "No tasks found.";
        }

        // Format each task for display (strict: derive from id only)
        const taskList = tasks
          .map((task) => {
            const displayId = formatTaskIdForDisplay(task.id);
            return `${displayId}: ${task.title} [${task.status}]`;
          })
          .join("\n");

        return taskList;
      }

      // Handle individual task details
      if (typeof result === "object" && result !== null && "task" in result) {
        const taskResult = result as Record<string, unknown>;

        // Prefer the pre-built message — commands build it with full context
        // (spec content, dep warnings, edit details, etc.) that the generic
        // formatter below would lose.
        if (taskResult.message && typeof taskResult.message === "string") {
          return taskResult.message;
        }

        const task = taskResult.task;
        if (task && typeof task === "object" && !Array.isArray(task)) {
          const { formatTaskIdForDisplay } = require("@minsky/domain/tasks/task-id-utils");
          const taskObj = task as Record<string, unknown>;
          const displayId = formatTaskIdForDisplay(taskObj.id);

          let output = `${displayId}: ${taskObj.title}\n`;
          output += `Status: ${taskObj.status}\n`;

          if (taskObj.spec) {
            output += `Spec: ${taskObj.spec}\n`;
          }

          // Display subtask summary if present
          if (
            taskResult.subtasks &&
            typeof taskResult.subtasks === "object" &&
            taskResult.subtasks !== null
          ) {
            const subtasks = taskResult.subtasks as {
              total: number;
              done: number;
              remaining: Array<{ id: string; title: string; status: string }>;
            };
            output += `\nSubtasks: ${subtasks.done} of ${subtasks.total} done\n`;
            if (subtasks.remaining.length > 0) {
              output += `Remaining:\n`;
              for (const sub of subtasks.remaining) {
                output += `  ${sub.id}: ${sub.title} [${sub.status}]\n`;
              }
            }
          }

          return output.trim();
        }
      }

      // Return simple message for other results
      if (typeof result === "object" && result !== null && "message" in result) {
        return (result as Record<string, unknown>).message;
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
    additionalData: Record<string, unknown> = {}
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
    additionalData: Record<string, unknown> = {}
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
 * Widest task-command type: any command regardless of its concrete params map.
 * Method bivariance makes every `BaseTaskCommand<typeof someMap>` assignable.
 */
export type AnyTaskCommand = BaseTaskCommand<CommandParameterMap, unknown>;

/**
 * Factory function type for creating task commands
 */
export type TaskCommandFactory = () => AnyTaskCommand;

/**
 * Task command registry for managing command instances
 */
export class TaskCommandRegistry {
  private commands = new Map<string, AnyTaskCommand>();

  /**
   * Register a task command
   */
  register(command: AnyTaskCommand): void {
    this.commands.set(command.id, command);
  }

  /**
   * Get a task command by ID
   */
  get(commandId: string): AnyTaskCommand | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Get all registered commands
   */
  getAll(): AnyTaskCommand[] {
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
