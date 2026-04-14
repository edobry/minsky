/**
 * Query command functions for task operations (read-only).
 * Implements the interface-agnostic command architecture for list, get, status, and spec operations.
 */
import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index";
import { readTextFile } from "../../../utils/fs";
import { join } from "path";
import { first } from "../../../utils/array-safety";
import type { Task } from "../types";
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskSpecContentParams,
} from "../../../schemas/tasks";
import {
  resolveRepoPath,
  normalizeTaskIdInput,
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  type TaskServiceOptions,
  type TaskServiceInterface,
} from "./shared";

/**
 * List tasks with given parameters.
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task[]> {
  try {
    const validParams = taskListParamsSchema.parse(params);

    const workspacePath =
      (await deps?.resolveMainWorkspacePath?.()) ??
      (await resolveRepoPath({
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

    let tasks = await taskService.listTasks({
      status: validParams.status,
      all: validParams.all,
    });

    const limit = validParams.limit;
    if (typeof limit === "number" && limit > 0) {
      tasks = tasks.slice(0, limit);
    }
    return tasks;
  } catch (error) {
    log.error(`Error listing tasks: ${getErrorMessage(error)}`);
    throw error;
  }
}

/**
 * Get a task by ID with given parameters.
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps?: {
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  const startTime = Date.now();
  log.debug("[getTaskFromParams] Starting execution", { params });

  try {
    const taskIdInput = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
    log.debug("[getTaskFromParams] Processed taskId input", { taskIdInput });

    if (!taskIdInput) {
      throw new ValidationError("Task ID is required");
    }

    const qualifiedTaskId = normalizeTaskIdInput(taskIdInput);
    log.debug("[getTaskFromParams] Using taskId", { taskId: qualifiedTaskId });

    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    log.debug("[getTaskFromParams] About to validate params with Zod");
    const validParams = taskGetParamsSchema.parse(paramsWithQualifiedId);
    log.debug("[getTaskFromParams] Params validated", { validParams });

    const workspacePath = await (deps?.resolveMainWorkspacePath
      ? deps.resolveMainWorkspacePath()
      : resolveRepoPath({ session: validParams.session, repo: validParams.repo }));
    log.debug("[getTaskFromParams] Using workspace path", { workspacePath });

    log.debug("[getTaskFromParams] About to create task service");
    const createTaskService =
      deps?.createConfiguredTaskService ||
      (async (options) => await createConfiguredTaskServiceImpl(options));

    const taskService = await createTaskService({
      workspacePath,
      backend: validParams.backend,
    });
    log.debug("[getTaskFromParams] Task service created");

    log.debug("[getTaskFromParams] About to get task");
    const taskIdStr = Array.isArray(validParams.taskId)
      ? first(validParams.taskId, "taskId array")
      : validParams.taskId;
    const task = await taskService.getTask(taskIdStr);
    log.debug("[getTaskFromParams] Task retrieved", { taskExists: !!task });

    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskIdStr} not found`, "task", taskIdStr);
    }

    const duration = Date.now() - startTime;
    log.debug("[getTaskFromParams] Execution completed", { duration });
    return task;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error("[getTaskFromParams] Error getting task:", {
      error: getErrorMessage(error),
      duration,
    });
    throw error;
  }
}

/**
 * Get task status using the provided parameters.
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps?: {
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: (options: TaskServiceOptions) => Promise<TaskServiceInterface>;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<string> {
  try {
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    const validParams = taskStatusGetParamsSchema.parse(paramsWithQualifiedId);

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
        error.format(),
        error
      );
    }
    throw error;
  }
}

/**
 * Get task specification content using the provided parameters.
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps: {
    resolveRepoPath: typeof resolveRepoPath;
    createConfiguredTaskService: (
      options: TaskServiceOptions
    ) => TaskServiceInterface | Promise<TaskServiceInterface>;
  } = {
    resolveRepoPath,
    createConfiguredTaskService: async (options) => await createConfiguredTaskServiceImpl(options),
  }
): Promise<{ task: Task; specPath: string; content: string; section?: string }> {
  try {
    const validParams = taskSpecContentParamsSchema.parse(params);

    const taskIdString = Array.isArray(validParams.taskId)
      ? validParams.taskId[0]
      : validParams.taskId;

    const workspacePath = await deps.resolveRepoPath({
      session: validParams.session,
      repo: validParams.repo,
    });

    const taskService = await deps.createConfiguredTaskService({
      workspacePath,
      backend: validParams.backend,
    });

    const task = await taskService.getTask(taskIdString);
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskIdString} not found`, "task", taskIdString);
    }

    const specPath = task.specPath;

    if (!specPath) {
      throw new ResourceNotFoundError(
        `Task ${taskIdString} has no specification file`,
        "task",
        taskIdString
      );
    }

    let content: string;
    try {
      const fullSpecPath = specPath.startsWith("/") ? specPath : join(workspacePath, specPath);
      content = await readTextFile(fullSpecPath);
    } catch {
      throw new ResourceNotFoundError(
        `Could not read specification file at ${specPath}`,
        "file",
        specPath
      );
    }

    let sectionContent = content;
    if (validParams.section) {
      const lines = content.toString().split("\n");
      const sectionStart = lines.findIndex((line) =>
        line.toLowerCase().startsWith(`## ${validParams.section!.toLowerCase()}`)
      );

      if (sectionStart === -1) {
        throw new ResourceNotFoundError(
          `Section "${validParams.section}" not found in task ${taskIdString} specification`
        );
      }

      let sectionEnd = lines.length;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        if (lines[i]?.startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }

      sectionContent = lines.slice(sectionStart, sectionEnd).join("\n").trim();
    }

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
        error.format(),
        error
      );
    }
    throw error;
  }
}
