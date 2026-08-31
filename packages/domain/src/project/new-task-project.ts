/**
 * Which project should a NEWLY CREATED task belong to? (mt#4808)
 *
 * ## Why this exists
 *
 * `tasks_create` stamped `project_id` from the MCP server's own context and from
 * nothing else. A task whose subject belongs to another project filed under the
 * server's, with no error, no warning, and no `projectId` in the result to
 * notice it by. Two causes, both real:
 *
 * 1. The `workspace` parameter was **dead**. It is declared on the command,
 *    accepted at the MCP boundary, forwarded by `createTaskParams` and again by
 *    the create command — and then read by nothing.
 *    `createTaskFromTitleAndSpec` resolved its workspace from `session` and
 *    `repo` only.
 * 2. Even that resolution was skipped whenever a `taskService` was injected,
 *    which the MCP path always does. The injected service is a boot singleton
 *    carrying `process.cwd()`, so a per-call project could not be honored at
 *    all.
 *
 * ## The rule, and where it comes from
 *
 * Entity-derived attribution first, filing context as the fallback — the rule
 * mt#4758 settled for `session_start` and mt#4772 adopts for `asks_create`. The
 * precedence mirrors mt#4724's recorded shape (qualified → explicit → default):
 *
 * 1. **An explicit `workspace` / `repo`** — the caller named a location. This is
 *    the parameter that was dead; honoring it is the reported defect's fix.
 * 2. **The parent task's project** — a subtask belongs where its parent does.
 *    This is the same entity-derived signal `asks_create` takes from
 *    `parentTaskId` (mt#4772).
 * 3. **The filing context** — today's behavior, unchanged, and still correct
 *    for the ordinary same-project case.
 *
 * Explicit beats inherited because an argument the caller passed is an
 * instruction, while a parent's project is an inference; a caller who wants the
 * parent's project simply omits the argument.
 *
 * ## Shape
 *
 * Functional core / imperative shell, matching `task-project-repo.ts` and
 * `scope-resolver.ts`. {@link decideNewTaskProject} is pure — its tests need no
 * db and no patched collaborators — and the IO half never throws, because a
 * project that cannot be resolved must leave the create on today's behavior
 * rather than failing it.
 */

import { eq } from "drizzle-orm";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { log } from "@minsky/shared/logger";
import { isTaskProjectDb, type TaskProjectDb } from "./task-project-repo";

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

/** Where a candidate project id came from. Carried so the log can say. */
export type NewTaskProjectSource = "explicit-location" | "parent-task" | "filing-context";

export interface NewTaskProjectInputs {
  /** Project the caller's explicit `workspace`/`repo` resolved to, if any. */
  explicitLocationProjectId?: string;
  /** Project the `parent` task belongs to, if a parent was given and resolved. */
  parentProjectId?: string;
  /** Project the filing context resolves to — today's behavior. */
  filingContextProjectId?: string;
}

export interface NewTaskProjectDecision {
  /** The project to stamp, or undefined to leave `project_id` NULL. */
  projectId: string | undefined;
  source: NewTaskProjectSource;
}

/**
 * Apply the precedence. Never throws; `undefined` at every level is a legal
 * input and yields `undefined` with source `filing-context`, which is exactly
 * the pre-mt#4808 behavior (stamp whatever the context gave, including NULL).
 */
export function decideNewTaskProject(inputs: NewTaskProjectInputs): NewTaskProjectDecision {
  if (inputs.explicitLocationProjectId) {
    return { projectId: inputs.explicitLocationProjectId, source: "explicit-location" };
  }
  if (inputs.parentProjectId) {
    return { projectId: inputs.parentProjectId, source: "parent-task" };
  }
  return { projectId: inputs.filingContextProjectId, source: "filing-context" };
}

// ---------------------------------------------------------------------------
// The IO half
// ---------------------------------------------------------------------------

/**
 * Which project does a task belong to? Returns `undefined` for every
 * non-resolution — no task id, no db, no row, a null `project_id`, or a failed
 * query. Never throws: a create must not fail because a parent lookup did.
 *
 * Distinct from `task-project-repo.ts`'s `resolveTaskProjectRepo`, which also
 * requires the project to carry a `repo_url` (it exists to answer "which
 * REPOSITORY"). Stamping needs only the id, and a project row with a null
 * `repo_url` is still a perfectly good stamp target.
 */
export async function resolveTaskProjectId(
  taskId: string | undefined,
  db: unknown
): Promise<string | undefined> {
  if (!taskId) return undefined;
  if (!isTaskProjectDb(db)) return undefined;

  try {
    const rows = await (db as TaskProjectDb)
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .limit(1);

    const row = rows[0];
    return (row?.projectId as string | null | undefined) ?? undefined;
  } catch (err) {
    log.debug("[new-task-project] parent project lookup failed; falling back (mt#4808)", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Which project does an explicit `workspace` / `repo` path name?
 *
 * Uses the same `resolveProjectIdentity` → `resolveProjectScope` pair every
 * other project lookup in the codebase uses, so a path resolves here exactly as
 * it would anywhere else. Returns `undefined` on an unidentified path or an
 * `ALL_PROJECTS` scope — both mean "this told us nothing", which must fall
 * through to the next precedence level rather than clearing the stamp.
 */
export async function resolveLocationProjectId(
  location: string | undefined,
  db: unknown
): Promise<string | undefined> {
  if (!location) return undefined;
  if (!isTaskProjectDb(db)) return undefined;

  try {
    const { resolveProjectIdentity } = await import("./identity");
    const { resolveProjectScope } = await import("./scope-resolver");
    const { isAllProjects } = await import("./scope");

    const identity = resolveProjectIdentity({ repoPath: location });
    const scope = await resolveProjectScope(identity, db, "tasks.create");
    return isAllProjects(scope) ? undefined : scope;
  } catch (err) {
    log.debug("[new-task-project] location project lookup failed; falling back (mt#4808)", {
      location,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Resolve the project for a new task, applying the full precedence.
 *
 * Returns `undefined` when nothing resolves — which leaves the backend's
 * construction-time `currentProjectId` in place, i.e. exactly today's behavior.
 * That fail-open posture is ADR-021's and is deliberate: a create must not fail,
 * or silently NULL its project, because a lookup did.
 */
export async function resolveNewTaskProjectId(
  input: { workspace?: string; repo?: string; parentTaskId?: string },
  db: unknown
): Promise<NewTaskProjectDecision> {
  const explicitLocationProjectId = await resolveLocationProjectId(
    input.workspace ?? input.repo,
    db
  );
  // Skip the parent read entirely when an explicit location already won —
  // the decision below would discard it, and this is a DB round trip.
  const parentProjectId = explicitLocationProjectId
    ? undefined
    : await resolveTaskProjectId(input.parentTaskId, db);

  const decision = decideNewTaskProject({ explicitLocationProjectId, parentProjectId });

  if (decision.projectId) {
    log.debug("[new-task-project] resolved project for new task (mt#4808)", {
      projectId: decision.projectId,
      source: decision.source,
    });
  }

  return decision;
}
