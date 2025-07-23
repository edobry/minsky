/**
 * Shared Tasks Commands
 *
 * This module contains shared task command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { select, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage } from "../../../errors/index";
import {
  CommandCategory,
  CommandExecutionContext,
  CommandParameterMap,
  sharedCommandRegistry,
} from "../command-registry";
import { ValidationError } from "../../../errors/index";
import {
  createTaskFromTitleAndDescription,
  deleteTaskFromParams,
  getTaskFromParams,
  getTaskSpecContentFromParams,
  getTaskStatusFromParams,
  listTasksFromParams,
  normalizeTaskId,
  setTaskStatusFromParams,
  TASK_STATUS,
} from "../../../domain/tasks";
import { TaskService } from "../../../domain/tasks/taskService";
import { log } from "../../../utils/logger";
// Schemas removed as they are unused in this file

// Parameter types for tasks commands
interface TasksStatusSetParams {
  taskId: string;
  status?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
}

interface TasksSpecParams {
  taskId: string;
  section?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
}

interface TasksGetParams {
  taskId: string;
  backend?: string;
  repo?: string;
  workspace?: string;
  session?: string;
}

interface TasksCreateParams {
  title: string;
  description?: string;
  descriptionPath?: string;
  force?: boolean;
  backend?: string;
  repo?: string;
  workspace?: string;
  session?: string;
}

interface TasksDeleteParams {
  taskId: string;
  force?: boolean;
  json?: boolean;
  backend?: string;
  repo?: string;
  workspace?: string;
  session?: string;
}

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
      TASK_STATUS.CLOSED,
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
  execute: async (params, _ctx: CommandExecutionContext) => {
    const normalizedTaskId = normalizeTaskId((params as any).taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${(params as any).taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
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
  execute: async (params: TasksStatusSetParams, _ctx: CommandExecutionContext) => {
    log.debug("Starting tasks.status.set execution");
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");

    // Normalize and validate task ID first
    log.debug("About to normalize task ID");
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }

    // Verify the task exists before prompting for status and get current status
    // This will throw ResourceNotFoundError if task doesn't exist
    log.debug("About to get previous status");
    const previousStatus = await getTaskStatusFromParams({
      taskId: normalizedTaskId,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      backend: params.backend,
    });
    log.debug("Previous status retrieved successfully");

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
        { value: TASK_STATUS.CLOSED, label: "CLOSED" },
      ];

      // Find the index of the current status to pre-select it
      const currentStatusIndex = statusOptions.findIndex(
        (option) => option?.value === previousStatus
      );
      const _initialIndex = currentStatusIndex >= 0 ? currentStatusIndex : 0; // Default to TODO if current status not found

      // Prompt for status selection
      const selectedStatus = await select({
        message: "Select a status:",
        options: statusOptions,
        initialValue: currentStatusIndex >= 0 ? previousStatus : TASK_STATUS?.TODO, // Pre-select the current status
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
  execute: async (params: TasksSpecParams, ctx: CommandExecutionContext) => {
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
      TASK_STATUS.CLOSED,
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
  execute: async (params, _ctx) => {
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
  execute: async (params: TasksGetParams, ctx) => {
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
  execute: async (params: TasksCreateParams, ctx) => {
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
      throw new ValidationError(
        "Cannot provide both --description and --description-path - use one or the other"
      );
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
  execute: async (params: TasksDeleteParams, ctx) => {
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");

    // Handle confirmation if force is not set and we're in interactive mode
    if (!(params as TasksDeleteParams).force && !(params as TasksDeleteParams).json) {
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
        message: `Are you sure you want to delete task ${(task as { id: string; title: string }).id}: "${(task as { id: string; title: string }).title}"?`,
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

    const message = result.success
      ? `Task ${result.taskId} deleted successfully`
      : `Failed to delete task ${result.taskId}`;

    // Return different formats based on --json flag
    if ((params as TasksDeleteParams).json) {
      // Structured output for programmatic use
      return {
        success: (result as { success: boolean; taskId: string; task?: any }).success,
        taskId: (result as { taskId: string }).taskId,
        task: (result as { task?: any }).task,
        message: message,
      };
    } else {
      // Simple message for user-friendly output
      return message;
    }
  },
};

/**
 * Parameters for tasks migrate command
 */
