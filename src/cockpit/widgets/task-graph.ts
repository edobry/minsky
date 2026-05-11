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
import { formatTaskIdForDisplay } from "../../domain/tasks/task-id-utils";
import type { TaskServiceInterface } from "../../domain/tasks/taskService";
import type { TaskGraphService } from "../../domain/tasks/task-graph-service";

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

    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { taskService, taskGraphService } = await getDeps();

        // Fetch all tasks (no limit — we want the full graph)
        const tasks = await taskService.listTasks({});

        // Build a map from task ID → task for quick status lookup
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        // Fetch all dependency edges in one bulk query
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
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `task_graph error: ${message}` };
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
// Uses lazily-initialised singletons so the cockpit server can register
// this without a DI container. The same bootstrap pattern as agents.ts:
// `new PersistenceService() + .initialize() + getProvider()`.
// ---------------------------------------------------------------------------

let _cachedDeps: TaskGraphDeps | null = null;

async function defaultDepsFactory(): Promise<TaskGraphDeps> {
  if (_cachedDeps) {
    return _cachedDeps;
  }

  const { PersistenceService } = await import("../../domain/persistence/service");
  const { createConfiguredTaskService } = await import("../../domain/tasks/taskService");
  const { TaskGraphService } = await import("../../domain/tasks/task-graph-service");

  const svc = new PersistenceService();
  await svc.initialize();
  const provider = svc.getProvider();

  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: provider,
  });

  // TaskGraphService needs a raw Drizzle DB connection
  const sqlProvider =
    provider as import("../../domain/persistence/types").SqlCapablePersistenceProvider;
  const db = await sqlProvider.getDatabaseConnection();
  const taskGraphService = new TaskGraphService(
    db as import("drizzle-orm/postgres-js").PostgresJsDatabase
  );

  _cachedDeps = { taskService, taskGraphService };
  return _cachedDeps;
}

/** Default task-graph widget — ready to drop into WIDGET_REGISTRY */
export const taskGraphWidget: WidgetModule = createTaskGraphWidget(defaultDepsFactory);
