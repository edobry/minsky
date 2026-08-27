/**
 * Task operations for the Minsky CLI
 * This file provides all task-related functionality including managing tasks.
 *
 * This is a thin facade that re-exports types from sub-modules and provides
 * parameter-validated command functions used by CLI/MCP adapters.
 *
 * `tasks/index.ts` re-exports THIS file's command functions, and
 * `@minsky/domain/tasks` — the import the CLI/MCP surfaces use — resolves to
 * `tasks/index.ts`. Every command function below (`listTasksFromParams`,
 * `getTaskFromParams`, `getTaskStatusFromParams`, `setTaskStatusFromParams`,
 * `updateTaskFromParams`, `createTaskFromParams`, `createTaskFromTitleAndSpec`,
 * `deleteTaskFromParams`, `getTaskSpecContentFromParams`) delegates to the
 * canonical implementation in `tasks/commands/query-commands.ts` or
 * `tasks/commands/mutation-commands.ts`. Consolidated across three separate
 * tasks, each responsible for exactly the function(s) named: mt#2704
 * (setTaskStatusFromParams), mt#2783 (listTasksFromParams), mt#3194
 * (getTaskSpecContentFromParams — landed and merged BEFORE mt#3190 started),
 * and mt#3190 (all six of the rest: getTaskFromParams, getTaskStatusFromParams,
 * updateTaskFromParams, createTaskFromParams, createTaskFromTitleAndSpec,
 * deleteTaskFromParams). See each function and those files' headers for the
 * specifics. Net effect: the `taskCommands.ts` barrel and this facade now
 * terminate at the same function bodies instead of each holding an
 * independent, divergently-tested copy.
 */

import { log } from "@minsky/shared/logger";
import {
  taskStatusSetParamsSchema,
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskSpecContentParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndSpecParams,
  type TaskDeleteParams,
} from "./schemas/tasks";
import type { PersistenceProvider } from "./persistence/types";
import type { TaskServiceInterface } from "./tasks/taskService";
import type { TaskGraphService } from "./tasks/task-graph-service";
import {
  setTaskStatusFromParams as setTaskStatusValidated,
  updateTaskFromParams as updateTaskFromParamsValidated,
  createTaskFromParams as createTaskFromParamsValidated,
  createTaskFromTitleAndSpec as createTaskFromTitleAndSpecValidated,
  deleteTaskFromParams as deleteTaskFromParamsValidated,
} from "./tasks/commands/mutation-commands";
import {
  listTasksFromParams as listTasksValidated,
  getTaskFromParams as getTaskFromParamsValidated,
  getTaskStatusFromParams as getTaskStatusFromParamsValidated,
  getTaskSpecContentFromParams as getTaskSpecContentValidated,
} from "./tasks/commands/query-commands";

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

// Note: this file no longer constructs a TaskServiceInterface directly (every
// command function below delegates to tasks/commands/{query,mutation}-commands.ts,
// mt#3190) — the "persistenceProvider is required when taskService is not
// injected" guard now lives solely in those files' own `requirePersistence`
// helpers, which is where the actual `createConfiguredTaskService` calls happen.

/**
 * Workspace-path override shared by every delegation below (PR #2326 review
 * fix). None of this facade's callers can supply a sessionProvider (that
 * plumbing doesn't exist on `TaskServiceDeps`), so falling through to
 * `tasks/commands/shared-helpers.ts`'s default `resolveRepoPath` would throw
 * whenever a caller passes `session` without one — the crash mt#3194 first
 * worked around for `getTaskSpecContentFromParams`. The mt#3194/mt#3190
 * override that avoided that throw (`async () => process.cwd()`) went too
 * far: it ignored its arguments entirely, so a caller-supplied `repo` was
 * ALSO silently discarded on every one of these paths, not just create/delete
 * — this fixes that for all of them. `repo` wins when given; `process.cwd()`
 * is the fallback only when neither `repo` nor a resolvable session is
 * available. `session` alone still can't be resolved to a real workspace here
 * (no sessionProvider to resolve it with) — that remains a known, documented
 * gap — but it no longer crashes and no longer tramples `repo`.
 */
