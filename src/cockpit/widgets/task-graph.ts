/**
 * Task Graph widget (mt#1146)
 *
 * Interactive DAG of the Minsky task graph. Each node carries the task ID,
 * title, and status; edges are dependency relationships. The frontend
 * renders the graph with react-flow.
 *
 * The widget is constructed via createTaskGraphWidget(), which accepts a
 * getTaskGraphDeps async factory so the cockpit server can inject the real
 * persistence-backed services while tests inject lightweight doubles.
 *
 * The default export `taskGraphWidget` uses lazily-initialised singletons for
 * production use (no DI container needed) — same bootstrap pattern as agents.ts.
 *
 * Extension points:
 *   TODO(mt#442): When routing overlay ships, augment nodes with availability
 *     flags from `tasks route` output.
 *   TODO(mt#240): When task-type color coding ships, augment nodes with type
 *     classification for additive overlay.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { describeWidgetDegradedReason } from "../db-providers";

// ---------------------------------------------------------------------------
// Public shapes — mirrored verbatim in TaskGraph.tsx (no server imports
// allowed on the frontend). Keep in sync.
// ---------------------------------------------------------------------------

/** A single node in the task graph */
export interface GraphNode {
  id: string;
  label: string;
  status:
    | "TODO"
    | "READY"
    | "IN-PROGRESS"
    | "IN-REVIEW"
    | "DONE"
    | "BLOCKED"
    | "CLOSED"
    | "PLANNING";
}

/**
 * A directed "depends" edge from `source` (the dependent) to `target` (the
 * dependency). Mirrors `TaskGraphService` semantics: a `depends` relationship
 * has `fromTaskId` (the task that has a dependency, i.e. dependent) →
 * `toTaskId` (the task that is depended on, i.e. dependency).
 */
export interface GraphEdge {
  /** Unique edge identifier (format: `${relationshipType}:${source}->${target}`) */
  id: string;
  /** Dependent task ID — the task that has this dependency */
  source: string;
  /** Dependency task ID — the task that is depended on */
  target: string;
}

/** Full payload returned by this widget when state === "ok" */
export interface TaskGraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Deps type injected by the factory
// ---------------------------------------------------------------------------

