/**
 * Mutation command functions for task operations (write operations).
 * Implements the interface-agnostic command architecture for set-status, update, create, and delete.
 */
import { z } from "zod";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index";
import { readTextFile } from "../../../utils/fs";
import type { Task } from "../types";
import {
  taskStatusSetParamsSchema,
  taskCreateParamsSchema,
  taskCreateFromTitleAndDescriptionParamsSchema,
  taskDeleteParamsSchema,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndDescriptionParams,
  type TaskDeleteParams,
} from "../../../schemas/tasks";
import {
  resolveRepoPath,
  normalizeTaskIdInput,
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  type TaskServiceOptions,
  type TaskServiceInterface,
} from "./shared";
import { getErrorMessage } from "../../../errors/index";

/**
 * Set task status using the provided parameters.
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
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    const validParams = taskStatusSetParamsSchema.parse(paramsWithQualifiedId);

    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: validParams.session,
        repo: validParams.repo,
      }));

    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    const task = await taskService.getTask(validParams.taskId);

    if (!task || !task.id) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

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
 * Update a task using the provided parameters.
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
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);

    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await (deps?.resolveRepoPath || resolveRepoPath)({
        session: params.session,
        repo: params.repo,
      }));

    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: params.backend,
    });

    const existingTask = await taskService.getTask(qualifiedTaskId);

    if (!existingTask || !existingTask.id) {
      throw new ResourceNotFoundError(`Task ${qualifiedTaskId} not found`, "task", qualifiedTaskId);
    }

    const updates: Partial<Task> = {};
    if (params.title !== undefined) {
      updates.title = params.title;
    }
    if (params.spec !== undefined) {
      updates.specPath = params.spec;
    }

    const updatedTask = await taskService.updateTask?.(qualifiedTaskId, updates);

    if (!updatedTask) {
      throw new Error(`Failed to update task ${qualifiedTaskId}: updateTask returned no result`);
    }
    return updatedTask;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for updating task", error.format(), error);
    }
    throw error;
  }
}

/**
 * Create a task using the provided parameters.
 */
export async function createTaskFromParams(
  params: TaskCreateParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createConfiguredTaskService: (
      options: TaskServiceOptions
    ) => TaskServiceInterface | Promise<TaskServiceInterface>;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<Task> {
  try {
    const validParams = taskCreateParamsSchema.parse(params);

    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    const taskService = await deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    const task = await taskService.createTask(validParams.title, {
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
 * Create a task from title and description.
 */
export async function createTaskFromTitleAndDescription(
  params: TaskCreateFromTitleAndDescriptionParams,
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  const validParams = taskCreateFromTitleAndDescriptionParamsSchema.parse(params);

  const workspacePath =
    (await deps?.resolveMainWorkspacePath?.()) ??
    (await (deps?.resolveRepoPath || resolveRepoPath)({
      session: validParams.session,
      repo: validParams.repo,
    }));

  const createTaskService =
    deps?.createConfiguredTaskService ||
    (async (options) => await createConfiguredTaskServiceImpl(options));
  const taskService = await createTaskService({
    workspacePath,
    backend: validParams.backend,
  });

  let specContent = validParams.spec || "";

  if (validParams.specPath) {
    try {
      specContent = await readTextFile(validParams.specPath);
    } catch (error) {
      throw new Error(
        `Failed to read spec from file ${validParams.specPath}: ${getErrorMessage(error)}`
      );
    }
  }

  const task = await taskService.createTaskFromTitleAndSpec(validParams.title, specContent);

  return task;
}

/**
 * Delete a task using the provided parameters.
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
): Promise<{ success: boolean; taskId: string; task?: Task }> {
  try {
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    const validParams = taskDeleteParamsSchema.parse(paramsWithQualifiedId);

    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    const taskService = await deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    const task = await taskService.getTask(validParams.taskId);

    if (!task) {
      throw new ResourceNotFoundError(
        `Task ${validParams.taskId} not found`,
        "task",
        validParams.taskId
      );
    }

    const deleted = await taskService.deleteTask(validParams.taskId, {
      force: validParams.force,
    });

    return {
      success: deleted,
      taskId: validParams.taskId,
      task: task,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid parameters for deleting task", error.format(), error);
    }
    throw error;
  }
}
