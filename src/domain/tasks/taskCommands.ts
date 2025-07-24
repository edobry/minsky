/**
 * Interface-agnostic command functions for task operations
 * These functions are used by the CLI and MCP adapters
 */
import { z } from "zod";
import { resolveRepoPath } from "../repo-utils";
import { resolveTaskWorkspacePath } from "../../utils/workspace-resolver";
import { commitTaskChanges } from "../../utils/task-workspace-commit";
import { getErrorMessage } from "../../errors/index";
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
import { createFormattedValidationError } from "../../utils/zod-error-formatter";
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

// Task spec content parameters are imported from schemas

/**
 * List tasks using the provided parameters
 * This function implements the interface-agnostic command architecture
 * @param params Parameters for listing tasks
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<any[]> {
  // If deps not provided, use the default implementations
  const actualDeps = deps || {
    resolveRepoPath,
    resolveTaskWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
  };
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Get intelligent workspace path based on backend requirements
    const backend = validParams.backend || "markdown";
    const workspacePath = await actualDeps.resolveTaskWorkspacePath({ backend });

    // Create task service with read-only mode for better performance
    const taskService = await TaskService.createWithEnhancedBackend({
      backend: backend as "markdown" | "json-file",
      backendConfig: {
        name: backend,
        workspacePath,
      },
      isReadOperation: true,
    });

    // Get tasks
    let tasks = await taskService.listTasks();

    // Filter by status if provided
    if (validParams.filter) {
      tasks = tasks.filter((task: any) => task.status === validParams.filter);
    } else {
      // Unless "all" is provided, filter out DONE and CLOSED tasks
      if (!validParams.all) {
        tasks = tasks.filter(
          (task: any) => task.status !== TASK_STATUS.DONE && task.status !== TASK_STATUS.CLOSED
        );
      }
    }

    return tasks;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for listing tasks",
        (error as any).format(),
        error as any
      );
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
  deps?: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  }
): Promise<any> {
  // If deps not provided, use the default implementations
  const actualDeps = deps || {
    resolveRepoPath,
    resolveTaskWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
  };
  try {
    // Normalize the taskId before validation
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      const errorMessage = createTaskIdParsingErrorMessage(params.taskId, [
        { label: "Operation", value: "get task" },
        { label: "Input", value: params.taskId },
      ]);
      throw new ValidationError(errorMessage);
    }
    const paramsWithNormalizedId = { ...params, taskId: normalizedTaskId };

    // Validate params with Zod schema
    const validParams = taskGetParamsSchema.parse(paramsWithNormalizedId);

    // First get the repo path (needed for workspace resolution)
    const repoPath = await actualDeps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await actualDeps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
    });

    // Create task service with read-only mode for better performance
    const taskService = await TaskService.createWithEnhancedBackend({
      backend: (validParams.backend || "markdown") as "markdown" | "json-file",
      backendConfig: {
        name: validParams.backend || "markdown",
        workspacePath,
      },
      isReadOperation: true,
    });

    // Get the task
    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(`Task ${validParams.taskId} not found`, "task", validParams.taskId);
    }

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task",
        (error as any).format(),
        error as any
      );
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
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
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
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
    });

    // Create task service
    const taskService = await deps.createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown", // Use same fallback as setTaskStatusFromParams
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
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
    createTaskService: async (options) => await createConfiguredTaskService(options),
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
    const repoPath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    // Then get the workspace path using backend-aware resolution
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
    });

    // Create task service with explicit backend to avoid configuration issues
    const taskService = await deps.createTaskService({
      workspacePath,
      backend: validParams.backend || "markdown", // Use markdown as default to avoid config lookup
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
      await commitTaskChanges({
        workspacePath,
        message: commitMessage,
        repoUrl: repoPath,
        backend: validParams.backend || "markdown",
      });
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
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
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
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
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
      await commitTaskChanges({
        workspacePath,
        message: commitMessage,
        repoUrl: repoPath,
        backend: validParams.backend || "markdown",
      });
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
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
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
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
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

    // SYNCHRONIZATION FIX: Use the stored spec path directly from the task database
    // instead of calling getTaskSpecPath which may generate stale paths
    const { fixTaskSpecPath } = await import("../../utils/task-workspace-commit");
    const specPath = await fixTaskSpecPath(task.id, task.specPath || "", workspacePath);

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
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => TaskService;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
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
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
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

    // Auto-commit changes for markdown backend
    if ((validParams.backend || "markdown") === "markdown") {
      const commitMessage = `feat(${task.id}): create task "${validParams.title}"`;
      await commitTaskChanges({
        workspacePath,
        message: commitMessage,
        repoUrl: repoPath,
        backend: validParams.backend || "markdown",
      });
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
    resolveTaskWorkspacePath: typeof resolveTaskWorkspacePath;
    createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
  } = {
    resolveRepoPath,
    resolveTaskWorkspacePath,
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
    const workspacePath = await deps.resolveTaskWorkspacePath({
      backend: validParams.backend || "markdown",
      repoUrl: repoPath,
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
      await commitTaskChanges({
        workspacePath,
        message: commitMessage,
        repoUrl: repoPath,
        backend: validParams.backend || "markdown",
      });
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
