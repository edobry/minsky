/**
 * Task Mutation Commands
 *
 * Interface-agnostic write operations: setStatus, update, create,
 * createFromTitleAndSpec, delete.
 */

import { z } from "zod";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  TaskServiceOptions,
  TaskServiceInterface,
} from "../taskService";
import type { Task } from "../types";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index";
import {
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
  taskCreateFromTitleAndSpecParamsSchema,
  taskDeleteParamsSchema,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndSpecParams,
  type TaskDeleteParams,
} from "../../../schemas/tasks";
import { resolveRepoPath, normalizeTaskIdInput } from "./shared-helpers";
import { validateStatusTransition } from "../status-transitions";
import { TaskStatus } from "../taskConstants";

/**
 * Set task status using the provided parameters
 */
export async function setTaskStatusFromParams(
  params: TaskStatusSetParams,
  deps?: {
    taskService?: TaskServiceInterface;
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

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await (deps?.resolveRepoPath || resolveRepoPath)({
          session: validParams.session,
          repo: validParams.repo,
        }));

      const createTaskService =
        deps?.createConfiguredTaskService ||
        (async (options: TaskServiceOptions) => await createConfiguredTaskServiceImpl(options));

      taskService = await createTaskService({
        workspacePath,
        backend: validParams.backend,
      });
    }

    // Verify the task exists before setting status and get old status for commit message
    const task = await taskService.getTask(validParams.taskId);

    if (!task || !task.id) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    // Validate the status transition
    if (task.status) {
      validateStatusTransition(task.status as TaskStatus, validParams.status as TaskStatus);
    }

    // Set the task status
    await taskService.setTaskStatus(validParams.taskId, validParams.status);

    // Auto-commit functionality was removed - no backend-specific handling needed
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for setting task status",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Update a task using the provided parameters
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
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await (deps?.resolveRepoPath || resolveRepoPath)({
          session: params.session,
          repo: params.repo,
        }));

      const createTaskService =
        deps?.createConfiguredTaskService ||
        (async (options: TaskServiceOptions) => await createConfiguredTaskServiceImpl(options));

      taskService = await createTaskService({
        workspacePath,
        backend: params.backend,
      });
    }

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

    // Update the task
    const updatedTask = await taskService.updateTask?.(qualifiedTaskId, updates);

    if (!updatedTask) {
      throw new Error(`Failed to update task ${qualifiedTaskId}: updateTask returned no result`);
    }
    return updatedTask;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for updating task",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Create a task using the provided parameters
 */
export async function createTaskFromParams(
  params: TaskCreateParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (
      options: TaskServiceOptions
    ) => TaskServiceInterface | Promise<TaskServiceInterface>;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<Task> {
  try {
    // Validate params with Zod schema
    const validParams = taskCreateParamsSchema.parse(params);

    // Use DI-provided taskService when available
    let taskService = deps.taskService;
    if (!taskService) {
      const resolveRepo = deps.resolveRepoPath || resolveRepoPath;
      const workspacePath = await resolveRepo({
        session: validParams.session,
        repo: validParams.repo,
      });

      const createTaskService =
        deps.createConfiguredTaskService ||
        (async (options: TaskServiceOptions) => await createConfiguredTaskServiceImpl(options));

      taskService = await createTaskService({
        workspacePath,
        backend: validParams.backend,
      });
    }

    // Create the task from title and spec content
    const specContent = validParams.spec || validParams.description || "";
    const task = await taskService.createTaskFromTitleAndSpec(validParams.title, specContent, {
      force: validParams.force,
      tags: validParams.tags,
    });

    // Auto-commit functionality was removed - no backend-specific handling needed

    return task;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for creating task",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Create a task from title and spec
 */
export async function createTaskFromTitleAndSpec(
  params: TaskCreateFromTitleAndSpecParams,
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  // Validate params
  const validParams = taskCreateFromTitleAndSpecParamsSchema.parse(params);

  // Use DI-provided taskService when available
  let taskService = deps?.taskService;
  if (!taskService) {
    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: validParams.session,
        repo: validParams.repo,
      }));

    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options: TaskServiceOptions) => await createConfiguredTaskServiceImpl(options));
    taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend,
    });
  }

  // Handle spec content - from spec string only
  const specContent = validParams.spec || "";

  // Create the task from title and spec
  const task = await taskService.createTaskFromTitleAndSpec(validParams.title, specContent);

  return task;
}

/**
 * Delete a task using the provided parameters
 */
export async function deleteTaskFromParams(
  params: TaskDeleteParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<{ success: boolean; taskId: string; task?: Task }> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskDeleteParamsSchema.parse(paramsWithQualifiedId);

    // Use DI-provided taskService when available
    let taskService = deps.taskService;
    if (!taskService) {
      const resolveRepo = deps.resolveRepoPath || resolveRepoPath;
      const workspacePath = await resolveRepo({
        session: validParams.session,
        repo: validParams.repo,
      });

      const createTaskService =
        deps.createConfiguredTaskService ||
        (async (options: TaskServiceOptions) => await createConfiguredTaskServiceImpl(options));

      taskService = await createTaskService({
        workspacePath,
        backend: validParams.backend,
      });
    }

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
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}
