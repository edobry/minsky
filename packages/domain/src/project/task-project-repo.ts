/**
 * Resolve the repository a TASK's project names, for the session-start identity
 * chain (mt#4758).
 *
 * ## Why this exists
 *
 * `session_start` derived a session's IDENTITY — `repoUrl`, `repoName`, and
 * (transitively) `project_id` — from `getRepositoryBackendFromConfig()`, which
 * reads the globally-loaded configuration and therefore resolves to whatever
 * repository the MCP server process was booted in. The caller's `repo` argument
 * fed only `cloneSource`. Pass another project's repo and the call SUCCEEDS,
 * producing a session whose files are one repository and whose record is
 * another, with no error and no field in the result showing the disagreement.
 *
 * ## Why the TASK is the right subject
 *
 * ADR-003 §Context separates three concepts that this chain had collapsed:
 * "Repository identity — what project this is", "Clone source — where the
 * session was cloned from", and the PR/collaboration backend. It states the
 * property the bug violates: the repository backend "is a property of the
 * **project**, not of the session or the user." Reading it from config is that
 * ADR working as designed in a world with one project; the defect is that "the
 * config" means the SERVER's project rather than the TASK's.
 *
 * `projects.repo_url` is the canonical home for a project's repo URL — its own
 * schema comment says so, and the "Minsky beyond Minsky" RFC's 2026-06-16
 * amendment (Decision 2) makes `sessions.repo_url` a denormalized copy of that
 * project attribute. So resolving through the task's project row honors both
 * records rather than inventing a third source.
 *
 * ## Shape
 *
 * Same functional-core/imperative-shell split as `scope-resolver.ts`, and for
 * the same reason (mt#4509): the outcomes that reach a fail-open return are NOT
 * all the same event, and collapsing them into one log line is what made that
 * defect cost two months. {@link resolveTaskProjectRepoOutcome} does the IO and
 * returns a value; {@link describeTaskProjectRepo} renders it; and
 * {@link decideSessionIdentity} — the part that actually decides what happens —
 * is pure, so its tests need no db, no spies, and no patched collaborators.
 */

import { eq } from "drizzle-orm";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { projectsTable } from "../storage/schemas/projects-schema";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Narrow DB interface
// ---------------------------------------------------------------------------

/**
 * The one method this module calls. Mirrors `ScopeResolverDb` deliberately —
 * both are handed the same `getDatabaseConnection()` result, and the narrow
 * shape is what lets tests inject a fake without an unsafe cast.
 */
export interface TaskProjectDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
}

/**
 * Does `value` carry the method this module calls?
 *
 * The guard exists for the reason `isScopeResolverDb` does: every call site
 * acquires its handle as `Promise<unknown>` and asserts it with a cast, and a
 * cast asserts a capability rather than checking one. An object rest-spread over
 * a drizzle handle drops `select` (it lives on the prototype), which is the
 * mt#4509 shape.
 */
export function isTaskProjectDb(value: unknown): value is TaskProjectDb {
  return typeof (value as TaskProjectDb | null | undefined)?.select === "function";
}

// ---------------------------------------------------------------------------
// Outcome model (functional core)
// ---------------------------------------------------------------------------

/** The project a task belongs to, once resolved to a usable repository. */
export interface TaskProject {
  projectId: string;
  slug: string;
  repoUrl: string;
}

/**
 * What actually happened during one resolution attempt.
 *
 * Every variant except `resolved` leaves the caller on its previous behavior
 * (config-derived identity). They are separate variants so a reader can tell an
 * expected miss from a broken handle from an outage — the distinction mt#4509
 * establishes is worth preserving in a second resolver rather than re-learning.
 */
