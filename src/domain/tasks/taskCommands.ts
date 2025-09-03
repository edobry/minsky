/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  TaskServiceOptions,
  TaskServiceInterface,
} from "./taskService";

import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { readFile } from "fs/promises";
import { createTaskIdParsingErrorMessage } from "../../errors/enhanced-error-templates";
import { resolve, join } from "path";

// Re-export task data types
export type {} from "../../types/tasks/taskData";

// Import task status constants from centralized location
import { TASK_STATUS } from "./taskConstants";
export { TASK_STATUS } from "./taskConstants";
export type { TaskStatus } from "./taskConstants";

// Import schemas
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskStatusGetParamsSchema,
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
  taskCreateFromTitleAndDescriptionParamsSchema,
  taskSpecContentParamsSchema,
  taskDeleteParamsSchema,
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndDescriptionParams,
  type TaskSpecContentParams,
  type TaskDeleteParams,
} from "../../schemas/tasks";

// Helper: normalize task ID inputs to qualified form when appropriate
function normalizeTaskIdInput(input: unknown): string {
  const raw = Array.isArray(input) ? String(input[0] ?? "").trim() : String(input ?? "").trim();
  if (!raw) return raw;
  // Already qualified like md#123 or gh#456
  if (/^[a-z-]+#\d+$/.test(raw)) return raw;
  // Accept forms like "#123" or "123" and normalize to md#123
  const numeric = raw.startsWith("#") ? raw.slice(1) : raw;
  return `md#${numeric}`;
}

/**
 * List tasks with given parameters
 * @param params Parameters for listing tasks
 * @param deps Optional dependencies for testing
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<any[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Prefer injected main workspace path for tests; otherwise resolve from repo
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await resolveRepoPath({
        session: validParams.session,
        repo: validParams.repo,
      }));

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend, // Use multi-backend mode when no backend specified
    });

    // Get tasks with filters - delegate filtering to domain layer
    let tasks = await taskService.listTasks({
      status: (validParams as any).status as string | undefined,
      all: validParams.all,
    });
    // Apply limit client-side if provided
    const limit = (validParams as any).limit as number | undefined;
    if (typeof limit === "number" && limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  } catch (error) {
    log.error("Error listing tasks:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Get a task by ID with given parameters
 * @param params Parameters for getting a task
 * @param deps Optional dependencies for testing
 * @returns Task object
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps?: {
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<any> {
  const startTime = Date.now();
  log.debug("[getTaskFromParams] Starting execution", { params });

  try {
    // Handle taskId as either string or string array and normalize
    const taskIdInput = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
    log.debug("[getTaskFromParams] Processed taskId input", { taskIdInput });

    if (!taskIdInput) {
      throw new ValidationError("Task ID is required");
    }

    const qualifiedTaskId = normalizeTaskIdInput(taskIdInput);
    log.debug("[getTaskFromParams] Using taskId", { taskId: qualifiedTaskId });

    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    log.debug("[getTaskFromParams] About to validate params with Zod");
    const validParams = taskGetParamsSchema.parse(paramsWithQualifiedId);
    log.debug("[getTaskFromParams] Params validated", { validParams });

    // Resolve repository root and use it as workspace path (prefer injected main path)
    const workspacePath = await (deps?.resolveMainWorkspacePath
      ? deps.resolveMainWorkspacePath()
      : resolveRepoPath({ session: validParams.session, repo: validParams.repo }));
    log.debug("[getTaskFromParams] Using workspace path", { workspacePath });

    // Create task service using dependency injection or default implementation
    log.debug("[getTaskFromParams] About to create task service");
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend, // Use multi-backend mode when no backend specified
    });
    log.debug("[getTaskFromParams] Task service created");

    // Get the task
    log.debug("[getTaskFromParams] About to get task");
    const task = await taskService.getTask(validParams.taskId);
    log.debug("[getTaskFromParams] Task retrieved", { taskExists: !!task });

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    const duration = Date.now() - startTime;
    log.debug("[getTaskFromParams] Execution completed", { duration });
    return task;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error("[getTaskFromParams] Error getting task:", {
      error: getErrorMessage(error),
      duration,
    });
    throw error;
  }
}

/**
 * Get task status using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for getting task status
 * @returns Status of the task
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<string> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusGetParamsSchema.parse(paramsWithQualifiedId);

    // Resolve workspace path (prefer injected main path)
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: validParams.session,
        repo: validParams.repo,
      }));

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend, // Let service determine backend via detection/config
    });

    // Get the task
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found or has no status`,
        "task",
        validParams.taskId
      );
    }

    return task.status;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task status",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}

/**
 * Set task status using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for setting task status
 */
export async function setTaskStatusFromParams(
  params: TaskStatusSetParams,
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<void> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusSetParamsSchema.parse(paramsWithQualifiedId);

    // Resolve workspace path (prefer injected main path)
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: validParams.session,
        repo: validParams.repo,
      }));

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend, // Let service determine backend via detection/config
    });

    // Verify the task exists before setting status and get old status for commit message
    const task = await taskService.getTask(validParams.taskId);

    if (!task || !task.id) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }
    const oldStatus = task.status;

    // Set the task status
    await taskService.setTaskStatus(validParams.taskId, validParams.status);

    // Auto-commit functionality was removed - no backend-specific handling needed
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for setting task status",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}

/**
 * Update a task using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for updating a task
 * @returns The updated task
 */
