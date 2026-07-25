/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks.
 *
 * This is a thin facade that re-exports types from sub-modules and provides
 * parameter-validated command functions used by CLI/MCP adapters.
 *
 * `tasks/index.ts` re-exports THIS file's command functions, and
 * `@minsky/domain/tasks` — the import the CLI/MCP `tasks_list`/`tasks_status_set`
 * commands use — resolves to `tasks/index.ts`. `listTasksFromParams` and
 * `setTaskStatusFromParams` below delegate to the canonical implementations in
 * `tasks/commands/query-commands.ts` and `tasks/commands/mutation-commands.ts`
 * respectively (mt#2704 precedent for status-set; mt#2783 consolidated
 * listTasksFromParams the same way — see those files' headers), so the
 * `taskCommands.ts` barrel and this facade now terminate at the same function
 * bodies instead of each holding an independent, divergently-tested copy.
 */

import { log } from "@minsky/shared/logger";
import { createConfiguredTaskService } from "./tasks/taskService";
import { ResourceNotFoundError } from "./errors/index";
import { first } from "@minsky/shared/array-safety";
import {
  taskGetParamsSchema,
  taskCreateParamsSchema,
  taskDeleteParamsSchema,
  taskStatusSetParamsSchema,
  taskStatusGetParamsSchema,
  type TaskListParams,
  type TaskSpecContentParams,
} from "./schemas/tasks";
import type { PersistenceProvider } from "./persistence/types";
import type { TaskServiceInterface } from "./tasks/taskService";
import type { TaskGraphService } from "./tasks/task-graph-service";
import { setTaskStatusFromParams as setTaskStatusValidated } from "./tasks/commands/mutation-commands";
import {
  listTasksFromParams as listTasksValidated,
  getTaskSpecContentFromParams as getTaskSpecContentValidated,
} from "./tasks/commands/query-commands";
import { assertKnownKind } from "./tasks/workflows";

// ---- Dependency injection types ----

export interface TaskServiceDeps {
  persistenceProvider?: PersistenceProvider;
  taskService?: TaskServiceInterface;
  /**
   * Enables the children-completeness closeout guard: the any-kind
   * parent-DONE guard (mt#1649; absorbed mt#2606's umbrella guard per mt#2311).
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
  // Delegates to the canonical implementation in tasks/commands/query-commands.ts
  // (mt#2783), which resolves ADR-021 project scope (mt#2416) and forwards
  // status/kind/tags/projectScope filters to taskService.listTasks. This facade
  // only exists so the CLI/MCP resolution path (@minsky/domain/tasks →
  // tasks/index.ts → this file) and the taskCommands.ts barrel terminate at the
  // same function body.
  return listTasksValidated(params as TaskListParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
  });
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

  // Kind governance (mt#3010): reject an unknown kind loudly at create time
  // rather than letting it write to the (unconstrained-text) kind column and
  // silently fall back to "implementation" at getWorkflow() time. Defense in
  // depth alongside the adapter-level TaskParameters.kind enum (a direct
  // domain caller that bypasses the adapter schema still gets this check).
  assertKnownKind(validParams.kind);

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
  // Delegates to the canonical implementation in tasks/commands/query-commands.ts
  // (mt#3194), which forwards `section` to taskService.getTaskSpecContent AND
  // extracts the matching `## <section>` heading range from the returned spec
  // body. Before this delegation, this facade called
  // `taskService.getTaskSpecContent(validParams.taskId)` with a SINGLE argument
  // and never forwarded `validParams.section` — so `tasks spec --section` /
  // `tasks_spec_get section:` silently ignored the filter and returned the
  // whole spec on the live CLI/MCP path (`@minsky/domain/tasks` →
  // `tasks/index.ts` → this file), even though the extraction logic already
  // existed and was tested on the `query-commands.ts` copy. See this file's
  // header for the mt#2783/mt#2704 delegation precedent this follows.
  return getTaskSpecContentValidated(params as TaskSpecContentParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    // Preserve this facade's pre-mt#3194 workspace resolution when no
    // taskService is injected: the old body always used `process.cwd()`
    // unconditionally (matching every other command function in this file —
    // getTaskFromParams, getTaskStatusFromParams, etc. — none of which
    // resolve `session`/`repo` either). Without this override, the
    // delegate's default resolver (tasks/commands/shared-helpers.ts's
    // resolveRepoPath) throws when a `session` param is present and no
    // sessionProvider is supplied, which none of this facade's callers pass.
    // Wiring true session-aware resolution here is out of this narrow bug
    // fix's scope (mt#3194 is scoped to the section-forwarding fix); see
    // mt#3190 for the broader tasks.ts/query-commands.ts consolidation that
    // would be the right place to add it.
    resolveRepoPath: async () => process.cwd(),
  });
}
