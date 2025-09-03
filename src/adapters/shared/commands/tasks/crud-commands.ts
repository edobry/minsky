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
  createTaskFromTitleAndSpec,
  deleteTaskFromParams,
} from "../../../../domain/tasks";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
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
  spec?: string;
  specPath?: string;
  force?: boolean;
  githubRepo?: string;
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
    this.debug(`Context format: ${ctx.format}, params.json: ${params.json}`);

    // List tasks with filters
    let tasks = await listTasksFromParams({
      ...this.createTaskParams(params),
      all: params.all,
      status: params.status,
      filter: params.filter,
      limit: params.limit,
    });

    // Apply shared filters for backend/time at adapter level (until domain exposes them)
    try {
      const { parseTime, filterByTimeRange } = require("../../../../utils/result-handling/filters");
      const sinceTs = parseTime((params as any).since);
      const untilTs = parseTime((params as any).until);
      tasks = filterByTimeRange(tasks, sinceTs, untilTs);
    } catch {
      // If utilities unavailable, skip
    }

    this.debug(`Found ${tasks.length} tasks`);
    const wantJson = params.json || ctx.format === "json";
    if (wantJson) {
      // For JSON output, return tasks array only
      return tasks;
    }

    return this.formatResult(
      {
        success: true,
        count: tasks.length,
        tasks,
        message: `Found ${tasks.length} tasks`,
      },
      false
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
    const startTime = Date.now();
    this.debug("Starting tasks.get execution", { params, context: ctx });

    try {
      // Validate and normalize task ID
      this.debug("Validating task ID");
      const taskId = this.validateRequired(params.taskId, "taskId");
      const validatedTaskId = this.validateAndNormalizeTaskId(taskId);
      this.debug("Task ID validated and normalized", { taskId, validatedTaskId });

      // Get task details
      this.debug("About to call getTaskFromParams");
      const taskParams = {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
      };
      this.debug("Created task params", { taskParams });

      const task = await getTaskFromParams(taskParams);
      this.debug("Task retrieved successfully", { task: task?.id || "unknown" });

      const result = this.formatResult(
        this.createSuccessResult(validatedTaskId, `Task ${validatedTaskId} retrieved`, {
          task,
        }),
        params.json
      );

      const duration = Date.now() - startTime;
      this.debug("tasks.get execution completed", { duration });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.debug("tasks.get execution failed", {
        error: error instanceof Error ? error.message : String(error),
        duration,
      });
      throw error;
    }
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

    try {
      // Validate required parameters
      const title = this.validateRequired(params.title, "title");

      // Validate that either description or specPath is provided
      if (!params.description && !params.specPath) {
        throw new ValidationError("Either --description or --spec-path must be provided");
      }

      // Both description and specPath provided is an error
      if (params.description && params.specPath) {
        throw new ValidationError(
          "Cannot provide both --description and --spec-path - use one or the other"
        );
      }

      // Create the task using the same function as main branch
      const result = await createTaskFromTitleAndSpec({
        title: params.title,
        spec: params.description, // Map description to spec
        specPath: params.specPath,
        force: params.force ?? false,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        githubRepo: params.githubRepo,
      });

      this.debug("Task created successfully");

      // Build success message
      let message = `Task ${result.taskId} created: "${result.title}"`;
      if (!params.json) {
        const { default: chalk } = await import("chalk");
        if (params.specPath) {
          message = chalk.green(`✅ Task ${result.taskId} created successfully with specification`);
        } else {
          message = chalk.green(`✅ Task ${result.taskId} created successfully`);
        }
        message += `\n${chalk.gray("  Title: ")}${result.title}`;
        message += `\n${chalk.gray("  ID: ")}${result.taskId}`;
      }

      return this.formatResult(
        this.createSuccessResult(result.taskId, message, {
          task: result,
        }),
        params.json
      );
    } catch (error) {
      this.debug(`Task creation failed: ${error.message}`);

      // Ensure non-zero exit code
      process.exitCode = 1;

      // Build actionable error message
      if (!params.json) {
        const { default: chalk } = await import("chalk");
        let errorMessage = chalk.red(`❌ Failed to create task: ${error.message}`);

        if (error.message.includes("spec from file")) {
          errorMessage += `\n${chalk.yellow(
            "   Tip: Check that the file exists and you have read permissions."
          )}`;
        }

        const formattedError = new Error(errorMessage);
        formattedError.stack = error.stack;
        throw formattedError;
      }

      throw error;
    }
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
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // If not forced, prompt for confirmation
    if (!params.force) {
      await this.confirmDeletion(validatedTaskId, params);
    }

    // Delete the task
    const result = await deleteTaskFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
      force: params.force ?? false,
    });

    const message = result.success
      ? `Task ${validatedTaskId} deleted successfully`
      : `Failed to delete task ${validatedTaskId}`;

    this.debug("Task deletion completed");

    return this.formatResult(
      {
        success: result.success,
        taskId: validatedTaskId,
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

    // Guard against null task to avoid accessing properties on null
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

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
export const createTasksListCommand = (): TasksListCommand => new TasksListCommand();

export const createTasksGetCommand = (): TasksGetCommand => new TasksGetCommand();

export const createTasksCreateCommand = (): TasksCreateCommand => new TasksCreateCommand();

export const createTasksDeleteCommand = (): TasksDeleteCommand => new TasksDeleteCommand();