export async function updateTaskFromParams(
  params: {
    taskId: string;
    title?: string;
    spec?: string;
    repo?: string;
    workspace?: string;
    session?: string;
    backend?: string;
  },
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);

    // Resolve workspace path (prefer injected main path)
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: params.session,
        repo: params.repo,
      }));

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: params.backend, // Let service determine backend via detection/config
    });

    // Verify the task exists before updating
    const existingTask = await taskService.getTask(qualifiedTaskId);

    if (!existingTask || !existingTask.id) {
      throw new ResourceNotFoundError(`Task ${qualifiedTaskId} not found`, "task", qualifiedTaskId);
    }

    // Prepare updates object
    const updates: Partial<Task> = {};
    if (params.title !== undefined) {
      updates.title = params.title;
    }
    if (params.spec !== undefined) {
      updates.spec = params.spec;
    }

    // Update the task
    const updatedTask = await taskService.updateTask(qualifiedTaskId, updates);

    return updatedTask;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for updating task",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}

/**
 * Create a task using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for creating a task
 * @returns The created task
 */
export async function createTaskFromParams(
  params: TaskCreateParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createConfiguredTaskService: (options: TaskServiceOptions) => TaskServiceInterface;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<any> {
  try {
    // Validate params with Zod schema
    const validParams = taskCreateParamsSchema.parse(params);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Create task service
    const taskService = deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Create the task
    const task = await taskService.createTask(validParams.title, {
      force: validParams.force,
    });

    // Auto-commit functionality was removed - no backend-specific handling needed

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for creating task",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}

/**
 * Create a task from title and description
 * (exported for tests that import from ./tasks/taskCommands)
 */
export async function createTaskFromTitleAndDescription(
  params: TaskCreateFromTitleAndDescriptionParams,
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<any> {
  // Validate params
  const validParams = taskCreateFromTitleAndDescriptionParamsSchema.parse(params);

  // Resolve workspace path (prefer injected main path)
  const workspacePath =
    (await deps?.resolveMainWorkspacePath?.()) ??
    (await (deps?.resolveRepoPath || resolveRepoPath)({
      session: validParams.session,
      repo: validParams.repo,
    }));

  // Create task service
  const createTaskService =
    deps?.createConfiguredTaskService ||
    (async (options) => await createConfiguredTaskServiceImpl(options));
  const taskService = await createTaskService({
    workspacePath,
    backend: validParams.backend, // Let service determine backend via detection/config
  });

  // Handle spec content - either from spec string or specPath file
  let specContent = validParams.spec || "";

  if (validParams.specPath) {
    const fs = await import("fs/promises");
    try {
      specContent = await fs.readFile(validParams.specPath, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read spec from file ${validParams.specPath}: ${error.message}`);
    }
  }

  // Create the task from title and spec
  const task = await taskService.createTaskFromTitleAndDescription(validParams.title, specContent);

  return task;
}

/**
 * Get task specification content using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for getting task specification content
 * @returns The task specification content
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createConfiguredTaskService: (options: TaskServiceOptions) => TaskServiceInterface;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<{ task: any; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

    // Normalize task ID
    const taskIdString = Array.isArray(validParams.taskId)
      ? validParams.taskId[0]
      : validParams.taskId;
    const taskId = taskIdString; // Use directly since we now only accept qualified IDs

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Create task service
    const taskService = deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task
    const task = await taskService.getTask(taskId);
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    // Use the task's spec path directly
    const specPath = task.specPath;

    if (!specPath) {
      throw new ResourceNotFoundError(`Task ${taskId} has no specification file`, "task", taskId);
    }

    // Read the spec content with workspace-relative path handling
    let content: string;
    try {
      const fullSpecPath = specPath.startsWith("/") ? specPath : join(workspacePath, specPath);
      content = (await readFile(fullSpecPath, "utf8")) as string;
    } catch (error) {
      throw new ResourceNotFoundError(
        `Could not read specification file at ${specPath}`,
        "file",
        specPath
      );
    }

    // If a specific section is requested, extract it
    let sectionContent = content;
    if (validParams.section) {
      const lines = content.toString().split("\n");
      const sectionStart = lines.findIndex((line) =>
        line.toLowerCase().startsWith(`## ${validParams.section!.toLowerCase()}`)
      );

      if (sectionStart === -1) {
        throw new ResourceNotFoundError(
          `Section \"${validParams.section}\" not found in task ${taskId} specification`
        );
      }

      // Find the next section or end of file
      let sectionEnd = lines.length;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }

      sectionContent = lines.slice(sectionStart, sectionEnd).join("\n").trim();
    }

    // Return the task and content
    return {
      task,
      specPath,
      content: sectionContent,
      section: validParams.section,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task specification",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}

/**
 * Delete a task using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for deleting a task
 * @returns Boolean indicating if the task was successfully deleted
 */
export async function deleteTaskFromParams(
  params: TaskDeleteParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createConfiguredTaskService: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<{ success: boolean; taskId: string; task?: any }> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskDeleteParamsSchema.parse(paramsWithQualifiedId);

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Create task service
    const taskService = await deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task first to verify it exists and get details for commit message
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Delete the task
    const deleted = await taskService.deleteTask(validParams.taskId, {
      force: validParams.force,
    });

    // Auto-commit functionality was removed - no backend-specific handling needed

    return {
      success: deleted,
      taskId: validParams.taskId,
      task: task,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for deleting task",
        (error as any).format(),
        error as any
      );
    }
    throw error;
  }
}