const tasksMigrateParams: CommandParameterMap = {
  to: {
    schema: z.enum([
      "markdown", 
      "json-file", 
      "github-issues",
      "github-sqlite-hybrid",
      "markdown-sqlite-hybrid"
    ]),
    description: "Target backend type (includes hybrid backends)",
    required: true,
  },
  from: {
    schema: z.enum([
      "markdown", 
      "json-file", 
      "github-issues",
      "github-sqlite-hybrid", 
      "markdown-sqlite-hybrid"
    ]),
    description: "Source backend type (auto-detect if not provided)",
    required: false,
  },
  backup: {
    schema: z.boolean(),
    description: "Create backup before migration",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Show what would be migrated without doing it",
    required: false,
  },
  workspacePath: {
    schema: z.string(),
    description: "Workspace path for task operations",
    required: false,
  },
  statusMapping: {
    schema: z.record(z.string()),
    description: "Custom status mapping (source:target)",
    required: false,
  },
  metadataOnly: {
    schema: z.boolean(),
    description: "Migrate only metadata (for hybrid backends)",
    required: false,
  },
  specsOnly: {
    schema: z.boolean(),
    description: "Migrate only task specifications (for hybrid backends)",
    required: false,
  },
  sqliteDbPath: {
    schema: z.string(),
    description: "Custom SQLite database path for hybrid backends",
    required: false,
  },
};

/**
 * Helper function to create backends for migration, including hybrid backends
 */
async function createBackendForMigration(
  backendType: string, 
  workspacePath: string, 
  sqliteDbPath?: string
): Promise<any> {
  const { TaskService } = await import("../../../domain/tasks/taskService");
  
  switch (backendType) {
    case "github-sqlite-hybrid":
      // Import hybrid backend
      const { createGitHubSqliteHybridBackend } = await import("../../../domain/tasks/githubSqliteHybridBackend");
      
      // Create octokit instance (this would need proper configuration)
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
      });
      
      // Parse repo info from environment or config
      const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
      if (!owner || !repo) {
        throw new Error("GitHub repository not configured. Set GITHUB_REPOSITORY environment variable.");
      }
      
      const hybridBackend = createGitHubSqliteHybridBackend({
        octokit,
        owner,
        repo,
        workspacePath,
        metadataDatabasePath: sqliteDbPath,
      });
      
      await hybridBackend.initialize();
      
      // Return a wrapper that implements TaskService interface
      return {
        getAllTasks: () => hybridBackend.listTasks(),
        getTask: (id: string) => hybridBackend.getTask(id),
        createTask: (title: string, description?: string) => 
          hybridBackend.createTask({ id: "", title, description }),
        updateTaskStatus: (id: string, status: string) => 
          hybridBackend.setTaskStatus(id, status),
        getBackend: () => hybridBackend,
      };
      
    case "markdown-sqlite-hybrid":
      const { createMarkdownSqliteHybridBackend } = await import("../../../domain/tasks/markdownSqliteHybridBackend");
      
      const mdHybridBackend = createMarkdownSqliteHybridBackend({
        workspacePath,
        metadataDatabasePath: sqliteDbPath,
      });
      
      await mdHybridBackend.initialize();
      
      return {
        getAllTasks: () => mdHybridBackend.listTasks(),
        getTask: (id: string) => mdHybridBackend.getTask(id),
        createTask: (title: string, description?: string) => 
          mdHybridBackend.createTask({ id: "", title, description }),
        updateTaskStatus: (id: string, status: string) => 
          mdHybridBackend.setTaskStatus(id, status),
        getBackend: () => mdHybridBackend,
      };
      
    case "markdown":
    case "json-file":
      // Use enhanced backend creation for traditional backends
      return await TaskService.createWithEnhancedBackend({
        backend: backendType as "markdown" | "json-file",
        backendConfig: { workspacePath },
      });
      
    default:
      // Use standard TaskService for other backends
      return new TaskService({
        workspacePath,
        backend: backendType,
      });
  }
}

/**
 * Task migrate command definition
 */
