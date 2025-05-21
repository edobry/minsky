/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */

import { z } from "zod";
import { log } from "../../utils/logger.js";
import { resolveRepoPath } from "../repo-utils.js";
import { resolveWorkspacePath } from "../workspace.js";
import { createTaskService } from "./taskService.js";
import { normalizeTaskId } from "./taskFunctions.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";

// Re-export task data types
export type { TaskData } from "../../types/tasks/taskData.js";

// Constant representing task statuses
export const TASK_STATUS = {
  TODO: "TODO",
  IN_PROGRESS: "IN-PROGRESS",
  IN_REVIEW: "IN-REVIEW",
  DONE: "DONE",
} as const;

export type TaskStatus = typeof TASK_STATUS[keyof typeof TASK_STATUS];

// Import schemas
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskStatusGetParamsSchema,
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
} from "../../schemas/tasks.js";

// Import params types
import type {
  TaskListParams,
  TaskGetParams,
  TaskStatusGetParams,
  TaskStatusSetParams,
  TaskCreateParams,
} from "../../schemas/tasks.js";

/**
 * List tasks using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for listing tasks
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<any[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveWorkspacePath({
      workspace: validParams.workspace,
      sessionRepo: repoPath,
    });

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    let tasks: any[];

    // If status filter is explicitly provided, use it
    if (validParams.filter) {
      tasks = await taskService.listTasks({
        status: validParams.filter,
      });
    } else {
      // Otherwise get all tasks first
      tasks = await taskService.listTasks();

      // Unless "all" is provided, filter out DONE tasks
      if (!validParams.all) {
        tasks = tasks.filter((task) => task.status !== TASK_STATUS.DONE);
      }
    }

    return tasks;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for listing tasks", error.format(), error);
    }
    throw error;
  }
}

/**
 * Get a task by ID using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for getting a task
 * @returns Task or null if not found
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<any> {
  try {
    // Handle both single ID and array of IDs
    if (Array.isArray(params.taskId)) {
      // Process multiple task IDs
      return getMultipleTasksFromParams(params, deps);
    } else {
      // Process single task ID (original behavior)
      return getSingleTaskFromParams(params, deps);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for getting task", error.format(), error);
    }
    throw error;
  }
}

/**
 * Helper function to get a single task by ID
 * @param params Parameters with a single task ID
 * @param deps Dependencies for task retrieval
 * @returns Task or null if not found
 */
async function getSingleTaskFromParams(
  params: TaskGetParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  }
): Promise<any> {
  // Normalize the taskId before validation
  const normalizedTaskId = normalizeTaskId(params.taskId as string);
  if (!normalizedTaskId) {
    throw new ValidationError(
      `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
    );
  }
  const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

  // Validate params with Zod schema
  const validParams = taskGetParamsSchema.parse(paramsWithNormalizedId);

  // First get the repo path (needed for workspace resolution)
  const repoPath = await deps.resolveRepoPath({
    session: validParams.session,
    repo: validParams.repo,
  });

  // Then get the workspace path (main repo or session's main workspace)
  const workspacePath = await deps.resolveWorkspacePath({
    workspace: validParams.workspace,
    sessionRepo: repoPath,
  });

  // Create task service
  const taskService = deps.createTaskService({
    workspacePath,
    backend: validParams.backend,
  });

  // Get the task
  const task = await taskService.getTask(validParams.taskId as string);

  if (!task) {
    throw new ResourceNotFoundError(
      `Task #${validParams.taskId} not found`,
      "task",
      validParams.taskId as string
    );
  }

  return task;
}

/**
 * Helper function to get multiple tasks by IDs
 * @param params Parameters with an array of task IDs
 * @param deps Dependencies for task retrieval
 * @returns Array of tasks with result info
 */
async function getMultipleTasksFromParams(
  params: TaskGetParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  }
): Promise<{ tasks: any[], errors: { taskId: string, error: string }[] }> {
  // Normalize and validate each task ID
  const taskIds = (params.taskId as string[]);
  const normalizedTaskIds = taskIds.map((id) => {
    const normalizedId = normalizeTaskId(id);
    if (!normalizedId) {
      throw new ValidationError(
        `Invalid task ID: '${id}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    return normalizedId;
  });

  const paramsWithNormalizedIds = { ...params, taskId: normalizedTaskIds };

  // Validate params with Zod schema
  const validParams = taskGetParamsSchema.parse(paramsWithNormalizedIds);

  // First get the repo path (needed for workspace resolution)
  const repoPath = await deps.resolveRepoPath({
    session: validParams.session,
    repo: validParams.repo,
  });

  // Then get the workspace path (main repo or session's main workspace)
  const workspacePath = await deps.resolveWorkspacePath({
    workspace: validParams.workspace,
    sessionRepo: repoPath,
  });

  // Create task service
  const taskService = deps.createTaskService({
    workspacePath,
    backend: validParams.backend,
  });

  // Get all tasks
  const result = {
    tasks: [] as any[],
    errors: [] as { taskId: string, error: string }[]
  };

  // Process each task ID
  for (const taskId of normalizedTaskIds) {
    try {
      const task = await taskService.getTask(taskId);
      if (task) {
        result.tasks.push(task);
      } else {
        result.errors.push({
          taskId,
          error: `Task ${taskId} not found`
        });
      }
    } catch (error) {
      result.errors.push({
        taskId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // If all tasks had errors, throw an error
  if (result.tasks.length === 0 && result.errors.length > 0) {
    throw new ResourceNotFoundError(
      `None of the requested tasks were found`,
      "tasks",
      normalizedTaskIds.join(",")
    );
  }

  return result;
}

/**
 * Get task status using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for getting task status
 * @returns Status of the task
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<string> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusGetParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveWorkspacePath({
      workspace: validParams.workspace,
      sessionRepo: repoPath,
    });

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task status
    const status = await taskService.getTaskStatus(validParams.taskId);

    if (!status) {
      throw new ResourceNotFoundError(
        `Task #${validParams.taskId} not found or has no status`,
        "task",
        validParams.taskId
      );
    }

    return status;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task status",
        error.format(),
        error
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
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<void> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusSetParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveWorkspacePath({
      workspace: validParams.workspace,
      sessionRepo: repoPath,
    });

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Verify the task exists before setting status
    const task = await taskService.getTask(validParams.taskId);
    if (!task) {
      throw new ResourceNotFoundError(
        `Task #${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Set the task status
    await taskService.setTaskStatus(validParams.taskId, validParams.status);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for setting task status",
        error.format(),
        error
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
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => ReturnType<typeof createTaskService>;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
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

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveWorkspacePath({
      workspace: validParams.workspace,
      sessionRepo: repoPath,
    });

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Create the task
    const task = await taskService.createTask(validParams.specPath, {
      force: validParams.force,
    });

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for creating task", error.format(), error);
    }
    throw error;
  }
} 
