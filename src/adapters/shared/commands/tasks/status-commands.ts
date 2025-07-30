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
import { getCurrentSessionContext } from "../../../../domain/workspace";
import { createGitService, type GitServiceInterface } from "../../../../domain/git";
import { log } from "../../../../utils/logger";

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
    const normalizedTaskId = this.validateAndNormalizeTaskId(taskId);

    // Get task status
    const status = await getTaskStatusFromParams({
      ...this.createTaskParams(params),
      taskId: normalizedTaskId,
    });

    this.debug("Task status retrieved successfully");

    return this.formatResult(
      this.createSuccessResult(normalizedTaskId, `Task ${normalizedTaskId} status: ${status}`, {
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

    // Check if we're in a description session workspace
    const sessionContext = await getCurrentSessionContext(process.cwd());
    const isInSessionWorkspace = !!sessionContext?.sessionId;

    let hasStashedChanges = false;
    let gitService: GitServiceInterface | null = null;

    // If we're in a session workspace, set up git operations
    if (isInSessionWorkspace) {
      gitService = createGitService();

      // Check for uncommitted changes and stash them
      try {
        const hasUncommittedChanges = await gitService.hasUncommittedChanges(process.cwd());
        if (hasUncommittedChanges) {
          if (!params.json) {
            log.cli("📦 Stashing uncommitted changes...");
          }
          log.debug("Stashing uncommitted changes for task status update", {
            workdir: process.cwd(),
          });

          const stashResult = await gitService.stashChanges(process.cwd());
          hasStashedChanges = stashResult.stashed;

          if (hasStashedChanges && !params.json) {
            log.cli("✅ Changes stashed successfully");
          }
          log.debug("Changes stashed", { stashed: hasStashedChanges });
        }
      } catch (statusError) {
        log.debug("Could not check/stash git status before task status update", {
          error: statusError,
        });
      }
    }

    try {
      // Validate and normalize task ID
      const taskId = this.validateRequired(params.taskId, "taskId");
      const normalizedTaskId = this.validateAndNormalizeTaskId(taskId);

      // Verify the task exists before prompting for status and get current status
      this.debug("Getting previous status");
      const previousStatus = await getTaskStatusFromParams({
        ...this.createTaskParams(params),
        taskId: normalizedTaskId,
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
        taskId: normalizedTaskId,
        status,
      });

      // If we're in a session workspace, commit and push the changes
      if (isInSessionWorkspace && gitService) {
        try {
          // Check if there are changes to commit
          const hasChangesToCommit = await gitService.hasUncommittedChanges(process.cwd());
          if (hasChangesToCommit) {
            if (!params.json) {
              log.cli("💾 Committing task status change...");
            }

            // Stage all changes
            await gitService.execInRepository(process.cwd(), "git add -A");

            // Commit with conventional commit message
            const commitMessage = `chore(#${normalizedTaskId}): update task status ${previousStatus} → ${status}`;
            await gitService.execInRepository(process.cwd(), `git commit -m "${commitMessage}"`);

            if (!params.json) {
              log.cli("📤 Pushing changes...");
            }

            // Push changes
            await gitService.execInRepository(process.cwd(), "git push");

            if (!params.json) {
              log.cli("✅ Changes committed and pushed successfully");
            }
            log.debug("Task status change committed and pushed", {
              taskId: normalizedTaskId,
              status,
            });
          }
        } catch (commitError) {
          log.warn("Failed to commit task status change", {
            taskId: normalizedTaskId,
            error: commitError,
          });
          if (!params.json) {
            log.cli(`⚠️ Warning: Failed to commit changes: ${commitError}`);
          }
        }
      }

      const message = `Task ${normalizedTaskId} status changed from ${previousStatus} to ${status}`;
      this.debug("Task status set successfully");

      return this.formatResult(
        this.createSuccessResult(normalizedTaskId, message, {
          previousStatus,
          newStatus: status,
          result,
          sessionWorkspace: isInSessionWorkspace,
        }),
        params.json
      );
    } finally {
      // Restore stashed changes if we stashed them
      if (hasStashedChanges && gitService) {
        try {
          if (!params.json) {
            log.cli("📂 Restoring stashed changes...");
          }
          log.debug("Restoring stashed changes after task status update");

          await gitService.popStash(process.cwd());

          if (!params.json) {
            log.cli("✅ Stashed changes restored successfully");
          }
          log.debug("Stashed changes restored");
        } catch (popError) {
          log.warn("Failed to restore stashed changes", {
            error: popError,
          });
          if (!params.json) {
            log.cli(`⚠️ Warning: Failed to restore stashed changes: ${popError}`);
          }
        }
      }
    }
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