export type TaskProjectRepoOutcome =
  /** No task id was supplied (a session started by description or bare id). */
  | { kind: "no-task" }
  /** A db handle that cannot be queried — a programming error, not missing data. */
  | { kind: "invalid-db-handle"; taskId: string; received: string }
  /** No such task row. */
  | { kind: "task-not-found"; taskId: string }
  /** The task exists but carries no `project_id` (nullable until Phase 1.3). */
  | { kind: "task-unscoped"; taskId: string }
  /** The task names a project id with no matching row. */
  | { kind: "project-not-found"; taskId: string; projectId: string }
  /** The project row exists but its `repo_url` is null. */
  | { kind: "no-repo-url"; taskId: string; projectId: string; slug: string }
  /** The query itself failed — infrastructure, not missing data. */
  | { kind: "query-failed"; taskId: string; error: string }
  /** The task's project names a repository. */
  | { kind: "resolved"; taskId: string; project: TaskProject };

/**
 * Look up the repository named by a task's project.
 *
 * Never throws: every failure path is a variant. Two sequential single-table
 * reads rather than a join, so the narrow `select().from().where().limit()`
 * interface stays satisfiable by the same fakes the sibling resolvers use.
 */
export async function resolveTaskProjectRepoOutcome(
  taskId: string | undefined,
  db: unknown
): Promise<TaskProjectRepoOutcome> {
  if (!taskId) return { kind: "no-task" };

  if (!isTaskProjectDb(db)) {
    return { kind: "invalid-db-handle", taskId, received: typeof db };
  }

  try {
    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);

    const taskRow = taskRows[0];
    if (!taskRow) return { kind: "task-not-found", taskId };

    const projectId = taskRow.projectId as string | null | undefined;
    if (!projectId) return { kind: "task-unscoped", taskId };

    const projectRows = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);

    const projectRow = projectRows[0];
    if (!projectRow) return { kind: "project-not-found", taskId, projectId };

    const slug = projectRow.slug as string;
    const repoUrl = projectRow.repoUrl as string | null | undefined;
    if (!repoUrl) return { kind: "no-repo-url", taskId, projectId, slug };

    return { kind: "resolved", taskId, project: { projectId, slug, repoUrl } };
  } catch (err) {
    return {
      kind: "query-failed",
      taskId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A log line: level, message, and structured context. */
export interface TaskProjectRepoLogLine {
  level: "debug" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Render an outcome as a log line.
 *
 * The two genuine failures (a broken handle, a failed query) get levels that
 * distinguish them from the routine misses; everything else is debug, because
 * a task with no project row is the ordinary pre-backfill state and not an
 * event anybody needs to see.
 */
export function describeTaskProjectRepo(
  outcome: TaskProjectRepoOutcome,
  caller: string
): TaskProjectRepoLogLine {
  switch (outcome.kind) {
    case "no-task":
      return {
        level: "debug",
        message: "[task-project-repo] No task id supplied; using config-derived identity",
      };

    case "invalid-db-handle":
      return {
        level: "error",
        message: `[task-project-repo] Invalid db handle from "${caller}": no .select() method; using config-derived identity`,
        context: { caller, taskId: outcome.taskId, received: outcome.received },
      };

    case "task-not-found":
      return {
        level: "debug",
        message: `[task-project-repo] No task row for "${outcome.taskId}"; using config-derived identity`,
      };

    case "task-unscoped":
      return {
        level: "debug",
        message: `[task-project-repo] Task "${outcome.taskId}" carries no project_id; using config-derived identity`,
      };

    case "project-not-found":
      return {
        level: "debug",
        message: `[task-project-repo] Task "${outcome.taskId}" names project "${outcome.projectId}" with no matching row; using config-derived identity`,
      };

    case "no-repo-url":
      return {
        level: "debug",
        message: `[task-project-repo] Project "${outcome.slug}" has no repo_url; using config-derived identity`,
      };

    case "query-failed":
      return {
        level: "warn",
        message: `[task-project-repo] Query failed resolving the project for "${outcome.taskId}" from "${caller}"; using config-derived identity`,
        context: { caller, taskId: outcome.taskId, error: outcome.error },
      };

    case "resolved":
      return {
        level: "debug",
        message: `[task-project-repo] Task "${outcome.taskId}" resolves to project "${outcome.project.slug}" (${outcome.project.repoUrl})`,
      };
  }
}

/**
 * Resolve a task's project repository, logging the outcome.
 *
 * Returns `undefined` on every non-`resolved` outcome, which leaves the caller
 * on its previous config-derived behavior — the fail-open posture ADR-021 chose
 * for an unidentified project, preserved here.
 */
export async function resolveTaskProjectRepo(
  taskId: string | undefined,
  db: unknown,
  caller = "unknown"
): Promise<TaskProject | undefined> {
  const outcome = await resolveTaskProjectRepoOutcome(taskId, db);
  const line = describeTaskProjectRepo(outcome, caller);
  log[line.level](line.message, line.context);
  return outcome.kind === "resolved" ? outcome.project : undefined;
}

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

export interface SessionIdentityInputs {
  /** Identity the server's own configuration names. Today's behavior. */
  configRepoUrl: string;
  /** Identity the task's project names, when one resolved. */
  taskProject?: TaskProject;
  /** The caller's `repo` argument, verbatim, if supplied. */
  explicitRepo?: string;
  /**
   * Slug of `explicitRepo`, derived by the caller (a local path needs a git
   * read, which is IO and does not belong in here). `undefined` when the
   * argument could not be classified — treated as "cannot contradict", so an
   * unclassifiable path never blocks a session.
   */
  explicitRepoSlug?: string;
  /** Slug the config URL names, when derivable. */
  configSlug?: string;
}

export type SessionIdentityDecision =
  /** Keep today's behavior: identity comes from config. */
  | { kind: "config"; repoUrl: string }
  /** Adopt the task's project identity. */
  | { kind: "project"; repoUrl: string; project: TaskProject }
  /** The caller named a repository that contradicts the resolved identity. */
  | { kind: "refuse"; message: string };

/**
 * Decide what a session's IDENTITY should be.
 *
 * Two rules, in order:
 *
 * 1. **Refuse a contradiction.** When the caller passed `repo` and it names a
 *    different repository than the identity we resolved, fail with an error
 *    naming both. This is the half that makes the outcome legible: every
 *    recorded instance of this defect family failed by silently SUCCEEDING, so
 *    the caller has no signal to act on. Refusing is cheap and reversible;
 *    a cross-repo session is neither.
 * 2. **Prefer the task's project.** Otherwise the task's project row wins over
 *    server config, per ADR-003's "property of the project" and the RFC's
 *    canonical-`projects.repo_url` decision. With no project resolved, config
 *    stands — that is the fail-open default and the single-project status quo.
 *
 * An unclassifiable `explicitRepo` (no derivable slug) never refuses. A refusal
 * on "I could not tell" would break every legitimate local-path caller the
 * moment a git read failed, which trades a silent wrong answer for a loud one
 * on the wrong population.
 */
export function decideSessionIdentity(inputs: SessionIdentityInputs): SessionIdentityDecision {
  const { configRepoUrl, taskProject, explicitRepo, explicitRepoSlug, configSlug } = inputs;

  const identityRepoUrl = taskProject?.repoUrl ?? configRepoUrl;
  const identitySlug = taskProject?.slug ?? configSlug;

  if (explicitRepo && explicitRepoSlug && identitySlug && explicitRepoSlug !== identitySlug) {
    const source = taskProject
      ? `the task's project ("${identitySlug}")`
      : `this server's configured repository ("${identitySlug}")`;
    return {
      kind: "refuse",
      message:
        `The repo argument "${explicitRepo}" names repository "${explicitRepoSlug}", ` +
        `but this session's identity resolves to ${source}.\n\n` +
        `A session whose files are one repository and whose record is another cannot push, ` +
        `open a PR, or be listed under the right project (mt#4758).\n\n${
          taskProject
            ? `To work this task, start the session without an explicit repo — its project's ` +
              `repository is used automatically.`
            : `To work in "${explicitRepoSlug}", run from an MCP server rooted there, or bind the ` +
              `task to that project first.`
        }`,
    };
  }

  if (taskProject && taskProject.repoUrl !== configRepoUrl) {
    return { kind: "project", repoUrl: identityRepoUrl, project: taskProject };
  }

  return { kind: "config", repoUrl: configRepoUrl };
}
