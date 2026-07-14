/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks.
 *
 * This is a thin facade that re-exports types from sub-modules and provides
 * parameter-validated command functions used by CLI/MCP adapters.
 *
 * IMPORTANT (mt#2762 / mt#2783): `tasks/index.ts` re-exports THIS file's
 * `listTasksFromParams` (not `tasks/commands/query-commands.ts`'s function of the
 * same name), and `@minsky/domain/tasks` — the import the actual CLI/MCP
 * `tasks_list` command uses — resolves to `tasks/index.ts`. So a filter added to
 * `tasks_list` must be forwarded HERE, not just in `query-commands.ts` (which is a
 * separate implementation reached only via the `taskCommands.ts` barrel, e.g. by
 * `index-embeddings-command.ts`). mt#2783 tracks consolidating these into one
 * implementation.
 */

import { log } from "@minsky/shared/logger";
import { createConfiguredTaskService } from "./tasks/taskService";
import { ResourceNotFoundError } from "./errors/index";
import { first } from "@minsky/shared/array-safety";
import {
  taskListParamsSchema,
  taskGetParamsSchema,
  taskCreateParamsSchema,
  taskDeleteParamsSchema,
  taskStatusSetParamsSchema,
  taskStatusGetParamsSchema,
  taskSpecContentParamsSchema,
} from "./schemas/tasks";
import type { PersistenceProvider } from "./persistence/types";
import type { TaskServiceInterface } from "./tasks/taskService";
import type { TaskGraphService } from "./tasks/task-graph-service";
import { setTaskStatusFromParams as setTaskStatusValidated } from "./tasks/commands/mutation-commands";
import { ALL_PROJECTS, type ProjectScope } from "./project/scope";
import { resolveProjectIdentity } from "./project/identity";
import { resolveProjectScope } from "./project/scope-resolver";
import { assertKnownKind } from "./tasks/workflows";

// ---- Dependency injection types ----

export interface TaskServiceDeps {
  persistenceProvider?: PersistenceProvider;
  taskService?: TaskServiceInterface;
  /**
   * Enables the children-completeness closeout guards: the umbrella
   * COMPLETED guard (mt#2606) and the any-kind parent-DONE guard (mt#1649).
   */
  taskGraphService?: Pick<TaskGraphService, "listChildren">;
}

function requirePersistence(provider: PersistenceProvider | undefined): PersistenceProvider {
  if (!provider) {
    throw new Error(
      "persistenceProvider is required when taskService is not injected. " +
        "Provide one of: deps.taskService or deps.persistenceProvider."
    );
  }
  return provider;
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

  // Validate kind against the workflow registry up front (mt#2762) — a typo
  // must not slip through to a backend query that silently returns zero rows.
  assertKnownKind(validParams.kind);

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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
    }));

  log.debug("tasks.list created TaskService", {
    backend: taskService.listBackends?.().find((b) => b.prefix === backend)?.name || "default",
  });

  // Resolve project scope (ADR-021, mt#2416)
  // allProjects=true → skip scope filter; otherwise resolve per-process identity
  let projectScope: ProjectScope = ALL_PROJECTS;
  if (!validParams.allProjects) {
    const persistenceProvider = deps?.persistenceProvider;
    try {
      const identity = resolveProjectIdentity({ repoPath: workspacePath });
      if (
        identity.kind === "resolved" &&
        persistenceProvider &&
        "getDatabaseConnection" in persistenceProvider
      ) {
        const sqlProvider =
          persistenceProvider as import("./persistence/types").SqlCapablePersistenceProvider;
        const db = await sqlProvider.getDatabaseConnection?.();
        if (db) {
          projectScope = await resolveProjectScope(identity, db);
        }
      }
    } catch (err) {
      log.debug("[tasks.list] Project scope resolution failed; defaulting to ALL_PROJECTS", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let tasks = await taskService.listTasks({
    status: validParams.status,
    all: validParams.all,
    backend: validParams.backend,
    tags: validParams.tags,
    projectScope,
    kind: validParams.kind,
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
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
  log.debug("tasks.status.set params", { backend: validParams.backend });
  // Delegate to the transition-validating implementation in
  // tasks/commands/mutation-commands.ts: kind-aware validateStatusTransition
  // (mt#1812), READY→DONE closeout-evidence check, the umbrella
  // children-completeness guard (mt#2606), and the any-kind parent-DONE
  // children-completeness guard (mt#1649). This facade previously wrote the
  // status directly, leaving MCP/CLI transitions server-side unvalidated
  // (mt#2704) — the delegation closes that gap for tasks_status_set and
  // tasks_dispatch, which both resolve here via the @minsky/domain/tasks barrel.
  await setTaskStatusValidated(validParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    taskGraphService: deps?.taskGraphService,
  });
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
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
      persistenceProvider: requirePersistence(deps?.persistenceProvider),
    }));
  log.debug("tasks.spec created TaskService", {
    backend:
      taskService.listBackends?.().find((b) => b.prefix === validParams.backend)?.name || "default",
  });
  return await taskService.getTaskSpecContent(validParams.taskId);
}
