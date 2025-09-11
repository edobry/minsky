/**
 * Task CRUD Commands - DatabaseCommand Migration
 *
 * These commands migrate from the old pattern (using PersistenceService.getProvider() via domain layer)
 * to the new DatabaseCommand pattern with automatic provider injection.
 *
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used domain functions that internally call PersistenceService.getProvider()
 * - NEW: Extends DatabaseCommand, passes injected provider to domain functions via createConfiguredTaskService
 * - BENEFIT: No singleton access, proper dependency injection, lazy initialization
 */

import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import {
  listTasksFromParams,
  getTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndSpec,
  deleteTaskFromParams,
} from "../../../../domain/tasks";
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import {
  tasksListParams,
  tasksGetParams,
  tasksCreateParams,
  tasksDeleteParams,
} from "./task-parameters";
import { z } from "zod";

/**
 * Task list command - migrated to DatabaseCommand
 */
export class TasksListCommand extends DatabaseCommand {
  readonly id = "tasks.list";
  readonly category = CommandCategory.TASKS;
  readonly name = "list";
  readonly description = "List tasks with optional filtering";
  readonly parameters = tasksListParams;

  async execute(
    params: {
      all?: boolean;
      status?: string;
      filter?: string;
      limit?: number;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    // List tasks with filters - pass provider for dependency injection
    let tasks = await listTasksFromParams(
      {
        all: params.all,
        status: params.status,
        filter: params.filter,
        limit: params.limit,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true, // Always get raw data for processing
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

    // Apply shared filters for backend/time at adapter level
    try {
      const { parseTime, filterByTimeRange } = require("../../../../utils/result-handling/filters");
      const sinceTs = parseTime((params as any).since);
      const untilTs = parseTime((params as any).until);
      tasks = filterByTimeRange(tasks, sinceTs, untilTs);
    } catch {
      // If utilities unavailable, skip
    }

    const wantJson = params.json || context.format === "json";
    if (wantJson) {
      // For JSON output, return tasks array only
      return tasks;
    }

    return {
      success: true,
      count: tasks.length,
      tasks,
      message: `Found ${tasks.length} tasks`,
    };
  }
}

/**
 * Task get command - migrated to DatabaseCommand
 */
export class TasksGetCommand extends DatabaseCommand {
  readonly id = "tasks.get";
  readonly category = CommandCategory.TASKS;
  readonly name = "get";
  readonly description = "Get details of a specific task";
  readonly parameters = tasksGetParams;

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

    // Get task details - pass provider for dependency injection
    const task = await getTaskFromParams(
      {
        taskId: params.taskId,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
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
      return task;
    }

    return {
      success: true,
      taskId: params.taskId,
      task,
      message: `Task ${params.taskId} retrieved`,
    };
  }
}

/**
 * Task create command - migrated to DatabaseCommand
 */
export class TasksCreateCommand extends DatabaseCommand {
  readonly id = "tasks.create";
  readonly category = CommandCategory.TASKS;
  readonly name = "create";
  readonly description = "Create a new task";
  readonly parameters = tasksCreateParams;

  async execute(
    params: {
      title: string;
      spec?: string;
      specPath?: string;
      force?: boolean;
      githubRepo?: string;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    // Create task - pass provider for dependency injection
    const task = await createTaskFromTitleAndSpec(
      {
        title: params.title,
        spec: params.spec || "",
        specPath: params.specPath,
        force: params.force,
        githubRepo: params.githubRepo,
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
      return task;
    }

    return {
      success: true,
      taskId: task.id,
      task,
      message: `Task ${task.id} created successfully`,
    };
  }
}

/**
 * Task delete command - migrated to DatabaseCommand
 */
export class TasksDeleteCommand extends DatabaseCommand {
  readonly id = "tasks.delete";
  readonly category = CommandCategory.TASKS;
  readonly name = "delete";
  readonly description = "Delete a task";
  readonly parameters = tasksDeleteParams;

  async execute(
    params: {
      taskId: string;
      force?: boolean;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
    },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    // Delete task - pass provider for dependency injection
    const result = await deleteTaskFromParams(
      {
        taskId: params.taskId,
        force: params.force,
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
      return { success: result, taskId: params.taskId };
    }

    return {
      success: result,
      taskId: params.taskId,
      message: result
        ? `Task ${params.taskId} deleted successfully`
        : `Failed to delete task ${params.taskId}`,
    };
  }
}

/**
 * MIGRATION SUMMARY FOR CRUD COMMANDS:
 *
 * 1. Changed from BaseTaskCommand to DatabaseCommand
 * 2. Added required category property (CommandCategory.TASKS)
 * 3. Updated execute method to receive DatabaseCommandContext with provider
 * 4. Replaced internal PersistenceService.getProvider() calls with injected provider
 * 5. Updated domain function calls to pass provider via dependency injection
 * 6. Simplified return structures (removed BaseTaskCommand helper methods)
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling with DatabaseCommand
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 * - Lazy initialization - no upfront database connections
 */
