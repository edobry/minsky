/**
 * Task CRUD Commands
 * 
 * Commands for creating, reading, updating, and deleting tasks.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { type CommandExecutionContext } from "../../command-registry";
import {
  listTasksFromParams,
  getTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  deleteTaskFromParams,
} from "../../../../domain/tasks";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import {
  tasksListParams,
  tasksGetParams,
  tasksCreateParams,
  tasksDeleteParams,
} from "./task-parameters";

/**
 * Parameters for tasks list command
 */
interface TasksListParams extends BaseTaskParams {
  all?: boolean;
  status?: string;
  filter?: string;
  limit?: number;
}

/**
 * Parameters for tasks get command
 */
interface TasksGetParams extends BaseTaskParams {
  taskId: string;
}

/**
 * Parameters for tasks create command
 */
interface TasksCreateParams extends BaseTaskParams {
  title: string;
  description?: string;
  descriptionPath?: string;
  force?: boolean;
}

/**
 * Parameters for tasks delete command
 */
interface TasksDeleteParams extends BaseTaskParams {
  taskId: string;
  force?: boolean;
}

/**
 * Task list command implementation
 */
export class TasksListCommand extends BaseTaskCommand {
  readonly id = "tasks.list";
  readonly name = "list";
  readonly description = "List tasks with optional filtering";
  readonly parameters = tasksListParams;

  async execute(params: TasksListParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.list execution");

    // List tasks with filters
    const tasks = await listTasksFromParams({
      ...this.createTaskParams(params),
      all: params.all,
      status: params.status,
      filter: params.filter,
      limit: params.limit,
    });

    this.debug(`Found ${tasks.length} tasks`);

    return this.formatResult(
      {
        success: true,
        count: tasks.length,
        tasks,
        message: `Found ${tasks.length} tasks`,
      },
      params.json
    );
  }
}

/**
 * Task get command implementation
 */
export class TasksGetCommand extends BaseTaskCommand {
  readonly id = "tasks.get";
  readonly name = "get";
  readonly description = "Get details of a specific task";
  readonly parameters = tasksGetParams;

  async execute(params: TasksGetParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.get execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const normalizedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task details
    const task = await getTaskFromParams({
      ...this.createTaskParams(params),
      taskId: normalizedTaskId,
    });

    this.debug("Task retrieved successfully");

    return this.formatResult(
      this.createSuccessResult(normalizedTaskId, `Task ${normalizedTaskId} retrieved`, {
        task,
      }),
      params.json
    );
  }
}

/**
 * Task create command implementation
 */
export class TasksCreateCommand extends BaseTaskCommand {
  readonly id = "tasks.create";
  readonly name = "create";
  readonly description = "Create a new task";
  readonly parameters = tasksCreateParams;

  async execute(params: TasksCreateParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.create execution");

    // Validate required parameters
    const title = this.validateRequired(params.title, "title");

    // Validate that either description or descriptionPath is provided
    if (!params.description && !params.descriptionPath) {
      throw new ValidationError("Either --description or --description-path must be provided");
    }

    // Both description and descriptionPath provided is an error
    if (params.description && params.descriptionPath) {
      throw new ValidationError(
        "Cannot provide both --description and --description-path - use one or the other"
      );
    }

    // Create the task using the same function as main branch
    const result = await createTaskFromTitleAndDescription({
      title: params.title,
      description: params.description,
      descriptionPath: params.descriptionPath,
      force: params.force ?? false,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });

    this.debug("Task created successfully");

    const message = `Task ${result.taskId} created: "${result.title}"`;

    return this.formatResult(
      this.createSuccessResult(result.taskId, message, {
        task: result,
      }),
      params.json
    );
  }
}

/**
 * Task delete command implementation
 */
export class TasksDeleteCommand extends BaseTaskCommand {
  readonly id = "tasks.delete";
  readonly name = "delete";
  readonly description = "Delete a task";
  readonly parameters = tasksDeleteParams;

  async execute(params: TasksDeleteParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.delete execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const normalizedTaskId = this.validateAndNormalizeTaskId(taskId);

    // If not forced, prompt for confirmation
    if (!params.force) {
      await this.confirmDeletion(normalizedTaskId, params);
    }

    // Delete the task
    const result = await deleteTaskFromParams({
      ...this.createTaskParams(params),
      taskId: normalizedTaskId,
      force: params.force ?? false,
    });

    const message = result.success
      ? `Task ${normalizedTaskId} deleted successfully`
      : `Failed to delete task ${normalizedTaskId}`;

    this.debug("Task deletion completed");

    return this.formatResult(
      {
        success: result.success,
        taskId: normalizedTaskId,
        task: result.task,
        message,
      },
      params.json
    );
  }

  /**
   * Confirm task deletion with user
   */
  private async confirmDeletion(taskId: string, params: TasksDeleteParams): Promise<void> {
    // Get task details for confirmation
    const task = await getTaskFromParams({
      ...this.createTaskParams(params),
      taskId,
    });

    // Import confirm from @clack/prompts for confirmation
    const { confirm, isCancel } = await import("@clack/prompts");

    const shouldDelete = await confirm({
      message: `Are you sure you want to delete task ${task.id}: "${task.title}"?`,
    });

    if (isCancel(shouldDelete) || !shouldDelete) {
      throw new Error("Task deletion cancelled");
    }
  }
}

/**
 * Factory functions for creating command instances
 */
export const createTasksListCommand = (): TasksListCommand => 
  new TasksListCommand();

export const createTasksGetCommand = (): TasksGetCommand => 
  new TasksGetCommand();

export const createTasksCreateCommand = (): TasksCreateCommand => 
  new TasksCreateCommand();

export const createTasksDeleteCommand = (): TasksDeleteCommand => 
  new TasksDeleteCommand();