export interface TaskGraphDeps {
  taskService: TaskServiceInterface;
  taskGraphService: TaskGraphService;
  /**
   * Optional test seam (mt#4727, mirrors task-list.ts's mt#3016 seam):
   * overrides `resolveCockpitProjectScope`'s own db-fetch. Production
   * callers never set this — the default factory omits it, so
   * `resolveCockpitProjectScope` falls back to its own `defaultGetDb` (the
   * real `getContextInspectorDb()` singleton).
   */
  getDb?: () => Promise<ScopeResolverDb | null>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: returns a WidgetModule backed by the given dep provider factory.
 *
 * @param getDeps  Async factory that returns { taskService, taskGraphService }.
 *   Called on each fetch() so callers can lazily initialise the services.
 *   If the call throws, fetch() catches and returns a degraded state.
 *
 * @example
 *   // Production use (cockpit default):
 *   export const taskGraphWidget = createTaskGraphWidget(defaultDepsFactory);
 *
 *   // Test use:
 *   const widget = createTaskGraphWidget(async () => ({ taskService: mockSvc, taskGraphService: mockGraphSvc }));
 */
export function createTaskGraphWidget(getDeps: () => Promise<TaskGraphDeps>): WidgetModule {
  return {
    id: "task-graph",
    title: "Task Graph",
    // 10s polling: the graph can be ~1K nodes; 5s is too aggressive for a heavy render
    updateMode: { type: "polling", intervalMs: 10_000 },

    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { taskService, taskGraphService, getDb } = await getDeps();

        // Project scope (mt#4727): ?project=<slug> resolved to a project
        // uuid, defaulting to ALL_PROJECTS when omitted/"all" — same
        // resolution rules as every other cockpit project-scoped read
        // (mt#2418 pattern, task-list.ts:91-93). resolveCockpitProjectScope
        // owns its own db-fetch and never throws (fail-open to ALL_PROJECTS
        // on any resolution failure — PR #2056 R1), so a scoping problem can
        // never take this widget down.
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, { getDb });

        // Fetch all tasks in scope (no limit — we want the full graph)
        const tasks = await taskService.listTasks({ projectScope });

        // Build a map from task ID → task for quick status lookup
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        // Fetch all dependency edges in one bulk query. Relationships are
        // NOT themselves project-scoped — the orphan filter below (which
        // already existed pre-mt#4727 to drop typo'd/deleted-task edges)
        // does double duty: an edge referencing a task outside the scoped
        // project is absent from `taskMap` and is filtered out the same way
        // an orphaned edge is, so scoping `tasks` alone is sufficient to
        // scope the rendered graph.
        const relationships = await taskGraphService.getAllRelationships("depends");

        // Build nodes ONLY from the authoritative listTasks() result.
        // Relationships that reference task IDs not in listTasks (orphaned
        // edges: typos, deleted tasks, cross-project refs) are filtered out
        // rather than fabricating phantom nodes with default TODO status
        // (PR #1031 R1 reviewer finding — original code silently created
        // phantoms which misled users about ground truth).
        const nodes: GraphNode[] = tasks.map((task) => {
          const displayId = formatTaskIdForDisplay(task.id);
          const status = normaliseStatus(task.status ?? "TODO");
          const label = task.title ? `${displayId}: ${task.title}` : displayId;
          return { id: task.id, label, status };
        });

        // Build edges, filtering out any relationship that references a task
        // not in the authoritative list. Edge IDs include the relationship
        // type as a prefix to prevent collision if/when other types (e.g.,
        // "parent") are added later (PR #1031 R2 reviewer finding).
        const edges: GraphEdge[] = relationships
          .filter((rel) => taskMap.has(rel.fromTaskId) && taskMap.has(rel.toTaskId))
          .map((rel) => ({
            id: `depends:${rel.fromTaskId}->${rel.toTaskId}`,
            source: rel.fromTaskId,
            target: rel.toTaskId,
          }));

        const payload: TaskGraphPayload = { nodes, edges };
        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("task_graph", err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

const KNOWN_STATUSES = new Set([
  "TODO",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
  "PLANNING",
]);

function normaliseStatus(raw: string): GraphNode["status"] {
  const upper = raw.toUpperCase();
  if (KNOWN_STATUSES.has(upper)) {
    return upper as GraphNode["status"];
  }
  return "TODO";
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Uses the cockpit-wide PersistenceService singleton (shared-persistence.ts).
// ---------------------------------------------------------------------------

import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";

/**
 * Deps cached per persistence epoch (mt#3721).
 *
 * Both `taskService` and `taskGraphService` close over the provider (and, for
 * the graph service, the raw Drizzle connection) they were constructed from, so
 * a pool recycle (`recycleSharedPersistence`, mt#3638) leaves them querying a
 * torn-down pool — which postgres-js rejects forever, since `CONNECTION_ENDED`
 * is raised off an `ending` flag nothing clears. Before mt#3721 this cache had
 * no epoch check and this widget served `degraded` indefinitely after a recycle
 * that had already restored the pool.
 */
const defaultDepsFactory = createEpochKeyedCache(async (): Promise<TaskGraphDeps> => {
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
  const { TaskGraphService } = await import("@minsky/domain/tasks/task-graph-service");

  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: provider,
  });

  // TaskGraphService needs a raw Drizzle DB connection
  const sqlProvider =
    provider as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
  const db = await sqlProvider.getDatabaseConnection();
  const taskGraphService = new TaskGraphService(
    db as import("drizzle-orm/postgres-js").PostgresJsDatabase
  );

  return { taskService, taskGraphService };
});

/** Default task-graph widget — ready to drop into WIDGET_REGISTRY */
export const taskGraphWidget: WidgetModule = createTaskGraphWidget(defaultDepsFactory);