export async function resolveRepoOrCwd(options: {
  repo?: string;
  session?: string;
}): Promise<string> {
  return options.repo ?? process.cwd();
}

// ---- Re-exports from sub-modules ----

// Types
export type { TaskBackend } from "./tasks/types";
export type { Task, TaskListOptions, CreateTaskOptions, DeleteTaskOptions } from "./tasks/types";

// Service
export { createConfiguredTaskService } from "./tasks/taskService";
export type { TaskServiceInterface, TaskSpecContentResult } from "./tasks/taskService";

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
  // Delegates to the canonical implementation in tasks/commands/query-commands.ts
  // (mt#3190), which additionally normalizes `taskId` via normalizeTaskIdInput
  // (accepting bare "123"/"#123" forms, not just already-qualified "mt#123")
  // and resolves session/repo via resolveRepoPath when no taskService is
  // injected. Before this delegation, this facade's own body did neither.
  //
  // getTaskFromParams's only override hook is `resolveMainWorkspacePath`
  // (zero-arg — query-commands.ts's deps type has no `resolveRepoPath` field
  // for this function), so unlike the other five delegations below it can't
  // receive `repo`/`session` as call arguments; it closes over this
  // function's own `params` instead. See resolveRepoOrCwd above for the full
  // PR #2326 review-fix rationale.
  return getTaskFromParamsValidated(params as TaskGetParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    resolveMainWorkspacePath: () =>
      resolveRepoOrCwd({
        repo: params.repo as string | undefined,
        session: params.session as string | undefined,
      }),
  });
}

export async function getTaskStatusFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to the canonical implementation in tasks/commands/query-commands.ts
  // (mt#3190), which additionally normalizes `taskId` and wraps a ZodError into
  // a ValidationError (matching this file's other consolidated functions).
  // Uses the `resolveRepoPath` hook (not `resolveMainWorkspacePath`, which this
  // function's deps type also exposes but which is zero-arg and so can never
  // see `repo`/`session`) so resolveRepoOrCwd actually receives them — see
  // resolveRepoOrCwd above for the full PR #2326 review-fix rationale.
  return getTaskStatusFromParamsValidated(params as TaskStatusGetParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    resolveRepoPath: resolveRepoOrCwd,
  });
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
  // mt#4457: `success: true` below is a literal, and it is only honest because
  // `setTaskStatusValidated` now THROWS when the underlying update matched zero
  // records. Before that check this facade reported success for a write that
  // never landed. `recordsAffected` is carried through so callers can assert on
  // the write's actual effect rather than on this constant.
  const outcome = await setTaskStatusValidated(validParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    taskGraphService: deps?.taskGraphService,
  });
  return {
    success: true,
    taskId: validParams.taskId,
    status: validParams.status,
    recordsAffected: outcome.recordsAffected,
  };
}

export async function updateTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to the canonical implementation in
  // tasks/commands/mutation-commands.ts (mt#3190). Before this delegation, the
  // two copies had inverted feature gaps: this facade applied BOTH
  // `params.title` and `params.spec`, while mutation-commands.ts's copy (the
  // one the taskCommands.ts barrel exposed) applied ONLY `params.title` and
  // silently dropped `params.spec` — the opposite-direction instance of the
  // "diverging copies" bug class mt#3194 fixed for getTaskSpecContentFromParams.
  // The spec-drop was fixed in mutation-commands.ts as part of this
  // consolidation (mt#3190 Success Criterion 4) rather than left behind: the
  // live MCP `tasks.spec.patch` / `tasks.spec.search_replace` tools
  // (`src/adapters/mcp/task-edit-tools.ts`) call `updateTaskFromParams` via
  // `@minsky/domain/tasks` with `spec` set on every call, so a silent drop
  // here would have made both tools no-op.
  return updateTaskFromParamsValidated(
    params as {
      taskId: string;
      title?: string;
      spec?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      backend?: string;
    },
    {
      taskService: deps?.taskService,
      persistenceProvider: deps?.persistenceProvider,
      // resolveRepoPath (args-aware), not resolveMainWorkspacePath (zero-arg,
      // can never see repo/session) — see resolveRepoOrCwd above.
      resolveRepoPath: resolveRepoOrCwd,
    }
  );
}

