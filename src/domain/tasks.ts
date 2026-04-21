/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks.
 *
 * This is a thin facade that re-exports types from sub-modules and provides
 * parameter-validated command functions used by CLI/MCP adapters.
 */

import { log } from "../utils/logger";
import { createConfiguredTaskService } from "./tasks/taskService";
import { ResourceNotFoundError } from "../errors/index";
import { first } from "../utils/array-safety";
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskCreateParamsSchema,
  taskDeleteParamsSchema,
  taskStatusSetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
} from "../schemas/tasks";
import type { PersistenceProvider } from "./persistence/types";
import type { TaskServiceInterface } from "./tasks/taskService";

// ---- Dependency injection types ----

export interface TaskServiceDeps {
  persistenceProvider?: PersistenceProvider;
  taskService?: TaskServiceInterface;
}

// ---- Re-exports from sub-modules ----

// Types
export type { TaskBackend } from "./tasks/types";
export type { Task, TaskListOptions, CreateTaskOptions, DeleteTaskOptions } from "./tasks/types";

// Service
export { createConfiguredTaskService } from "./tasks/taskService";
export type { TaskServiceInterface } from "./tasks/taskService";

// Constants
export { TASK_STATUS, TASK_STATUS_CHECKBOX } from "./tasks/taskConstants";
export type { TaskStatus } from "./tasks/taskConstants";

// ---- Command functions (parameter-validated wrappers) ----

export async function listTasksFromParams(params: Record<string, unknown>, deps?: TaskServiceDeps) {
  const validParams = taskListParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.list params", { backend: validParams.backend });

  // Use CLI backend if provided, otherwise use multi-backend mode (no default)
  const backend = validParams.backend;

  if (backend) {
    log.debug("tasks.list using CLI backend", { backend });
  } else {
    log.debug("tasks.list using multi-backend mode (no default backend)");
  }

  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend,
      persistenceProvider: deps?.persistenceProvider,
    }));

  log.debug("tasks.list created TaskService", {
    backend: taskService.listBackends?.().find((b) => b.prefix === backend)?.name || "default",
  });
  let tasks = await taskService.listTasks({
    status: validParams.status,
    all: validParams.all,
    backend: validParams.backend,
    tags: validParams.tags,
  });
  // Apply limit client-side if provided
  if (typeof validParams.limit === "number" && validParams.limit > 0) {
    tasks = tasks.slice(0, validParams.limit);
  }
  return tasks;
}

export async function getTaskFromParams(params: Record<string, unknown>, deps?: TaskServiceDeps) {
  const validParams = taskGetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.get params", { backend: validParams.backend });

  const backend = validParams.backend;

  if (backend) {
    log.debug("tasks.get using CLI backend", { backend });
  } else {
    log.debug("tasks.get using multi-backend mode (no default backend)");
  }

  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend,
      persistenceProvider: deps?.persistenceProvider,
    }));

  log.debug("tasks.get created TaskService", {
    backend: taskService.listBackends?.().find((b) => b.prefix === backend)?.name || "default",
  });
  const taskId = Array.isArray(validParams.taskId)
    ? first(validParams.taskId, "taskId array")
    : validParams.taskId;
  const task = await taskService.getTask(taskId);
  if (!task) {
    throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
  }
  return task;
}

export async function getTaskStatusFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  const validParams = taskStatusGetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.status.get params", { backend: validParams.backend });
  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
      persistenceProvider: deps?.persistenceProvider,
    }));
  log.debug("tasks.status.get created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  return await taskService.getTaskStatus(validParams.taskId);
}

export async function setTaskStatusFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  const validParams = taskStatusSetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.status.set params", { backend: validParams.backend });
  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
      persistenceProvider: deps?.persistenceProvider,
    }));
  log.debug("tasks.status.set created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  await taskService.setTaskStatus(validParams.taskId, validParams.status);
  return { success: true, taskId: validParams.taskId, status: validParams.status };
}

export async function updateTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  const workspacePath = process.cwd();
  log.debug("tasks.update params", { backend: params.backend });
  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: params.backend as string | undefined,
      persistenceProvider: deps?.persistenceProvider,
    }));
  log.debug("tasks.update created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === params.backend)?.name || "default",
  });

  // Prepare updates object
  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) {
    updates.title = params.title;
  }
  if (params.spec !== undefined) {
    updates.spec = params.spec;
  }

  const updatedTask = await taskService.updateTask?.(params.taskId as string, updates);
  return updatedTask;
}

export async function createTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to createTaskFromTitleAndSpec — specPath concept has been removed
  return createTaskFromTitleAndSpec(params, deps);
}

export async function createTaskFromTitleAndSpec(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Parse using the existing schema (which may still use "description")
  const validParams = taskCreateParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.createTitleSpec params", { backend: validParams.backend });

  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
      persistenceProvider: deps?.persistenceProvider,
    }));

  log.debug("tasks.createTitleSpec created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  // Use spec field, fallback to description for compatibility
  const spec = validParams.spec || validParams.description || "";
  const title = validParams.title || "";
  return await taskService.createTaskFromTitleAndSpec(title, spec, {
    ...validParams,
    tags: validParams.tags,
  });
}

export async function deleteTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  const validParams = taskDeleteParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.delete params", { backend: validParams.backend });
  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
      persistenceProvider: deps?.persistenceProvider,
    }));
  log.debug("tasks.delete created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  const success = await taskService.deleteTask(validParams.taskId, validParams);
  return { success, taskId: validParams.taskId };
}

export async function getTaskSpecContentFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  const validParams = taskSpecContentParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.spec params", { backend: validParams.backend });

  const taskService =
    deps?.taskService ??
    (await createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
      persistenceProvider: deps?.persistenceProvider,
    }));
  log.debug("tasks.spec created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  return await taskService.getTaskSpecContent(validParams.taskId);
}
