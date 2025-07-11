/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils.js";
import { resolveMainWorkspacePath } from "../workspace.js";
import { getErrorMessage } from "../../errors/index";
import {
  createTaskService as createTaskServiceImpl,
  createConfiguredTaskService,
  TaskService,
  TaskServiceOptions,
} from "./taskService.js";
import { normalizeTaskId } from "./taskFunctions.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";
import { readFile } from "fs/promises";
import { 
  createTaskIdParsingErrorMessage 
} from "../../errors/enhanced-error-templates.js";
import { createFormattedValidationError } from "../../utils/zod-error-formatter.js";
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
    createTaskService: async (options) => await createConfiguredTaskService(options as any),
  }
): Promise<any[]> {
  try {
    // Validate params with Zod schema
    const validParams = (taskListParamsSchema as any).parse(params as any);

    // Get the main workspace path (always resolves to main workspace, not session)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = await (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get tasks
    let tasks = await (taskService as any).listTasks();

    // Filter by status if provided
    if (validParams.filter) {
      tasks = tasks.filter((task: any) => (task as any).status === validParams.filter);
    } else {
      // Unless "all" is provided, filter out DONE and CLOSED tasks
      if (!validParams.all) {
        tasks = tasks.filter((task: any) => 
          (task as any).status !== TASK_STATUS.DONE && (task as any).status !== TASK_STATUS.CLOSED
        );
      }
    }

    return tasks;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for listing tasks", (error as any).format(), error as any);
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
    createTaskService: async (options) => await createConfiguredTaskService(options as any),
  }
): Promise<any> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId((params as any).taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(
        (params as any).taskId,
        [
          { label: "Operation", value: "get task" },
          { label: "Input", value: (params as any).taskId }
        ]
      );
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = (taskGetParamsSchema as any).parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = await (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task
    const task = await (taskService as any).getTask((validParams as any).taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${(validParams as any).taskId} not found`,
        "task",
        (validParams as any).taskId
      );
    }

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for getting task", (error as any).format(), error as any);
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
    createTaskService: async (options) => await createConfiguredTaskService(options as any),
  }
): Promise<string> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId((params as any).taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(
        (params as any).taskId,
        [
          { label: "Operation", value: "get task status" },
          { label: "Input", value: (params as any).taskId }
        ]
      );
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = (taskStatusGetParamsSchema as any).parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = await (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task
    const task = await (taskService as any).getTask((validParams as any).taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${(validParams as any).taskId} not found or has no status`,
        "task",
        (validParams as any).taskId
      );
    }

    return (task as any).status;
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
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options as any),
  }
): Promise<void> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId((params as any).taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(
        (params as any).taskId,
        [
          { label: "Operation", value: "set task status" },
          { label: "Input", value: (params as any).taskId }
        ]
      );
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = (taskStatusSetParamsSchema as any).parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = await (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Verify the task exists before setting status
    const task = await (taskService as any).getTask((validParams as any).taskId);
    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${(validParams as any).taskId} not found`,
        "task",
        (validParams as any).taskId
      );
    }

    // Set the task status
    await (taskService as any).setTaskStatus((validParams as any).taskId, (validParams as any).status);
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
    const validParams = (taskCreateParamsSchema as any).parse(params as any);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Create the task
    const task = await (taskService as any).createTask((validParams as any).title, {
      force: validParams.force,
    });

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for creating task", (error as any).format(), error as any);
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
): Promise<{ task: any; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = (taskSpecContentParamsSchema as any).parse(params as any);

    // Normalize task ID
    const taskIdString = Array.isArray((validParams as any).taskId) ? (validParams as any).taskId[0] : (validParams as any).taskId;
    const taskId = normalizeTaskId(taskIdString);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task
    const task = await (taskService as any).getTask(taskId);
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    // Get the task spec path
    const specPath = await (taskService as any).getTaskSpecPath(taskId);
    if (!specPath) {
      throw new ResourceNotFoundError(`Task ${taskId} has no specification file`, "task", taskId);
    }

    // Read the spec content
    let content: string;
    try {
      content = (await readFile(specPath, "utf8")) as string;
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
      const lines = (((content) as any).toString() as any).split("\n");
      const sectionStart = (lines as any).findIndex((line) =>
        (line.toLowerCase() as any).startsWith(`## ${(validParams.section! as any).toLowerCase()}`)
      );

      if (sectionStart === -1) {
        throw new ResourceNotFoundError(
          `Section "${validParams.section}" not found in task ${taskId} specification`
        );
      }

      // Find the next section or end of file
      let sectionEnd = (lines as any).length;
      for (let i = sectionStart + 1; i < (lines as any).length; i++) {
        if ((lines[i] as any).startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }

      sectionContent = ((lines as any).slice(sectionStart, sectionEnd).join("\n") as any).trim();
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
    const validParams = (taskCreateFromTitleAndDescriptionParamsSchema as any).parse(params as any);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Read description from file if descriptionPath is provided
    let description = (validParams as any).description;
    if (validParams.descriptionPath) {
      try {
        // Resolve relative paths relative to current working directory
        const filePath = (require("path") as any).resolve(validParams.descriptionPath);
        description = ((await readFile(filePath, "utf-8")) as any).toString();

        if (!(description as any).trim()) {
          throw new ValidationError(`Description file is empty: ${validParams.descriptionPath}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        const errorMessage = getErrorMessage(error as any);
        if ((errorMessage as any).includes("ENOENT") || (errorMessage as any).includes("no such file")) {
          throw new ValidationError(`Description file not found: ${validParams.descriptionPath}`);
        } else if ((errorMessage as any).includes("EACCES") || (errorMessage as any).includes("permission denied")) {
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
    const task = await (taskService as any).createTaskFromTitleAndDescription(
      (validParams as any).title,
      description!,
      {
        force: validParams.force,
      }
    );

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for creating task from title and description",
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
    resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveMainWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options as any),
  }
): Promise<{ success: boolean; taskId: string; task?: any }> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId((params as any).taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${(params as any).taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = (taskDeleteParamsSchema as any).parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await (deps as any).resolveRepoPath({
      session: (validParams as any).session,
      repo: validParams.repo,
    });

    // Then get the workspace path (main repo or session's main workspace)
    const workspacePath = await (deps as any).resolveMainWorkspacePath();

    // Create task service
    const taskService = await (deps as any).createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Get the task first to verify it exists and get details
    const task = await (taskService as any).getTask((validParams as any).taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${(validParams as any).taskId} not found`,
        "task",
        (validParams as any).taskId
      );
    }

    // Delete the task
    const deleted = await (taskService as any).deleteTask((validParams as any).taskId, {
      force: validParams.force,
    });

    return {
      success: deleted,
      taskId: (validParams as any).taskId,
      task: task,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for deleting task", (error as any).format(), error as any);
    }
    throw error;
  }
}
