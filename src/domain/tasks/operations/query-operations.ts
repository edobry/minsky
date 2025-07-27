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
} from "../../../schemas/tasks";
import { BaseTaskOperation, type TaskOperationDependencies } from "./base-task-operation";

/**
 * List tasks operation
 */
export class ListTasksOperation extends BaseTaskOperation<TaskListParams, any[]> {
  getSchema() {
    return taskListParamsSchema;
  }

  getOperationName(): string {
    return "list tasks";
  }

  async executeOperation(params: TaskListParams): Promise<any[]> {
    // Setup workspace and service
    const { taskService } = await this.setupWorkspaceAndService(params);

    // Get tasks
    let tasks = await taskService.listTasks();

    // Filter by status if provided
    if (params.filter) {
      tasks = tasks.filter((task: any) => task.status === params.filter);
    } else {
      // Unless "all" is provided, filter out DONE and CLOSED tasks
      if (!params.all) {
        tasks = tasks.filter(
          (task: any) => task.status !== TASK_STATUS.DONE && task.status !== TASK_STATUS.CLOSED
        );
      }
    }

    return tasks;
  }
}

/**
 * Get task operation
 */
export class GetTaskOperation extends BaseTaskOperation<TaskGetParams, any> {
  getSchema() {
    return taskGetParamsSchema;
  }

  getOperationName(): string {
    return "get task";
  }

  async executeOperation(params: TaskGetParams): Promise<any> {
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
  getSchema() {
    return taskStatusGetParamsSchema;
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
  getSchema() {
    return taskSpecContentParamsSchema;
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

    return specContent;
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
