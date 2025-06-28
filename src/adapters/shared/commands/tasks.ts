/**
 * Shared Tasks Commands
 *
 * This module contains shared task command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { select, isCancel, cancel } from "@clack/prompts";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import {
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  getTaskSpecContentFromParams,
  normalizeTaskId,
  listTasksFromParams,
  getTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  deleteTaskFromParams,
} from "../../../domain/tasks";
import { BackendMigrationUtils } from "../../../domain/tasks/migrationUtils";
import { TaskService } from "../../../domain/tasks/taskService";
import { log } from "../../../utils/logger";
import { ValidationError } from "../../../errors/index";
// Import task status constants from centralized location
import { TASK_STATUS } from "../../../domain/tasks/taskConstants.js";
// Schemas removed as they are unused in this file

/**
 * Parameters for tasks status get command
 */
const tasksStatusGetParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Parameters for tasks status set command
 */
const tasksStatusSetParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  status: {
    schema: z.enum([
      TASK_STATUS.TODO,
      TASK_STATUS.IN_PROGRESS,
      TASK_STATUS.IN_REVIEW,
      TASK_STATUS.DONE,
      TASK_STATUS.BLOCKED,
    ]),
    description: "Task status",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Parameters for tasks spec command
 */
const tasksSpecParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  section: {
    schema: z.string(),
    description: "Specific section of the specification to retrieve",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Task status get command definition
 */
const tasksStatusGetRegistration = {
  id: "tasks.status.get",
  category: CommandCategory.TASKS,
  name: "status get",
  description: "Get the status of a task",
  parameters: tasksStatusGetParams,
  execute: async (params, ctx: CommandExecutionContext) => {
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    const status = await getTaskStatusFromParams({
      ...params,
      taskId: normalizedTaskId,
    });
    return {
      success: true,
      taskId: normalizedTaskId,
      status: status,
    };
  },
};

/**
 * Task status set command definition
 */
const tasksStatusSetRegistration = {
  id: "tasks.status.set",
  category: CommandCategory.TASKS,
  name: "status set",
  description: "Set the status of a task",
  parameters: tasksStatusSetParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    log.systemDebug("Starting tasks.status.set execution");
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");

    // Normalize and validate task ID first
    log.systemDebug("About to normalize task ID");
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }

    // Verify the task exists before prompting for status and get current status
    // This will throw ResourceNotFoundError if task doesn't exist
    log.systemDebug("About to get previous status");
    const previousStatus = await getTaskStatusFromParams({
      taskId: normalizedTaskId,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      backend: params.backend,
    });
    log.systemDebug("Previous status retrieved successfully");

    let status = params.status;

    // If status is not provided, prompt for it interactively
    if (!status) {
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
      ];

      // Find the index of the current status to pre-select it
      const currentStatusIndex = statusOptions.findIndex(
        (option) => option.value === previousStatus
      );
      const initialIndex = currentStatusIndex >= 0 ? currentStatusIndex : 0; // Default to TODO if current status not found

      // Prompt for status selection
      const selectedStatus = await select({
        message: "Select a status:",
        options: statusOptions,
        initialValue: currentStatusIndex >= 0 ? previousStatus : TASK_STATUS.TODO, // Pre-select the current status
      });

      // Handle cancellation
      if (isCancel(selectedStatus)) {
        cancel("Operation cancelled.");
        return "Operation cancelled by user";
      }

      // Re-assign status from the interactive prompt
      status = selectedStatus as string;
    }

    if (!status) throw new ValidationError("Missing required parameter: status");

    await setTaskStatusFromParams({
      taskId: normalizedTaskId,
      status: status,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      backend: params.backend,
    });

    return {
      success: true,
      taskId: normalizedTaskId,
      status: status,
      previousStatus: previousStatus,
    };
  },
};

/**
 * Task spec command definition
 */
