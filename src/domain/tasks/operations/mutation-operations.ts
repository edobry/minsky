/**
 * Task Mutation Operations
 *
 * Operations for modifying tasks (create, update status, delete).
 * Extracted from taskCommands.ts as part of modularization effort.
 */
import { readFile } from "fs/promises";
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

/**
 * Set task status operation
 */
export class SetTaskStatusOperation extends BaseTaskOperation<TaskStatusSetParams, any> {
  getSchema() {
    return taskStatusSetParamsSchema;
  }

  getOperationName(): string {
    return "set task status";
  }

  async executeOperation(params: TaskStatusSetParams): Promise<any> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task to verify it exists
    await this.getTaskAndVerifyExists(taskService, params.taskId);

    // Set the task status
    const result = await taskService.setTaskStatus(params.taskId, params.status);

    return result;
  }
}

/**
 * Create task operation
 */
export class CreateTaskOperation extends BaseTaskOperation<TaskCreateParams, any> {
  getSchema() {
    return taskCreateParamsSchema;
  }

  getOperationName(): string {
    return "create task";
  }

  async executeOperation(params: TaskCreateParams): Promise<any> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    let description = params.description;

    // If description path is provided, read from file
    if (params.descriptionPath) {
      try {
        description = await readFile(params.descriptionPath, "utf-8");
      } catch (error) {
        throw new Error(`Failed to read description from file: ${params.descriptionPath}`);
      }
    }

    // Create the task
    const result = await taskService.createTask({
      title: params.title,
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
  any
> {
  getSchema() {
    return taskCreateFromTitleAndDescriptionParamsSchema;
  }

  getOperationName(): string {
    return "create task from title and description";
  }

  async executeOperation(params: TaskCreateFromTitleAndDescriptionParams): Promise<any> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Create the task with title and description
    const result = await taskService.createTask({
      title: params.title,
      description: params.description,
    });

    return result;
  }
}

/**
 * Delete task operation
 */
export class DeleteTaskOperation extends BaseTaskOperation<TaskDeleteParams, any> {
  getSchema() {
    return taskDeleteParamsSchema;
  }

  getOperationName(): string {
    return "delete task";
  }

  async executeOperation(params: TaskDeleteParams): Promise<any> {
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
