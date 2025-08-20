/**
 * Task Status Commands
 *
 * Commands for getting and setting task status.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { select, isCancel, cancel } from "@clack/prompts";
import { type CommandExecutionContext } from "../../command-registry";
import { getTaskStatusFromParams, setTaskStatusFromParams } from "../../../../domain/tasks";
import { ValidationError } from "../../../../errors/index";
import { TASK_STATUS } from "../../../../domain/tasks/taskConstants";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksStatusGetParams, tasksStatusSetParams } from "./task-parameters";

/**
 * Parameters for tasks status get command
 */
interface TasksStatusGetParams extends BaseTaskParams {
  taskId: string;
}

/**
 * Parameters for tasks status set command
 */
interface TasksStatusSetParams extends BaseTaskParams {
  taskId: string;
  status?: string;
}

/**
 * Task status get command implementation
 */
export class TasksStatusGetCommand extends BaseTaskCommand {
  readonly id = "tasks.status.get";
  readonly name = "status get";
  readonly description = "Get the status of a task";
  readonly parameters = tasksStatusGetParams;

  async execute(params: TasksStatusGetParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.status.get execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task status
    const status = await getTaskStatusFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
    });

    this.debug("Task status retrieved successfully");

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, `Task ${validatedTaskId} status: ${status}`, {
        status,
      }),
      params.json
    );
  }
}

/**
 * Task status set command implementation
 */
export class TasksStatusSetCommand extends BaseTaskCommand {
  readonly id = "tasks.status.set";
  readonly name = "status set";
  readonly description = "Set the status of a task";
  readonly parameters = tasksStatusSetParams;

  async execute(params: TasksStatusSetParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.status.set execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Verify the task exists before prompting for status and get current status
    this.debug("Getting previous status");
    const previousStatus = await getTaskStatusFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
    });
    this.debug("Previous status retrieved successfully");

    let status = params.status;

    // If status is not provided, prompt for it interactively
    if (!status) {
      status = await this.promptForStatus(previousStatus);
    }

    // Set the task status
    this.debug("Setting task status");
    const result = await setTaskStatusFromParams({
      ...this.createTaskParams(params),
      taskId: validatedTaskId,
      status,
    });

    const message = `Task ${validatedTaskId} status changed from ${previousStatus} to ${status}`;
    this.debug("Task status set successfully");

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        previousStatus,
        newStatus: status,
        result,
      }),
      params.json
    );
  }

  /**
   * Prompt user for status selection
   */
  private async promptForStatus(currentStatus: string): Promise<string> {
    // Check if we're in an interactive environment
    if (!process.stdout.isTTY) {
      throw new ValidationError("Status parameter is required in non-interactive mode");
    }

    // Define the options array for consistency
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.IN_PROGRESS, label: "IN-PROGRESS" },
      { value: TASK_STATUS.IN_REVIEW, label: "IN-REVIEW" },
      { value: TASK_STATUS.DONE, label: "DONE" },
      { value: TASK_STATUS.BLOCKED, label: "BLOCKED" },
      { value: TASK_STATUS.CLOSED, label: "CLOSED" },
    ];

    // Find the index of the current status to pre-select it
    const currentStatusIndex = statusOptions.findIndex((option) => option?.value === currentStatus);
    const initialIndex = currentStatusIndex >= 0 ? currentStatusIndex : 0;

    // Prompt for status selection
    const selectedStatus = await select({
      message: "Select a status:",
      options: statusOptions,
      initialValue: statusOptions[initialIndex]?.value,
    });

    // Check if user cancelled
    if (isCancel(selectedStatus)) {
      cancel("Operation cancelled");
      throw new ValidationError("Operation cancelled by user");
    }

    return selectedStatus as string;
  }
}

/**
 * Factory functions for creating command instances
 */
export const createTasksStatusGetCommand = (): TasksStatusGetCommand => new TasksStatusGetCommand();

export const createTasksStatusSetCommand = (): TasksStatusSetCommand => new TasksStatusSetCommand();
