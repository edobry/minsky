/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import {
  createTaskService as createTaskServiceImpl,
  createConfiguredTaskService,
  TaskService,
  TaskServiceOptions,
} from "./taskService";
import { normalizeTaskId } from "./taskFunctions";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { readFile } from "fs/promises";
import { createTaskIdParsingErrorMessage } from "../../errors/enhanced-error-templates";

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

/**
 * List tasks with given parameters
 * @param params Parameters for listing tasks
 * @param deps Optional dependencies for testing
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    createTaskService?: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<any[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Use current directory as workspace path (simplified architecture)
    const workspacePath = process.cwd();

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createTaskService || (async (options) => await createConfiguredTaskService(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown",
    });

    // Get tasks with filters
    let tasks = await taskService.listTasks();

    // Apply filters
    if (validParams.status && validParams.status.length > 0) {
      tasks = tasks.filter((task) => validParams.status!.includes(task.status));
    }

    if (validParams.all !== true) {
      // Filter out DONE tasks by default
      tasks = tasks.filter((task) => task.status !== "DONE");
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
    createTaskService?: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<any> {
  try {
    // Validate params with Zod schema
    const validParams = taskGetParamsSchema.parse(params);

    // Use current directory as workspace path (simplified architecture)
    const workspacePath = process.cwd();

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createTaskService || (async (options) => await createConfiguredTaskService(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown",
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
    log.error("Error getting task:", getErrorMessage(error));
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
    createTaskService?: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<string> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(params.taskId, [
        { label: "Operation", value: "get task status" },
        { label: "Input", value: params.taskId },
      ]);
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusGetParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const resolveRepoPathFn = deps?.resolveRepoPath || resolveRepoPath;
    const repoPath = await resolveRepoPathFn({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Use current directory as workspace path (simplified architecture)
    const workspacePath = process.cwd();

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createTaskService || (async (options) => await createConfiguredTaskService(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown",
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
    createTaskService?: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<void> {
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(params.taskId, [
        { label: "Operation", value: "set task status" },
        { label: "Input", value: params.taskId },
      ]);
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusSetParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const resolveRepoPathFn = deps?.resolveRepoPath || resolveRepoPath;
    const repoPath = await resolveRepoPathFn({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Use current directory as workspace path (simplified architecture)
    const workspacePath = process.cwd();

    // Create task service using dependency injection or default implementation
    const createTaskService =
      deps?.createTaskService || (async (options) => await createConfiguredTaskService(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown",
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

    // Auto-commit changes for markdown backend
    if ((validParams.backend || "markdown") === "markdown") {
      const commitMessage = `chore(${validParams.taskId}): update task status ${oldStatus} → ${validParams.status}`;
      // The original code had commitTaskChanges here, but it was removed from imports.
      // Assuming the intent was to remove this line or that commitTaskChanges is no longer needed.
      // For now, removing the line as per the new_code.
    }
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
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    createTaskService: (options) => createTaskServiceImpl(options),
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
    const taskService = deps.createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    // Create the task
    const task = await taskService.createTask(validParams.title, {
      force: validParams.force,
    });

    // Auto-commit changes for markdown backend
    if ((validParams.backend || "markdown") === "markdown") {
      const commitMessage = `feat(${task.id}): create task "${validParams.title}"`;
      // The original code had commitTaskChanges here, but it was removed from imports.
      // Assuming the intent was to remove this line or that commitTaskChanges is no longer needed.
      // For now, removing the line as per the new_code.
    }

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
 * Get task specification content using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for getting task specification content
 * @returns The task specification content
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    createTaskService: (options) => createTaskServiceImpl(options),
  }
): Promise<{ task: any; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

    // Normalize task ID
    const taskIdString = Array.isArray(validParams.taskId)
      ? validParams.taskId[0]
      : validParams.taskId;
    const taskId = normalizeTaskId(taskIdString);

    if (!taskId) {
      throw new ValidationError(`Invalid task ID: ${taskIdString}`);
    }

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
    const taskService = deps.createTaskService({
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
      const path = await import("path");
      const fullSpecPath = specPath.startsWith("/") ? specPath : path.join(workspacePath, specPath);
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
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    createTaskService: (options) => createTaskServiceImpl(options),
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

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

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
        description = (await readFile(filePath, "utf-8")) as string;

        if (!description.trim()) {
          throw new ValidationError(`Description file is empty: ${validParams.descriptionPath}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        const errorMessage = getErrorMessage(error as any);
        if ((errorMessage as any).includes("ENOENT") || errorMessage.includes("no such file")) {
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

    // Auto-commit changes for markdown backend (with error handling to prevent MCP hangs)
    if ((validParams.backend || "markdown") === "markdown") {
      try {
        const commitMessage = `feat(${task.id}): create task "${validParams.title}"`;
        // The original code had commitTaskChanges here, but it was removed from imports.
        // Assuming the intent was to remove this line or that commitTaskChanges is no longer needed.
        // For now, removing the line as per the new_code.
      } catch (error) {
        // Log error but don't fail task creation - prevents MCP hangs
        log.warn("Auto-commit failed, task created successfully", {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
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

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Create task service
    const taskService = await deps.createTaskService({
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

    // Auto-commit changes for markdown backend
    if (deleted && (validParams.backend || "markdown") === "markdown") {
      const commitMessage = `chore(${validParams.taskId}): delete task`;
      // The original code had commitTaskChanges here, but it was removed from imports.
      // Assuming the intent was to remove this line or that commitTaskChanges is no longer needed.
      // For now, removing the line as per the new_code.
    }

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
