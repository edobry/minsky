/**
 * Task List widget (mt#2078)
 *
 * Flat list of all tasks with ID, title, status, kind, tags, and parent.
 * Complements the TaskGraph DAG view — optimised for scanning, searching,
 * and bulk triage rather than dependency visualisation.
 *
 * Same bootstrap pattern as task-graph.ts: factory + lazy singleton deps.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";
import { describeWidgetDegradedReason } from "../db-providers";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Public shapes — mirrored in TaskList.tsx (no server imports on frontend)
// ---------------------------------------------------------------------------

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  tags: string[];
  parentId: string | null;
  /**
   * Owning project's SLUG (mt#4729 SC1 — "a project identifier: slug or
   * displayName", not the internal uuid FK), or null for a
   * legacy/unscoped row. Resolved server-side from `tasksTable.projectId`
   * via ONE `listProjects()` lookup per fetch (not per task, and skipped
   * entirely when no task in the result carries a projectId) — see
   * `resolveProjectSlugMap` below. The all-projects view further resolves
   * this slug against the shell's `/api/projects` list (already fetched by
   * `ProjectProvider`) to prefer a `displayName` when one is set.
   */
  project: string | null;
}

export interface TaskListPayload {
  tasks: TaskListItem[];
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TaskListDeps {
  taskService: TaskServiceInterface;
  /**
   * Optional test seam (mt#3016): overrides `resolveCockpitProjectScope`'s
   * own db-fetch. Production callers never set this — the default factory
   * omits it, so `resolveCockpitProjectScope` falls back to its own
   * `defaultGetDb` (the real `getContextInspectorDb()` singleton), exactly
   * matching pre-mt#3016 behavior.
   *
   * Exists because the widget's own unit tests previously relied on
   * `getContextInspectorDb()` resolving to `null` as an AMBIENT property of
   * the test environment (no live SQL persistence provider configured) —
   * an assumption that is NOT actually guaranteed: `getContextInspectorDb`
   * is a module-level singleton shared across every test file that runs in
   * the same `bun test` process, and its result depends on whatever OTHER
   * test happened to initialize `@minsky/domain/configuration`'s own
   * (equally global, equally un-reset) provider singleton first. Confirmed
   * empirically: `packages/domain/src/session-auto-task-creation.test.ts`'s
   * `beforeEach` calls `initializeConfiguration()`, which (independent of
   * the `workingDirectory` override it passes) still merges in the real
   * user-level `~/.config/minsky/config.yaml` — in an environment where that
   * file names a live Postgres connection string, this unlocks
   * `getContextInspectorDb()` to resolve a REAL, non-null db for the rest of
   * that process, breaking any later widget test's "no live db" assumption
   * whenever that file lands in the same shard/process ahead of this one.
   * Explicitly injecting `getDb: async () => null` removes the dependency on
   * that ambient, cross-file, load-order-sensitive state entirely.
   */
  getDb?: () => Promise<ScopeResolverDb | null>;
  /**
   * Optional test seam (mt#4729): overrides the projects-list lookup used
   * to resolve each task's `projectId` (uuid FK) to its `slug` for the
   * payload (see `TaskListItem.project`). Production callers never set
   * this — the default factory omits it, so `resolveProjectSlugMap` falls
   * back to `defaultListProjects` (the real `getContextInspectorDb()` +
   * `@minsky/domain/project/projects-repository`'s `listProjects`).
   */
  listProjects?: () => Promise<Array<{ id: string; slug: string }>>;
}

// ---------------------------------------------------------------------------
// Project-slug resolution (mt#4729 SC1)
// ---------------------------------------------------------------------------

/**
 * Default `listProjects` implementation — reaches the same
 * `getContextInspectorDb()` singleton `resolveCockpitProjectScope`'s own
 * `defaultGetDb` uses (see `TaskListDeps.getDb`'s doc comment), and the
 * real domain `listProjects` reader. A `null` db (no SQL-capable
 * persistence provider configured) resolves to an empty list, which
 * `resolveProjectSlugMap` below treats identically to any other lookup
 * failure — fail-open, never a widget-down error.
 */
async function defaultListProjects(): Promise<Array<{ id: string; slug: string }>> {
  const { getContextInspectorDb } = await import("../db-providers");
  const db = await getContextInspectorDb();
  if (!db) return [];
  const { listProjects } = await import("@minsky/domain/project/projects-repository");
  // getContextInspectorDb's return type is a narrower SQL-capability probe
  // shape; the real object is a full drizzle db satisfying
  // ProjectsRepositoryDb's select().from().orderBy() chain (same cast
  // pattern scope-resolver.ts documents for this same singleton).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return listProjects(db as any);
}

/**
 * Resolve a task's `projectId` (uuid FK) to its `slug`, via ONE lookup for
 * the whole fetch rather than per task. Fully fail-open (mirrors
 * `resolveCockpitProjectScope`'s contract, PR #2056 R1): any failure —
 * `listProjectsFn` throwing, a dynamic-import failure — degrades to an
 * empty map (every row's `project` becomes null) rather than taking the
 * widget down.
 */
async function resolveProjectSlugMap(
  listProjectsFn: () => Promise<Array<{ id: string; slug: string }>>
): Promise<Map<string, string>> {
  try {
    const rows = await listProjectsFn();
    return new Map(rows.map((r) => [r.id, r.slug]));
  } catch (err) {
    log.warn(
      `[cockpit] project-slug lookup failed for task-list; every row's project will read null ` +
        `(a lookup failure must never take a widget down)`,
      { error: err instanceof Error ? err.message : String(err) }
    );
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskListWidget(getDeps: () => Promise<TaskListDeps>): WidgetModule {
  return {
    id: "task-list",
    title: "Task List",
    updateMode: { type: "polling", intervalMs: 10_000 },

    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { taskService, getDb, listProjects } = await getDeps();
        // Project scope (mt#2418): ?project=<slug> resolved to a project
        // uuid, defaulting to ALL_PROJECTS when omitted/"all" — same
        // resolution rules as every other cockpit project-scoped read.
        // resolveCockpitProjectScope owns its own db-fetch and never throws
        // (fail-open to ALL_PROJECTS on any resolution failure — PR #2056 R1)
        // so a scoping problem can never take this widget down. `getDb` is
        // the mt#3016 test seam (see TaskListDeps) — undefined in
        // production, so resolveCockpitProjectScope falls back to its own
        // defaultGetDb (the real getContextInspectorDb() singleton).
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, { getDb });
        // Terminal statuses on demand (mt#4774). `listTasks` hides DONE/CLOSED
        // by default (`shouldIncludeTaskStatus`, packages/domain/src/tasks/
        // task-filters.ts) and this widget passed neither `status` nor `all`,
        // so the /tasks page's DONE and CLOSED filter buttons narrowed a set
        // that could never contain a match — a control that reads as "there
        // are no DONE tasks".
        //
        // Kept OPT-IN rather than flipped to always-on: measured on prod
        // 2026-08-31, terminal is 3,719 rows (DONE 3,279 + CLOSED 440) against
        // 984 active, so an unconditional `all` would carry ~4.8x the payload
        // on every 10s poll for a view that is about active work by default.
        // The page sets this flag only while a terminal status is selected.
        const includeTerminal = ctx.query?.includeTerminal === "true";
        const tasks = await taskService.listTasks(
          includeTerminal ? { projectScope, all: true } : { projectScope }
        );

        // mt#4729 SC1: resolve each task's projectId (uuid FK) to its slug —
        // one lookup for the whole fetch, and skipped entirely when no task
        // in the result carries a projectId (the common single-project or
        // legacy-row case costs nothing extra).
        const needsProjectLookup = tasks.some((t) => t.projectId);
        const projectSlugById = needsProjectLookup
          ? await resolveProjectSlugMap(listProjects ?? defaultListProjects)
          : new Map<string, string>();

        const items: TaskListItem[] = tasks.map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title,
          status: (t.status ?? "TODO").toUpperCase(),
          kind: t.kind ?? "implementation",
          tags: t.tags ?? [],
          parentId: t.parentTaskId ? formatTaskIdForDisplay(t.parentTaskId) : null,
          project: t.projectId ? (projectSlugById.get(t.projectId) ?? null) : null,
        }));

        const payload: TaskListPayload = { tasks: items };
        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("task_list", err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget — lazy singleton
// ---------------------------------------------------------------------------

/**
 * Deps cached per persistence epoch (mt#3721).
 *
 * `taskService` closes over the provider it was built from, so a pool recycle
 * (`recycleSharedPersistence`, mt#3638) leaves it querying a torn-down pool —
 * which postgres-js rejects forever, since `CONNECTION_ENDED` is raised off an
 * `ending` flag nothing clears. Before mt#3721 this cache had no epoch check
 * and this widget served `degraded` indefinitely after a recycle that had
 * already restored the pool.
 */
const defaultDepsFactory = createEpochKeyedCache(async (): Promise<TaskListDeps> => {
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: provider,
  });

  return { taskService };
});

export const taskListWidget: WidgetModule = createTaskListWidget(defaultDepsFactory);
