/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils.js";
import { resolveMainWorkspacePath } from "../workspace.js";
import {
  createTaskService as createTaskServiceImpl,
  createConfiguredTaskService,
  TaskService,
  TaskServiceOptions,
} from "./taskService.js";
import { normalizeTaskId } from "./taskFunctions.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";
import { readFile } from "fs/promises";
// Re-export task data types
export type {} from "../../types/tasks/taskData.js";

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
} from "../../schemas/tasks.js";

// Task spec content parameters are imported from schemas

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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
  }
): Promise<any[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Get the main workspace path (always resolves to main workspace, not session)
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = await deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get tasks
    let tasks = await taskService.listTasks();

    // Filter by status if provided
    if (validParams.status) {
      tasks = tasks.filter((task: any) => task.status === validParams.status);
    } else {
      // Unless "all" is provided, filter out DONE tasks
      if (!validParams.all) {
        tasks = tasks.filter((task: any) => task.status !== TASK_STATUS.DONE);
      }
    }

    return tasks;
  } catch (error) {
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
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
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = await deps.createTaskService({
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
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
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
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = await deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
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
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
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
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = await deps.createTaskService({
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
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: (options) => createTaskServiceImpl(options as any),
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
    const workspacePath = await deps.resolveMainWorkspacePath();

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
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: (options) => createTaskServiceImpl(options as any),
  }
): Promise<{ task: unknown; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

    // Normalize task ID
    const taskId = normalizeTaskId(validParams.taskId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task
    const task = await taskService.getTask(taskId);
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    // Get the task spec path
    const specPath = await taskService.getTaskSpecPath(taskId);
    if (!specPath) {
      throw new ResourceNotFoundError(`Task ${taskId} has no specification file`, "task", taskId);
    }

    // Read the spec content
    let content: string;
    try {
      content = (await readFile(specPath, "utf8")) as string;
    } catch (error) {
      console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
      throw new ResourceNotFoundError(
        `Could not read specification file at ${specPath}`,
        "file",
        specPath
      );
    }

    // If a specific section is requested, extract it
    let sectionContent = content;
    if (validParams.section) {
      const lines = content.split("\n");
      const sectionStart = lines.findIndex((line) =>
        line.toLowerCase().startsWith(`## ${validParams.section!.toLowerCase()}`)
      );

      if (sectionStart === -1) {
        throw new ResourceNotFoundError(
          `Section "${validParams.section}" not found in task ${taskId} specification`
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
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
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

/**
 * Create a task from title and description using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for creating a task from title and description
 * @returns The created task
 */
export async function createTaskFromTitleAndDescription(
  params: TaskCreateFromTitleAndDescriptionParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: (options) => createTaskServiceImpl(options as any),
  }
): Promise<any> {
  try {
    // Validate params with Zod schema
    const validParams = taskCreateFromTitleAndDescriptionParamsSchema.parse(params);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Read description from file if descriptionPath is provided
    let description = validParams.description;
    if (validParams.descriptionPath) {
      try {
        // Resolve relative paths relative to current working directory
        const filePath = require("path").resolve(validParams.descriptionPath);
        description = await readFile(filePath, "utf-8");

        if (!description.trim()) {
          throw new ValidationError(`Description file is empty: ${validParams.descriptionPath}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
          throw new ValidationError(`Description file not found: ${validParams.descriptionPath}`);
        } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission denied")) {
          throw new ValidationError(
            `Permission denied reading description file: ${validParams.descriptionPath}`
          );
        } else {
          throw new ValidationError(
            `Failed to read description file: ${validParams.descriptionPath}. ${errorMessage}`
          );
        }
      }
    }

    // Create the task from title and description
    const task = await taskService.createTaskFromTitleAndDescription(
      validParams.title,
      description!,
      {
        force: validParams.force,
      }
    );

    return task;
  } catch (error) {
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for creating task from title and description",
        error.format(),
        error
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
  }
): Promise<{ success: boolean; taskId: string; task?: any }> {
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
    const validParams = taskDeleteParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await deps.resolveMainWorkspacePath();

    // Create task service
    const taskService = await deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task first to verify it exists and get details
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

    return {
      success: deleted,
      taskId: validParams.taskId,
      task: task,
    };
  } catch (error) {
    console.log(typeof error !== "undefined" ? "error defined" : "error undefined");
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for deleting task", error.format(), error);
    }
    throw error;
  }
}
