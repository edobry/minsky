/**
 * Task Mutation Operations
 *
 * Operations for modifying tasks (create, update status, delete).
 * Extracted from taskCommands.ts as part of modularization effort.
 */
import { readTextFile } from "../../../utils/fs";
import {
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
  taskDeleteParamsSchema,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskDeleteParams,
} from "../../../domain/schemas";

// Import schemas that haven't been migrated yet
import {
  taskCreateFromTitleAndDescriptionParamsSchema,
  type TaskCreateFromTitleAndDescriptionParams,
} from "../../../schemas/tasks";
import { BaseTaskOperation, type TaskOperationDependencies } from "./base-task-operation";
import { createFormattedValidationError } from "../../../utils/zod-error-formatter";
import type { Task } from "../types";

/**
 * Set task status operation
 */
export class SetTaskStatusOperation extends BaseTaskOperation<TaskStatusSetParams, void> {
  getSchema(): import("zod").ZodSchema<TaskStatusSetParams> {
    return taskStatusSetParamsSchema as unknown as import("zod").ZodSchema<TaskStatusSetParams>;
  }

  getOperationName(): string {
    return "set task status";
  }

  async executeOperation(params: TaskStatusSetParams): Promise<void> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task to verify it exists
    await this.getTaskAndVerifyExists(taskService, params.taskId);

    // Set the task status
    await taskService.setTaskStatus(params.taskId, params.status);
  }
}

/**
 * Create task operation
 */
export class CreateTaskOperation extends BaseTaskOperation<TaskCreateParams, Task> {
  getSchema(): import("zod").ZodSchema<TaskCreateParams> {
    return taskCreateParamsSchema as unknown as import("zod").ZodSchema<TaskCreateParams>;
  }

  getOperationName(): string {
    return "create task";
  }

  async executeOperation(params: TaskCreateParams): Promise<Task> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    let description = params.description;

    // If description path is provided, read from file
    if (params.specPath) {
      try {
        description = await readTextFile(params.specPath);
      } catch (error) {
        throw new Error(`Failed to read description from file: ${params.specPath}`);
      }
    }

    // Create the task
    const result = await taskService.createTask(params.title, {
      description,
      force: params.force,
    });

    return result;
  }
}

/**
 * Create task from title and description operation
 */
export class CreateTaskFromTitleAndDescriptionOperation extends BaseTaskOperation<
  TaskCreateFromTitleAndDescriptionParams,
  Task
> {
  getSchema(): import("zod").ZodSchema<TaskCreateFromTitleAndDescriptionParams> {
    return taskCreateFromTitleAndDescriptionParamsSchema as unknown as import("zod").ZodSchema<TaskCreateFromTitleAndDescriptionParams>;
  }

  getOperationName(): string {
    return "create task from title and description";
  }

  async executeOperation(params: TaskCreateFromTitleAndDescriptionParams): Promise<Task> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    let spec = params.spec;

    // If specPath is provided, read from file
    if (params.specPath) {
      try {
        spec = await readTextFile(params.specPath);
      } catch (error) {
        throw new Error(`Failed to read spec from file: ${params.specPath}`);
      }
    }

    // Create the task with title and spec
    const result = await taskService.createTask(params.title, {
      description: spec,
    });

    return result;
  }
}

/**
 * Delete task operation
 */
export class DeleteTaskOperation extends BaseTaskOperation<TaskDeleteParams, { success: boolean; taskId: string; task: Task }> {
  getSchema(): import("zod").ZodSchema<TaskDeleteParams> {
    return taskDeleteParamsSchema as unknown as import("zod").ZodSchema<TaskDeleteParams>;
  }

  getOperationName(): string {
    return "delete task";
  }

  async executeOperation(params: TaskDeleteParams): Promise<{ success: boolean; taskId: string; task: Task }> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task first to verify it exists and get details
    const task = await this.getTaskAndVerifyExists(taskService, params.taskId);

    // Delete the task
    const deleted = await taskService.deleteTask(params.taskId, {
      force: params.force,
    });

    return {
      success: deleted,
      taskId: params.taskId,
      task: task,
    };
  }
}

/**
 * Factory functions for creating mutation operations
 */
export const createSetTaskStatusOperation = (deps?: TaskOperationDependencies) =>
  new SetTaskStatusOperation(deps);

export const createCreateTaskOperation = (deps?: TaskOperationDependencies) =>
  new CreateTaskOperation(deps);

export const createCreateTaskFromTitleAndDescriptionOperation = (
  deps?: TaskOperationDependencies
) => new CreateTaskFromTitleAndDescriptionOperation(deps);

export const createDeleteTaskOperation = (deps?: TaskOperationDependencies) =>
  new DeleteTaskOperation(deps);