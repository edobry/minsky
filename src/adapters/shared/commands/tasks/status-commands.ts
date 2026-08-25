/**
 * Task Status Commands
 *
 * Commands for getting and setting task status.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { select, isCancel, cancel } from "@clack/prompts";
import { type CommandExecutionContext, type InferParams } from "../../command-registry";
import { getTaskStatusFromParams, setTaskStatusFromParams } from "@minsky/domain/tasks";
import { ValidationError } from "@minsky/domain/errors/index";
import { TASK_STATUS } from "@minsky/domain/tasks/taskConstants";
import { BaseTaskCommand } from "./base-task-command";
import { tasksStatusGetParams, tasksStatusSetParams } from "./task-parameters";
import { isInteractive } from "../../../../utils/interactive";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";

/**
 * Refuse to build a success envelope for a status write that did not persist
 * (mt#4457; PR #3342 R1 BLOCKING).
 *
 * A SECOND line of defence, deliberately duplicating the domain layer's check.
 * Deriving `changed` from the count was not sufficient on its own: the adapter
 * would still have returned a success envelope carrying `changed: false`, and a
 * success payload for a write that did not persist is exactly the class this
 * task exists to remove. Unreachable while the domain layer throws — which is
 * the point. It holds if a future backend reports zero without raising, or if
 * that throw regresses.
 *
 * Extracted as a pure function rather than inlined so it can be tested against
 * its own contract: observing it inline would mean patching the module-level
 * `setTaskStatusFromParams` the command reaches itself, which
 * `testing-standards.mdc §Testable Design` treats as design feedback rather
 * than a test-writing problem.
 */
export function assertStatusWritePersisted(args: {
  taskId: string;
  previousStatus: string;
  newStatus: string;
  recordsAffected: number;
}): void {
  if (args.recordsAffected === 0) {
    throw new Error(
      `Task ${args.taskId} status write did not persist: the update matched 0 records ` +
        `(intended ${args.previousStatus} -> ${args.newStatus}). The status is unchanged.`
    );
  }
  if (args.recordsAffected > 1) {
    // A status write addresses one task by primary key, so this cannot happen
    // against a well-formed store. Surface it rather than reporting success:
    // more rows changed than were addressed is a corruption signal, and it is
    // exactly what a boolean return would have discarded.
    throw new Error(
      `Task ${args.taskId} status write affected ${args.recordsAffected} records, ` +
        `but addresses exactly one task. Refusing to report success — this indicates ` +
        `data corruption or a malformed write predicate.`
    );
  }
}
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
 * Task status get command implementation
 */
export class TasksStatusGetCommand extends BaseTaskCommand<typeof tasksStatusGetParams> {
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

  async execute(params: InferParams<typeof tasksStatusGetParams>, ctx: CommandExecutionContext) {
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
export class TasksStatusSetCommand extends BaseTaskCommand<typeof tasksStatusSetParams> {
  readonly id = "tasks.status.set";
  readonly name = "set";
  readonly description = "Set the status of a task";
  readonly parameters = tasksStatusSetParams;

  constructor(
    private readonly getPersistenceProvider?: () => PersistenceProvider,
    private readonly getTaskService?: () => TaskServiceInterface,
    private readonly getTaskGraphService?: () => TaskGraphService
  ) {
    super();
  }

  async execute(params: InferParams<typeof tasksStatusSetParams>, ctx: CommandExecutionContext) {
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
      {
        persistenceProvider: this.getPersistenceProvider?.(),
        taskService: this.getTaskService?.(),
        // Enables the umbrella children-completeness closeout guard (mt#2606).
        taskGraphService: this.getTaskGraphService?.(),
      }
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

    // mt#4457: `changed` is DERIVED from the write's reported effect, not asserted.
    // It was the literal `true` until 2026-08-25, which meant the payload said the
    // same thing whether or not the update reached the row — the exact shape a
    // caller cannot check.
    //
    // The guard below is a SECOND line of defence, deliberately duplicating the
    // domain layer's check (PR #3342 R1, BLOCKING). Deriving `changed` alone was
    // not enough: this method would still have built a success envelope carrying
    // `changed: false`, which is a success payload for a write that did not
    // persist — the exact class this task exists to remove. It is unreachable
    // while the domain layer throws, and that is the point: it holds if a future
    // backend reports zero without raising, or if that throw regresses.
    assertStatusWritePersisted({
      taskId: validatedTaskId,
      previousStatus: previousStatus ?? "unknown",
      newStatus: status,
      recordsAffected: result.recordsAffected,
    });

    return this.formatResult(
      this.createSuccessResult(validatedTaskId, message, {
        previousStatus,
        newStatus: status,
        changed: result.recordsAffected > 0,
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

    // Define the options array for consistency. Covers the union of all
    // per-kind workflows (docs/task-kinds.md): PLANNING/READY for the
    // implementation planning gate; DONE is the single success terminal for
    // every kind (mt#2311). Invalid picks for the task's kind are refused
    // downstream by validateStatusTransition.
    const statusOptions = [
      { value: TASK_STATUS.TODO, label: "TODO" },
      { value: TASK_STATUS.PLANNING, label: "PLANNING" },
      { value: TASK_STATUS.READY, label: "READY" },
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
  getTaskService?: () => TaskServiceInterface,
  getTaskGraphService?: () => TaskGraphService
): TasksStatusSetCommand =>
  new TasksStatusSetCommand(getPersistenceProvider, getTaskService, getTaskGraphService);
