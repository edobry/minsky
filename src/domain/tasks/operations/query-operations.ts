/**
 * Task Query Operations
 *
 * Operations for querying tasks (list, get, status, spec).
 * Extracted from taskCommands.ts as part of modularization effort.
 */
import { readFile } from "fs/promises";
import { TASK_STATUS } from "../taskConstants";
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskSpecContentParams,
} from "../../../domain/schemas";
import { BaseTaskOperation, type TaskOperationDependencies } from "./base-task-operation";
import type { Task } from "../types";

/**
 * List tasks operation
 */
export class ListTasksOperation extends BaseTaskOperation<TaskListParams, Task[]> {
  getSchema(): import("zod").ZodSchema<TaskListParams> {
    return taskListParamsSchema as unknown as import("zod").ZodSchema<TaskListParams>;
  }

  getOperationName(): string {
    return "list tasks";
  }

  async executeOperation(params: TaskListParams): Promise<Task[]> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get tasks - delegate all filtering to domain layer
    const tasks = await taskService.listTasks({
      status: params.filter as string,
      all: params.all,
    });

    return tasks;
  }
}

/**
 * Get task operation
 */
export class GetTaskOperation extends BaseTaskOperation<TaskGetParams, Task> {
  getSchema(): import("zod").ZodSchema<TaskGetParams> {
    return taskGetParamsSchema as unknown as import("zod").ZodSchema<TaskGetParams>;
  }

  getOperationName(): string {
    return "get task";
  }

  async executeOperation(params: TaskGetParams): Promise<Task> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task and verify it exists
    const task = await this.getTaskAndVerifyExists(taskService, params.taskId);

    return task;
  }
}

/**
 * Get task status operation
 */
export class GetTaskStatusOperation extends BaseTaskOperation<TaskStatusGetParams, string> {
  getSchema(): import("zod").ZodSchema<TaskStatusGetParams> {
    return taskStatusGetParamsSchema as unknown as import("zod").ZodSchema<TaskStatusGetParams>;
  }

  getOperationName(): string {
    return "get task status";
  }

  async executeOperation(params: TaskStatusGetParams): Promise<string> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task and verify it exists
    const task = await this.getTaskAndVerifyExists(taskService, params.taskId);

    return task.status;
  }
}

/**
 * Get task specification content operation
 */
export class GetTaskSpecContentOperation extends BaseTaskOperation<TaskSpecContentParams, string> {
  getSchema(): import("zod").ZodSchema<TaskSpecContentParams> {
    return taskSpecContentParamsSchema as unknown as import("zod").ZodSchema<TaskSpecContentParams>;
  }

  getOperationName(): string {
    return "get task specification";
  }

  async executeOperation(params: TaskSpecContentParams): Promise<string> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get the task to verify it exists
    await this.getTaskAndVerifyExists(taskService, params.taskId);

    // Get the task specification content
    const specContent = await taskService.getTaskSpecContent(params.taskId, params.section);

    return specContent.content;
  }
}

/**
 * Factory functions for creating query operations
 */
export const createListTasksOperation = (deps?: TaskOperationDependencies) =>
  new ListTasksOperation(deps);

export const createGetTaskOperation = (deps?: TaskOperationDependencies) =>
  new GetTaskOperation(deps);

export const createGetTaskStatusOperation = (deps?: TaskOperationDependencies) =>
  new GetTaskStatusOperation(deps);

export const createGetTaskSpecContentOperation = (deps?: TaskOperationDependencies) =>
  new GetTaskSpecContentOperation(deps);
