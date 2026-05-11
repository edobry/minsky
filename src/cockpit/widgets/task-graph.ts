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

/** A directed dependency edge */
export interface GraphEdge {
  /** Unique edge identifier */
  id: string;
  /** Upstream task ID (the dependency) */
  source: string;
  /** Downstream task ID (the dependent) */
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

        // Build the set of task IDs that appear in edges (to include tasks
        // that may not be in the listTasks result if they're referenced by deps)
        const edgeTaskIds = new Set<string>();
        for (const rel of relationships) {
          edgeTaskIds.add(rel.fromTaskId);
          edgeTaskIds.add(rel.toTaskId);
        }

        // Build nodes: include every task from listTasks, plus any task
        // referenced in edges that wasn't in the list
        const nodeIds = new Set<string>(tasks.map((t) => t.id));
        for (const id of edgeTaskIds) {
          nodeIds.add(id);
        }

        const nodes: GraphNode[] = [];
        for (const id of nodeIds) {
          const task = taskMap.get(id);
          const displayId = formatTaskIdForDisplay(id);
          const rawStatus = task?.status ?? "TODO";
          // Normalise status to the union type — unknown values fall back to TODO
          const status = normaliseStatus(rawStatus);
          const label = task?.title ? `${displayId}: ${task.title}` : displayId;
          nodes.push({ id, label, status });
        }

        // Build edges: one per "depends" relationship
        const edges: GraphEdge[] = relationships.map((rel) => ({
          id: `${rel.fromTaskId}->${rel.toTaskId}`,
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