const tasksMigrateRegistration = {
  id: "tasks.migrate",
  category: CommandCategory.TASKS,
  name: "migrate",
  description: "Migrate tasks between backends (markdown, json-file, github-issues)",
  parameters: tasksMigrateParams,
  execute: async (params: any, context: CommandExecutionContext) => {
    const { to, from, backup, dryRun, workspacePath, statusMapping, metadataOnly, specsOnly, sqliteDbPath } = params;

    try {
      // Import TaskService
      const { TaskService } = await import("../../../domain/tasks/taskService");
      const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import("fs");
      const { join, dirname } = await import("path");

      // Use special workspace-aware resolution for task operations
      let currentWorkspacePath: string;
      if (workspacePath) {
        currentWorkspacePath = workspacePath;
      } else {
        // Use workspace resolver for special workspace awareness
        const { resolveTaskWorkspacePath } = await import("../../../utils/workspace-resolver");
        currentWorkspacePath = await resolveTaskWorkspacePath({
          backend: to, // Use target backend for workspace resolution
        });
      }

      // Detect source backend if not specified
      let sourceBackend = from;
      if (!sourceBackend) {
        // Auto-detect based on existing files
        const tasksMarkdownPath = join(currentWorkspacePath, "process", "tasks.md");
        const tasksJsonPath = join(currentWorkspacePath, "process", "tasks.json");

        if (existsSync(tasksJsonPath)) {
          sourceBackend = "json-file";
        } else if (existsSync(tasksMarkdownPath)) {
          sourceBackend = "markdown";
        } else {
          throw new Error("No source backend detected. Please specify --from parameter.");
        }
      }

      if (sourceBackend === to) {
        throw new Error(`Source and target backends are the same: ${sourceBackend}`);
      }

      log.info(`Migrating tasks from ${sourceBackend} to ${to} backend`);

      // Create source and target task services with special workspace awareness
      let sourceService: TaskService;
      let targetService: TaskService;

      // Create backend services with hybrid backend support
      sourceService = await createBackendForMigration(
        sourceBackend, 
        currentWorkspacePath, 
        sqliteDbPath
      );
      
      targetService = await createBackendForMigration(
        to, 
        currentWorkspacePath, 
        sqliteDbPath
      );

      // Get all tasks from source backend
      const sourceTasks = await sourceService.getAllTasks();
      const sourceCount = sourceTasks.length;

      log.info(`Found ${sourceCount} tasks in ${sourceBackend} backend`);

      if (dryRun) {
        log.info("DRY RUN - No changes will be made");
        log.info(`Would migrate ${sourceCount} tasks from ${sourceBackend} to ${to} backend`);
        return {
          success: true,
          dryRun: true,
          sourceBackend,
          targetBackend: to,
          sourceCount,
          tasks: sourceTasks.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
          })),
        };
      }

      // Create backup if requested
      let backupPath: string | undefined;
      if (backup) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        backupPath = join(currentWorkspacePath, `tasks-backup-${sourceBackend}-${timestamp}.json`);
        const backupDir = dirname(backupPath);
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }
        writeFileSync(
          backupPath,
          JSON.stringify(
            {
              backend: sourceBackend,
              timestamp: new Date().toISOString(),
              tasks: sourceTasks,
            },
            null,
            2
          )
        );
        log.info(`Backup created: ${backupPath}`);
      }

      // Migrate tasks to target backend
      let migratedCount = 0;
      const errors: string[] = [];

      for (const task of sourceTasks) {
        try {
          // Apply status mapping if provided
          let targetStatus = task.status;
          if (statusMapping && statusMapping[task.status]) {
            targetStatus = statusMapping[task.status];
          }

          // Create task using title and description
          const createdTask = await targetService.createTaskFromTitleAndDescription(
            task.title,
            task.description || "",
            { force: true }
          );

          // Update status if different from default
          if (targetStatus !== "TODO") {
            await targetService.setTaskStatus(createdTask.id, targetStatus);
          }

          // For JSON backend, set enhanced metadata if available
          if (to === "json-file") {
            const jsonBackend = (targetService as any).currentBackend;

            // Check if backend has metadata capabilities
            if (jsonBackend.setTaskMetadata) {
              await jsonBackend.setTaskMetadata(createdTask.id, {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: targetStatus,
                migratedFrom: sourceBackend,
                originalId: task.id,
              });
            }
          }

          migratedCount++;
          log.debug(`Migrated task ${task.id} -> ${createdTask.id}: ${task.title}`);
        } catch (error) {
          const errorMsg = `Failed to migrate task ${task.id}: ${getErrorMessage(error as any)}`;
          errors.push(errorMsg);
          log.warn(errorMsg);
        }
      }

      const result = {
        success: true,
        sourceBackend,
        targetBackend: to,
        sourceCount,
        migratedCount,
        errors,
        backupPath,
      };

      log.info(`Migration completed: ${migratedCount}/${sourceCount} tasks migrated successfully`);
      if (errors.length > 0) {
        log.warn(`Migration had ${errors.length} errors`);
      }

      // Format human-readable output
      if (context.format === "human") {
        let output = `Task migration ${result.success ? "completed" : "failed"}\n`;
        output += `Source backend: ${result.sourceBackend}\n`;
        output += `Target backend: ${result.targetBackend}\n`;
        output += `Tasks migrated: ${result.migratedCount}/${result.sourceCount}\n`;
        if (result.backupPath) {
          output += `Backup created: ${result.backupPath}\n`;
        }
        if (result.errors && result.errors.length > 0) {
          output += `Errors: ${result.errors.length}\n`;
          result.errors.forEach((error) => {
            output += `  - ${error}\n`;
          });
        }
        return output;
      }

      return result;
    } catch (error) {
      log.error("Task migration failed", { error: getErrorMessage(error as any) });
      throw error;
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