const tasksSpecRegistration = {
  id: "tasks.spec",
  category: CommandCategory.TASKS,
  name: "spec",
  description: "Get task specification content",
  parameters: tasksSpecParams,
  execute: async (params, ctx: CommandExecutionContext) => {
    try {
      const normalizedTaskId = normalizeTaskId(params.taskId);
      if (!normalizedTaskId) {
        throw new ValidationError(
          `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
        );
      }
      const result = await getTaskSpecContentFromParams({
        ...params,
        taskId: normalizedTaskId,
      });
      return result;
    } catch (error) {
      log.error("Error getting task specification", { error });
      throw error;
    }
  },
};

/**
 * Parameters for tasks list command
 */
const tasksListParams: CommandParameterMap = {
  filter: {
    schema: z.string(),
    description: "Filter tasks by status or other criteria",
    required: false,
  },
  status: {
    schema: z.enum([
      TASK_STATUS.TODO,
      TASK_STATUS.IN_PROGRESS,
      TASK_STATUS.IN_REVIEW,
      TASK_STATUS.DONE,
      TASK_STATUS.BLOCKED,
    ]),
    description: "Filter tasks by status",
    required: false,
  },
  limit: {
    schema: z.number(),
    description: "Limit the number of tasks returned",
    required: false,
  },
  all: {
    schema: z.boolean().default(false),
    description: "Include completed tasks",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Parameters for tasks get command
 */
const tasksGetParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "ID of the task to retrieve",
    required: true,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Parameters for tasks create command
 */
const tasksCreateParams: CommandParameterMap = {
  title: {
    schema: z.string().min(1),
    description: "Title for the task",
    required: true,
  },
  description: {
    schema: z.string(),
    description: "Description text for the task",
    required: false,
  },
  descriptionPath: {
    schema: z.string(),
    description: "Path to file containing task description",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force creation even if task already exists",
    required: false,
    defaultValue: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Tasks commands registration parameters and definitions
 */
const tasksListRegistration = {
  id: "tasks.list",
  category: CommandCategory.TASKS,
  name: "list",
  description: "List tasks with optional filtering",
  parameters: tasksListParams,
  execute: async (params, ctx) => {
    const { all = false, status, filter, ...rest } = params;

    // Use status parameter if provided, otherwise fall back to filter
    const filterParam = status || filter;

    return await listTasksFromParams({
      all,
      filter: filterParam,
      ...rest,
    });
  },
};

/**
 * Register tasks.get command
 */
const tasksGetRegistration = {
  id: "tasks.get",
  category: CommandCategory.TASKS,
  name: "get",
  description: "Get a task by ID",
  parameters: tasksGetParams,
  execute: async (params, ctx) => {
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");
    return await getTaskFromParams({
      taskId: params.taskId,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });
  },
};

/**
 * Register tasks.create command
 */
const tasksCreateRegistration = {
  id: "tasks.create",
  category: CommandCategory.TASKS,
  name: "create",
  description: "Create a new task with --title and --description",
  parameters: tasksCreateParams,
  execute: async (params, ctx) => {
    // Title is required by schema, but validate it's provided
    if (!params.title) {
      throw new ValidationError("Title is required");
    }

    // Validate that either description or descriptionPath is provided
    if (!params.description && !params.descriptionPath) {
      throw new ValidationError("Either --description or --description-path must be provided");
    }

    // Both description and descriptionPath provided is an error
    if (params.description && params.descriptionPath) {
      throw new ValidationError("Cannot provide both --description and --description-path - use one or the other");
    }

    return await createTaskFromTitleAndDescription({
      title: params.title,
      description: params.description,
      descriptionPath: params.descriptionPath,
      force: params.force ?? false,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });
  },
};

/**
 * Parameters for tasks delete command
 */
const tasksDeleteParams: CommandParameterMap = {
  taskId: {
    schema: z.string().min(1),
    description: "ID of the task to delete",
    required: true,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force deletion without confirmation",
    required: false,
    defaultValue: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Register tasks.delete command
 */
const tasksDeleteRegistration = {
  id: "tasks.delete",
  category: CommandCategory.TASKS,
  name: "delete",
  description: "Delete a task",
  parameters: tasksDeleteParams,
  execute: async (params, ctx) => {
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");

    // Handle confirmation if force is not set and we're in interactive mode
    if (!params.force && !params.json) {
      // Get task details for confirmation
      const task = await getTaskFromParams({
        taskId: params.taskId,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
      });

      // Import confirm from @clack/prompts for confirmation
      const { confirm, isCancel } = await import("@clack/prompts");
      
      const shouldDelete = await confirm({
        message: `Are you sure you want to delete task ${task.id}: "${task.title}"?`,
      });

      if (isCancel(shouldDelete) || !shouldDelete) {
        return {
          success: false,
          message: "Task deletion cancelled",
          taskId: params.taskId,
        };
      }
    }

    const result = await deleteTaskFromParams({
      taskId: params.taskId,
      force: params.force ?? false,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });

    return {
      success: result.success,
      taskId: result.taskId,
      task: result.task,
      message: result.success 
        ? `Task ${result.taskId} deleted successfully`
        : `Failed to delete task ${result.taskId}`,
    };
  },
};

/**
 * Parameters for tasks migrate command
 */
const tasksMigrateParams: CommandParameterMap = {
  sourceBackend: {
    schema: z.string(),
    description: "Source backend (markdown, json-file, github-issues)",
    required: true,
  },
  targetBackend: {
    schema: z.string(),
    description: "Target backend (markdown, json-file, github-issues)",
    required: true,
  },
  idConflictStrategy: {
    schema: z.enum(["skip", "rename", "overwrite"]).default("skip"),
    description: "Strategy for handling ID conflicts",
    required: false,
  },
  statusMapping: {
    schema: z.string(),
    description: "Custom status mapping (JSON format)",
    required: false,
  },
  createBackup: {
    schema: z.boolean().default(true),
    description: "Create backup before migration",
    required: false,
  },
  dryRun: {
    schema: z.boolean().default(false),
    description: "Perform dry run without making changes",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Skip confirmation prompts",
    required: false,
  },
};

/**
 * Register tasks.migrate command
 */
const tasksMigrateRegistration = {
  id: "tasks.migrate",
  category: CommandCategory.TASKS,
  name: "migrate",
  description: "Migrate tasks between different backends",
  parameters: tasksMigrateParams,
  execute: async (params, _ctx: CommandExecutionContext) => {
    const {
      sourceBackend,
      targetBackend,
      idConflictStrategy = "skip",
      statusMapping,
      createBackup = true,
      dryRun = false,
      repo,
      workspace,
      session,
      json = false,
    } = params;

    // Parse status mapping if provided
    let parsedStatusMapping: Record<string, string> | undefined;
    if (statusMapping) {
      try {
        parsedStatusMapping = JSON.parse(statusMapping);
      } catch (error) {
        throw new ValidationError(`Invalid status mapping JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Create task services for source and target backends
    const sourceTaskService = new TaskService({
      workspacePath: workspace || repo || process.cwd(),
      backend: sourceBackend,
    });

    const targetTaskService = new TaskService({
      workspacePath: workspace || repo || process.cwd(),
      backend: targetBackend,
    });

    // Use session parameter if provided for session-specific migrations
    if (session) {
      log.debug(`Migration requested for session: ${session}`);
    }

    // Get the actual backend instances
    const sourceBackendInstance = (sourceTaskService as any).currentBackend;
    const targetBackendInstance = (targetTaskService as any).currentBackend;

    // Create migration utility
    const migrationUtils = new BackendMigrationUtils();

    try {
      // Perform actual migration
      const result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackendInstance,
        targetBackendInstance,
        {
          preserveIds: true,
          dryRun,
          statusMapping: parsedStatusMapping,
          rollbackOnFailure: true,
          idConflictStrategy,
          createBackup,
        }
      );

      // Transform result to match CLI interface
      const cliResult = {
        success: result.success,
        summary: {
          migrated: result.migratedCount,
          skipped: result.skippedCount,
          total: result.migratedCount + result.skippedCount,
          errors: result.errors.length,
        },
        conflicts: [] as Array<{ taskId: string; resolution: string }>, // TODO: Add conflict details from result
        backupPath: result.backupPath,
      };

      if (json) {
        return cliResult;
      }

      // Format human-readable output
      log.cli(`\n✅ Migration ${dryRun ? "simulation" : "completed"} successfully!`);
      log.cli("📊 Summary:");
      log.cli(`   • Tasks migrated: ${cliResult.summary.migrated}`);
      log.cli(`   • Tasks skipped: ${cliResult.summary.skipped}`);
      log.cli(`   • Total processed: ${cliResult.summary.total}`);

      if (cliResult.summary.errors > 0) {
        log.cliWarn(`   • Errors: ${cliResult.summary.errors}`);
      }

      if (cliResult.conflicts && cliResult.conflicts.length > 0) {
        log.cliWarn("\n⚠️  ID Conflicts detected:");
        cliResult.conflicts.forEach((conflict) => {
          log.cliWarn(`   • Task ${conflict.taskId}: ${conflict.resolution}`);
        });
      }

      if (cliResult.backupPath) {
        log.cli(`\n💾 Backup created: ${cliResult.backupPath}`);
      }

      return cliResult;
    } catch (error) {
      throw new ValidationError(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export function registerTasksCommands() {
  // Register tasks.list command
  sharedCommandRegistry.registerCommand(tasksListRegistration);

  // Register tasks.get command
  sharedCommandRegistry.registerCommand(tasksGetRegistration);

  // Register tasks.create command
  sharedCommandRegistry.registerCommand(tasksCreateRegistration);

  // Register tasks.delete command
  sharedCommandRegistry.registerCommand(tasksDeleteRegistration);

  // Register tasks.status.get command
  sharedCommandRegistry.registerCommand(tasksStatusGetRegistration);

  // Register tasks.status.set command
  sharedCommandRegistry.registerCommand(tasksStatusSetRegistration);

  // Register tasks.spec command
  sharedCommandRegistry.registerCommand(tasksSpecRegistration);

  // Register tasks.migrate command
  sharedCommandRegistry.registerCommand(tasksMigrateRegistration);
}
