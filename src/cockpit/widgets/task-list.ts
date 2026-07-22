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
        const { taskService, getDb } = await getDeps();
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
        const tasks = await taskService.listTasks({ projectScope });

        const items: TaskListItem[] = tasks.map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title,
          status: (t.status ?? "TODO").toUpperCase(),
          kind: t.kind ?? "implementation",
          tags: t.tags ?? [],
          parentId: t.parentTaskId ? formatTaskIdForDisplay(t.parentTaskId) : null,
        }));

        const payload: TaskListPayload = { tasks: items };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `task_list error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget — lazy singleton
// ---------------------------------------------------------------------------

let _cachedDeps: TaskListDeps | null = null;

async function defaultDepsFactory(): Promise<TaskListDeps> {
  if (_cachedDeps) return _cachedDeps;

  const { getSharedPersistenceService } = await import("../shared-persistence");
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: provider,
  });

  _cachedDeps = { taskService };
  return _cachedDeps;
}

export const taskListWidget: WidgetModule = createTaskListWidget(defaultDepsFactory);