export async function createTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to the canonical implementation in
  // tasks/commands/mutation-commands.ts (mt#3190). No production consumer of
  // this specific function (as opposed to createTaskFromTitleAndSpec below)
  // was found via `@minsky/domain/tasks` or the `taskCommands.ts` barrel
  // during the mt#3190 audit — verified by grep across src/ and packages/ —
  // so this delegation cannot silently change observed production behavior.
  return createTaskFromParamsValidated(params as TaskCreateParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    resolveRepoPath: resolveRepoOrCwd,
  });
}

export async function createTaskFromTitleAndSpec(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to the canonical implementation in
  // tasks/commands/mutation-commands.ts (mt#3190), which validates against
  // taskCreateFromTitleAndSpecParamsSchema (title/spec/force/backend/
  // githubRepo/tags/kind + the common repo/workspace/session/json fields) —
  // a narrower schema than this facade's former taskCreateParamsSchema (which
  // additionally accepted `description` as a deprecated alias for `spec`, and
  // `dependsOn`). Verified safe: every production caller of this function
  // (`crud-commands.ts`'s `tasks.create`, `dispatch-command.ts`'s
  // new-task-mode create) already passes only title/spec/force/backend/
  // repo/workspace/session/githubRepo/tags/kind — none pass `description` or
  // `dependsOn` — so the narrower schema is not a behavior change on any
  // observed path.
  // resolveRepoPath (args-aware), not resolveMainWorkspacePath (zero-arg, can
  // never see repo/session) — see resolveRepoOrCwd above for the full PR
  // #2326 review-fix rationale.
  return createTaskFromTitleAndSpecValidated(params as TaskCreateFromTitleAndSpecParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    resolveRepoPath: resolveRepoOrCwd,
  });
}

export async function deleteTaskFromParams(
  params: Record<string, unknown>,
  deps?: TaskServiceDeps
) {
  // Delegates to the canonical implementation in
  // tasks/commands/mutation-commands.ts (mt#3190), which additionally
  // normalizes `taskId` and wraps a ZodError into a ValidationError. See
  // resolveRepoOrCwd above for the resolveRepoPath override rationale.
  return deleteTaskFromParamsValidated(params as TaskDeleteParams, {
    taskService: deps?.taskService,
    persistenceProvider: deps?.persistenceProvider,
    resolveRepoPath: resolveRepoOrCwd,
  });
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
    // Originally (mt#3194) this was `async () => process.cwd()` unconditionally,
    // to avoid the delegate's default resolver (tasks/commands/shared-helpers.ts's
    // resolveRepoPath) throwing when a `session` param is present and no
    // sessionProvider is supplied — none of this facade's callers pass one.
    // Updated (PR #2326 review fix, mt#3190) to resolveRepoOrCwd, which fixes
    // the same throw WITHOUT also discarding a caller-supplied `repo` — see
    // resolveRepoOrCwd's doc comment above for the full rationale (that fix
    // covers all six mt#3190-consolidated functions; this one predates mt#3190
    // but shares the same override shape, so it's included for consistency).
    // Real session-aware resolution remains unwired — no sessionProvider
    // reaches this facade today; a future task would need to add one to
    // TaskServiceDeps and thread it through every override in this file.
    resolveRepoPath: resolveRepoOrCwd,
  });
}
