/**
 * Task Query Commands
 *
 * Interface-agnostic read operations: list, get, getStatus, getSpecContent.
 */

import { z } from "zod";
import { getErrorMessage, ValidationError, ResourceNotFoundError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import {
  createConfiguredTaskService as createConfiguredTaskServiceImpl,
  TaskServiceOptions,
  TaskServiceInterface,
} from "../taskService";
import type { Task } from "../types";
import { first } from "../../../utils/array-safety";
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
import { resolveRepoPath, normalizeTaskIdInput } from "./shared-helpers";
import type { BasePersistenceProvider } from "../../persistence/types";

function requirePersistence(
  provider: BasePersistenceProvider | undefined
): BasePersistenceProvider {
  if (!provider) {
    throw new Error(
      "persistenceProvider is required when taskService is not injected. " +
        "Provide one of: deps.taskService or deps.persistenceProvider."
    );
  }
  return provider;
}

/**
 * Factory signature for the test-injection seam. Persistence is NOT required
 * here because test mocks don't use it — they return pre-built mock services.
 * The real `createConfiguredTaskServiceImpl` requires persistence and is called
 * directly on the production path with `requirePersistence(deps?.persistenceProvider)`.
 */
type InjectedTaskServiceFactory = (
  options: Omit<TaskServiceOptions, "persistenceProvider">
) => Promise<TaskServiceInterface>;

/**
 * List tasks with given parameters
 * @param params Parameters for listing tasks
 * @param deps Optional dependencies for testing
 * @returns Array of tasks
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: {
    taskService?: TaskServiceInterface;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task[]> {
  try {
    // Validate params with Zod schema
    const validParams = taskListParamsSchema.parse(params);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      // Prefer injected main workspace path for tests; otherwise resolve from repo
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await resolveRepoPath({
          session: validParams.session,
          repo: validParams.repo,
        }));

      taskService = deps?.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps?.persistenceProvider),
          });
    }

    // Get tasks with filters - delegate filtering to domain layer
    let tasks = await taskService.listTasks({
      status: validParams.status,
      all: validParams.all,
    });
    // Apply limit client-side if provided
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
 * Get a task by ID with given parameters
 * @param params Parameters for getting a task
 * @param deps Optional dependencies for testing
 * @returns Task object
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps?: {
    taskService?: TaskServiceInterface;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<Task> {
  const startTime = Date.now();
  log.debug("[getTaskFromParams] Starting execution", { params });

  try {
    // Handle taskId as either string or string array and normalize
    const taskIdInput = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
    log.debug("[getTaskFromParams] Processed taskId input", { taskIdInput });

    if (!taskIdInput) {
      throw new ValidationError("Task ID is required");
    }

    const qualifiedTaskId = normalizeTaskIdInput(taskIdInput);
    log.debug("[getTaskFromParams] Using taskId", { taskId: qualifiedTaskId });

    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    log.debug("[getTaskFromParams] About to validate params with Zod");
    const validParams = taskGetParamsSchema.parse(paramsWithQualifiedId);
    log.debug("[getTaskFromParams] Params validated", { validParams });

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath = await (deps?.resolveMainWorkspacePath
        ? deps.resolveMainWorkspacePath()
        : resolveRepoPath({ session: validParams.session, repo: validParams.repo }));
      log.debug("[getTaskFromParams] Using workspace path", { workspacePath });

      log.debug("[getTaskFromParams] About to create task service");
      taskService = deps?.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps?.persistenceProvider),
          });
    }
    log.debug("[getTaskFromParams] Task service created");

    // Get the task
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
 * Get task status using the provided parameters
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps?: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
    resolveMainWorkspacePath?: () => Promise<string>;
  }
): Promise<string> {
  try {
    // Normalize taskId before validation
    const qualifiedTaskId = normalizeTaskIdInput(params.taskId);
    const paramsWithQualifiedId = { ...params, taskId: qualifiedTaskId };

    // Validate params with Zod schema
    const validParams = taskStatusGetParamsSchema.parse(paramsWithQualifiedId);

    // Use DI-provided taskService when available
    let taskService = deps?.taskService;
    if (!taskService) {
      const workspacePath =
        (await deps?.resolveMainWorkspacePath?.()) ??
        (await (deps?.resolveRepoPath || resolveRepoPath)({
          session: validParams.session,
          repo: validParams.repo,
        }));

      taskService = deps?.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps?.persistenceProvider),
          });
    }

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
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}

/**
 * Get task specification content using the provided parameters
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps: {
    taskService?: TaskServiceInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createConfiguredTaskService?: InjectedTaskServiceFactory;
    persistenceProvider?: BasePersistenceProvider;
  } = {
    resolveRepoPath,
  }
): Promise<{ task: Task; specPath: string; content: string; section?: string }> {
  try {
    // Validate params with Zod schema
    const validParams = taskSpecContentParamsSchema.parse(params);

    // Normalize task ID
    const taskIdString = Array.isArray(validParams.taskId)
      ? validParams.taskId[0]
      : validParams.taskId;
    const taskId = taskIdString;

    // Use DI-provided taskService when available
    let taskService = deps.taskService;
    if (!taskService) {
      const resolveRepo = deps.resolveRepoPath || resolveRepoPath;
      const workspacePath = await resolveRepo({
        session: validParams.session,
        repo: validParams.repo,
      });

      taskService = deps.createConfiguredTaskService
        ? await deps.createConfiguredTaskService({
            workspacePath,
            backend: validParams.backend,
          })
        : await createConfiguredTaskServiceImpl({
            workspacePath,
            backend: validParams.backend,
            persistenceProvider: requirePersistence(deps.persistenceProvider),
          });
    }

    // Delegate to service which reads spec content from the backend
    const result = await taskService.getTaskSpecContent(taskId, validParams.section);

    // If a specific section is requested, extract it
    let sectionContent = result.content;
    if (validParams.section && result.content) {
      const section = validParams.section;
      const lines = result.content.toString().split("\n");
      const sectionStart = lines.findIndex((line) =>
        line.toLowerCase().startsWith(`## ${section.toLowerCase()}`)
      );

      if (sectionStart !== -1) {
        let sectionEnd = lines.length;
        for (let i = sectionStart + 1; i < lines.length; i++) {
          if (lines[i]?.startsWith("## ")) {
            sectionEnd = i;
            break;
          }
        }
        sectionContent = lines.slice(sectionStart, sectionEnd).join("\n").trim();
      }
    }

    return {
      task: result.task,
      specPath: result.specPath,
      content: sectionContent,
      section: validParams.section,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Invalid parameters for getting task specification",
        z.treeifyError(error),
        error
      );
    }
    throw error;
  }
}
