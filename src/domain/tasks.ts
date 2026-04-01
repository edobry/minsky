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
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskCreateParamsSchema,
  taskDeleteParamsSchema,
  taskStatusSetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
} from "../schemas/tasks";

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

export async function listTasksFromParams(params: any) {
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

  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend,
  });

  log.debug("tasks.list created TaskService", {
    backend: taskService.listBackends!().find((b) => b.prefix === backend)?.name || "default",
  });
  let tasks = await taskService.listTasks({
    status: validParams.status,
    all: validParams.all,
    backend: validParams.backend,
  });
  // Apply limit client-side if provided
  if (typeof validParams.limit === "number" && validParams.limit > 0) {
    tasks = tasks.slice(0, validParams.limit);
  }
  return tasks;
}

export async function getTaskFromParams(params: any) {
  const validParams = taskGetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.get params", { backend: validParams.backend });

  const backend = validParams.backend;

  if (backend) {
    log.debug("tasks.get using CLI backend", { backend });
  } else {
    log.debug("tasks.get using multi-backend mode (no default backend)");
  }

  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend,
  });

  log.debug("tasks.get created TaskService", {
    backend: taskService.listBackends!().find((b) => b.prefix === backend)?.name || "default",
  });
  const taskId = Array.isArray(validParams.taskId) ? validParams.taskId[0]! : validParams.taskId;
  const task = await taskService.getTask(taskId);
  if (!task) {
    throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
  }
  return task;
}

export async function getTaskStatusFromParams(params: any) {
  const validParams = taskStatusGetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.status.get params", { backend: validParams.backend });
  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: validParams.backend,
  });
  log.debug("tasks.status.get created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  return await taskService.getTaskStatus(validParams.taskId);
}

export async function setTaskStatusFromParams(params: any) {
  const validParams = taskStatusSetParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.status.set params", { backend: validParams.backend });
  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: validParams.backend,
  });
  log.debug("tasks.status.set created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  await taskService.setTaskStatus(validParams.taskId, validParams.status);
  return { success: true, taskId: validParams.taskId, status: validParams.status };
}

export async function updateTaskFromParams(params: any) {
  const workspacePath = process.cwd();
  log.debug("tasks.update params", { backend: params.backend });
  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: params.backend,
  });
  log.debug("tasks.update created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === params.backend)?.name || "default",
  });

  // Prepare updates object
  const updates: any = {};
  if (params.title !== undefined) {
    updates.title = params.title;
  }
  if (params.spec !== undefined) {
    updates.spec = params.spec;
  }

  const updatedTask = await (taskService as any).updateTask(params.taskId, updates);
  return updatedTask;
}

export async function createTaskFromParams(params: any) {
  const validParams = taskCreateParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.create params", { backend: validParams.backend });
  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: validParams.backend,
  });
  log.debug("tasks.create created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  return await taskService.createTask(validParams.specPath || "");
}

export async function createTaskFromTitleAndSpec(params: any) {
  // Parse using the existing schema (which may still use "description")
  const validParams = taskCreateParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.createTitleSpec params", { backend: validParams.backend });

  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: validParams.backend,
  });

  log.debug("tasks.createTitleSpec created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  // Use spec field, fallback to description for compatibility
  const spec = (validParams as any).spec || (validParams as any).description || "";
  const title = (validParams as any).title || "";
  return await taskService.createTaskFromTitleAndSpec(title, spec, validParams);
}

export async function deleteTaskFromParams(params: any) {
  const validParams = taskDeleteParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.delete params", { backend: validParams.backend });
  const taskService = await createConfiguredTaskService({
    workspacePath,
    backend: validParams.backend,
  });
  log.debug("tasks.delete created TaskService", {
    backend:
      taskService.listBackends!().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  const success = await taskService.deleteTask(validParams.taskId, validParams);
  return { success, taskId: validParams.taskId };
}

export async function getTaskSpecContentFromParams(params: any) {
  const validParams = taskSpecContentParamsSchema.parse(params);
  const workspacePath = process.cwd();
  log.debug("tasks.spec params", { backend: validParams.backend });

  // Determine backend (prefer CLI param, else config)
  let backend = validParams.backend;
  if (!backend) {
    try {
      const { ConfigurationLoader } = await import("./configuration/loader");
      const configLoader = new ConfigurationLoader();
      const configResult = await configLoader.load();
      if (configResult.config.tasks?.backend) {
        backend = configResult.config.tasks.backend;
        log.debug("tasks.spec backend from configuration", { backend });
      } else if (configResult.config.backend) {
        // Fallback to deprecated root backend property for backward compatibility
        backend = configResult.config.backend as string;
        log.warn("Using deprecated root 'backend' property. Please use 'tasks.backend' instead.", {
          backend,
        });
      }
    } catch (error) {
      log.debug("tasks.spec failed to load configuration", { error });
    }
  }

  const taskService = await createConfiguredTaskService({ workspacePath, backend });
  log.debug("tasks.spec created TaskService", {
    backend: taskService.listBackends!().find((b) => b.prefix === backend)?.name || "default",
  });
  return await taskService.getTaskSpecContent(validParams.taskId);
}
