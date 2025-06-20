/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils.js";
import { resolveWorkspacePath } from "../workspace.js";
import { createTaskService } from "./taskService.js";
import type { TaskService } from "./taskService.js";
import { normalizeTaskId } from "./taskFunctions.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";
import fs from "fs/promises";
// Re-export task data types
export type { TaskData } from "../../types/tasks/taskData.js";

// Import task status constants from centralized location
import { TASK_STATUS } from "./taskConstants.js";
export { TASK_STATUS } from "./taskConstants.js";
export type { TaskStatus } from "./taskConstants.js";

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

// Define the schema and type for task spec content parameters
// These will eventually be moved to the tasks.js schema file
export const taskSpecContentParamsSchema = z
  .object({
    taskId: z.string().min(1).describe("ID of the task to retrieve specification content for"),
    section: z
      .string()
      .optional()
      .describe("Specific section of the specification to retrieve (e.g., 'requirements')"),
    backend: z.string().optional().describe("Specify task backend (markdown, json-file, github)"),
  })
  .merge(
    z.object({
      repo: z.string().optional().describe("Repository path"),
      session: z.string().optional().describe("Session identifier"),
      workspace: z.string().optional().describe("Workspace path"),
    })
  );

// Type for task spec content parameters
export type TaskSpecContentParams = z.infer<typeof taskSpecContentParamsSchema>;

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
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
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
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<any> {
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
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for getting task", error.format(), error);
    }
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
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
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
        `Task ${validParams.taskId} not found or has no status`,
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
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
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
        `Task ${validParams.taskId} not found`,
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
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
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
    resolveWorkspacePath: typeof resolveWorkspacePath;
    createTaskService: (options: { workspacePath: string; backend?: string }) => TaskService;
  } = {
    resolveRepoPath,
    resolveWorkspacePath,
    createTaskService: (options) => createTaskService(options),
  }
): Promise<{ task: any; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

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
    const task = await taskService.getTask(validParams.taskId);
    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Get the task spec path
    const specPath = task.specPath;
    if (!specPath) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} has no specification file`,
        "task",
        validParams.taskId
      );
    }

    // Read the spec content
    let content: string;
    try {
      content = await fs.readFile(specPath, "utf8");
    } catch (error) {
      throw new ResourceNotFoundError(
        `Could not read specification file at ${specPath}`,
        "file",
        specPath
      );
    }

    // Return the task and content
    return {
      task,
      specPath,
      content,
      section: validParams.section,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task specification",
        error.format(),
        error
      );
    }
    throw error;
  }
}
