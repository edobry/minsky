/**
 * Task Status Commands - DatabaseCommand Migration
 *
 * These commands migrate from the old pattern (using PersistenceService.getProvider() via domain layer)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used domain functions that internally call PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to domain functions via createConfiguredTaskService
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import { select, isCancel, cancel } from "@clack/prompts";
import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { getTaskStatusFromParams, setTaskStatusFromParams } from "../../../../domain/tasks";
import { ValidationError } from "../../../../errors/index";
import { TASK_STATUS } from "../../../../domain/tasks/taskConstants";
import { tasksStatusGetParams, tasksStatusSetParams } from "./task-parameters";

/**
 * Task status get command - migrated to DatabaseCommand
 */
export class TasksStatusGetCommand extends DatabaseCommand {
  readonly id = "tasks.status.get";
  readonly category = CommandCategory.TASKS;
  readonly name = "status get";
  readonly description = "Get the status of a task";
  readonly parameters = tasksStatusGetParams;

  async execute(
    params: {
      taskId: string;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    if (!params.taskId) {
      throw new ValidationError("taskId is required");
    }

    // Get task status - pass provider for dependency injection
    const status = await getTaskStatusFromParams(
      {
        taskId: params.taskId,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
      },
      {
        createConfiguredTaskService: async (options) => {
          const { createConfiguredTaskService } = await import(
            "../../../../domain/tasks/taskService"
          );
          return await createConfiguredTaskService({
            ...options,
            persistenceProvider: provider,
          });
        },
      }
    );

    const wantJson = params.json || context.format === "json";
    if (wantJson) {
      return { taskId: params.taskId, status };
    }

    return {
      success: true,
      taskId: params.taskId,
      status,
      message: `Task ${params.taskId} status: ${status}`,
    };
  }
}

/**
 * Task status set command - migrated to DatabaseCommand
 */
export class TasksStatusSetCommand extends DatabaseCommand {
  readonly id = "tasks.status.set";
  readonly category = CommandCategory.TASKS;
  readonly name = "status set";
  readonly description =
    "Set the status of a task (with interactive prompt if status not provided)";
  readonly parameters = tasksStatusSetParams;

  async execute(
    params: {
      taskId: string;
      status?: string;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    if (!params.taskId) {
      throw new ValidationError("taskId is required");
    }

    let targetStatus = params.status;

    // Interactive status selection if not provided
    if (!targetStatus) {
      const statusOptions = Object.values(TASK_STATUS).map((status) => ({
        value: status,
        label: status,
      }));

      const selectedStatus = await select({
        message: `Select new status for task ${params.taskId}:`,
        options: statusOptions,
      });

      if (isCancel(selectedStatus)) {
        cancel("Operation cancelled");
        return {
          success: false,
          message: "Status update cancelled by user",
        };
      }

      targetStatus = selectedStatus as string;
    }

    // Validate status
    const validStatuses = Object.values(TASK_STATUS);
    if (!validStatuses.includes(targetStatus as any)) {
      throw new ValidationError(
        `Invalid status "${targetStatus}". Valid options: ${validStatuses.join(", ")}`
      );
    }

    // Set task status - pass provider for dependency injection
    await setTaskStatusFromParams(
      {
        taskId: params.taskId,
        status: targetStatus,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
      },
      {
        createConfiguredTaskService: async (options) => {
          const { createConfiguredTaskService } = await import(
            "../../../../domain/tasks/taskService"
          );
          return await createConfiguredTaskService({
            ...options,
            persistenceProvider: provider,
          });
        },
      }
    );

    const wantJson = params.json || context.format === "json";
    if (wantJson) {
      return { taskId: params.taskId, status: targetStatus, updated: true };
    }

    return {
      success: true,
      taskId: params.taskId,
      status: targetStatus,
      message: `Task ${params.taskId} status updated to: ${targetStatus}`,
    };
  }
}

/**
 * MIGRATION SUMMARY FOR STATUS COMMANDS:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Replaced internal PersistenceService.getProvider() calls with injected provider
 * 5. Updated domain function calls to pass provider via dependency injection
 * 6. Preserved interactive status selection functionality
 * 7. Simplified return structures (removed BaseTaskCommand helper methods)
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 * - Interactive prompts preserved
 */
