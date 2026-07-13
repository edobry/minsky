/**
 * Task Status Commands
 *
 * Commands for getting and setting task status.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { select, isCancel, cancel } from "@clack/prompts";
import { type CommandExecutionContext } from "../../command-registry";
import { getTaskStatusFromParams, setTaskStatusFromParams } from "@minsky/domain/tasks";
import { ValidationError } from "@minsky/domain/errors/index";
import { TASK_STATUS } from "@minsky/domain/tasks/taskConstants";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import { tasksStatusGetParams, tasksStatusSetParams } from "./task-parameters";
import { isInteractive } from "../../../../utils/interactive";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { log } from "@minsky/shared/logger";

/**
 * Emit a `task.status_changed` system event (best-effort, informational — mt#2340).
 *
 * Write-scope for the event log is deliberately wider than the activity feed's
 * default read-scope: this trajectory event is hidden from the default
 * (actionable) feed but captured unconditionally so the Phase 2 noticer has
 * history. Wired at the shared-command layer so it fires for both CLI and MCP
 * `tasks status set`, across all task backends. Never throws — event emission
 * must not affect the status-set outcome.
 */
async function emitTaskStatusChangedEvent(
  provider: PersistenceProvider | undefined,
  payload: { taskId: string; previousStatus: string | null; newStatus: string }
): Promise<void> {
  try {
    const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
    if (!sqlProvider?.getDatabaseConnection) return;
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return;
    const { DrizzleEventEmitter } = await import("@minsky/domain/events/emitter");
    await new DrizzleEventEmitter(db).emit({
      eventType: "task.status_changed",
      payload,
      relatedTaskId: payload.taskId,
    });
  } catch (err: unknown) {
    log.warn("task.status_changed: event emission failed (best-effort, swallowed)", {
      taskId: payload.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
export class TasksStatusGetCommand extends BaseTaskCommand<TasksStatusGetParams> {
  readonly id = "tasks.status.get";
  readonly name = "get";
  readonly description = "Get the status of a task";
  readonly parameters = tasksStatusGetParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(params: TasksStatusGetParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.status.get execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task status
    const status = await getTaskStatusFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
      },
      { persistenceProvider: this.getPersistenceProvider?.(), taskService: this.getTaskService?.() }
    );

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
export class TasksStatusSetCommand extends BaseTaskCommand<TasksStatusSetParams> {
  readonly id = "tasks.status.set";
  readonly name = "set";
  readonly description = "Set the status of a task";
  readonly parameters = tasksStatusSetParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface
  ) {
    super();
  }

  async execute(params: TasksStatusSetParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.status.set execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Verify the task exists before prompting for status and get current status
    this.debug("Getting previous status");
    const previousStatus = await getTaskStatusFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
      },
      { persistenceProvider: this.getPersistenceProvider?.(), taskService: this.getTaskService?.() }
    );
    this.debug("Previous status retrieved successfully");

    let status = params.status;

    // If status is not provided, prompt for it interactively
    if (!status) {
      status = (await this.promptForStatus(previousStatus ?? "")) ?? "";
    }

    // If no change, return a clear no-op message and skip update
    if (status === previousStatus) {
      const message = `Task ${validatedTaskId} status is already ${status} (no change)`;
      return this.formatResult(
        this.createSuccessResult(validatedTaskId, message, {
          previousStatus,
          newStatus: status,
          changed: false,
        }),
        params.json
      );
    }

    // Set the task status
    this.debug("Setting task status");
    const result = await setTaskStatusFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
        status,
      },
      { persistenceProvider: this.getPersistenceProvider?.(), taskService: this.getTaskService?.() }
    );

    // Best-effort informational event (mt#2340) — captured for the Phase 2
    // noticer; hidden from the activity feed's default actionable view.
    await emitTaskStatusChangedEvent(this.getPersistenceProvider?.(), {
      taskId: validatedTaskId,
      previousStatus: previousStatus ?? null,
      newStatus: status,
    });

    const message = `Task ${validatedTaskId} status changed from ${previousStatus} to ${status}`;
    this.debug("Task status set successfully");

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        previousStatus,
        newStatus: status,
        changed: true,
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
    if (!isInteractive()) {
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
export const createTasksStatusGetCommand = (
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface
): TasksStatusGetCommand => new TasksStatusGetCommand(getPersistenceProvider, getTaskService);

export const createTasksStatusSetCommand = (
  getPersistenceProvider?: () => PersistenceProvider,
  getTaskService?: () => TaskServiceInterface
): TasksStatusSetCommand => new TasksStatusSetCommand(getPersistenceProvider, getTaskService);
