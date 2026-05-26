/**
 * Workstreams widget (mt#1452)
 *
 * Rollup view of active workstreams: parent tasks with at least one
 * non-terminal child. Each card shows the parent header, child list with
 * status badges, and active/done/blocked child counts.
 *
 * The widget is constructed via createWorkstreamsWidget(), which accepts a
 * getDeps async factory so the cockpit server can inject the real
 * persistence-backed services while tests inject lightweight doubles.
 *
 * The default export `workstreamsWidget` uses lazily-initialised singletons
 * for production use (no DI container needed) — same bootstrap pattern as
 * task-graph.ts.
 *
 * Extension points:
 *   TODO(mt#1148): When SSE push transport ships, workstreams is the natural
 *     first test bed for the polling → push migration adapter.
 *   TODO(future): Recent-activity feed (commits/PRs) can layer on once
 *     git_log + session_pr_list integration is ready.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { formatTaskIdForDisplay } from "../../domain/tasks/task-id-utils";
import type { TaskServiceInterface } from "../../domain/tasks/taskService";
import type { TaskGraphService } from "../../domain/tasks/task-graph-service";

// ---------------------------------------------------------------------------
// Public shapes — mirrored verbatim in Workstreams.tsx (no server imports
// allowed on the frontend). Keep in sync.
// ---------------------------------------------------------------------------

/** Status union shared with the task-graph widget */
export type TaskStatus =
  | "TODO"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED"
  | "PLANNING";

/** A single child task row within a workstream card */
export interface WorkstreamChild {
  id: string;
  title: string;
  status: TaskStatus;
}

/**
 * A workstream card: one active parent task with its children rolled up.
 * A workstream is "active" when at least one child is in a non-terminal status.
 */
export interface WorkstreamCard {
  /** Qualified parent task ID, e.g. "mt#1143" */
  parentId: string;
  parentTitle: string;
  parentStatus: TaskStatus;
  /** Children sorted by status weight: in-progress → in-review → planning → ready → todo → blocked → done → closed */
  children: WorkstreamChild[];
  /** Count of children in non-terminal status (the "active" definition) */
  activeChildCount: number;
  doneChildCount: number;
  blockedChildCount: number;
}

/** Full payload returned by this widget when state === "ok" */
export interface WorkstreamsPayload {
  workstreams: WorkstreamCard[];
}

// ---------------------------------------------------------------------------
// Deps type injected by the factory
// ---------------------------------------------------------------------------

export interface WorkstreamsDeps {
  taskService: TaskServiceInterface;
  taskGraphService: TaskGraphService;
}

// ---------------------------------------------------------------------------
// Status helpers
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

function normaliseStatus(raw: string): TaskStatus {
  const upper = raw.toUpperCase();
  if (KNOWN_STATUSES.has(upper)) {
    return upper as TaskStatus;
  }
  return "TODO";
}

/** Non-terminal statuses — a child in any of these keeps the workstream "active" */
const NON_TERMINAL_STATUSES: Set<TaskStatus> = new Set([
  "TODO",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "PLANNING",
  "BLOCKED",
]);

function isActive(status: TaskStatus): boolean {
  return NON_TERMINAL_STATUSES.has(status);
}

/**
 * Status sort weight for child ordering.
 * Lower number = listed first.
 * in-progress → in-review → planning → ready → todo → blocked → done → closed
 */
function statusWeight(status: TaskStatus): number {
  switch (status) {
    case "IN-PROGRESS":
      return 0;
    case "IN-REVIEW":
      return 1;
    case "PLANNING":
      return 2;
    case "READY":
      return 3;
    case "TODO":
      return 4;
    case "BLOCKED":
      return 5;
    case "DONE":
      return 6;
    case "CLOSED":
      return 7;
    default:
      return 4;
  }
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
 *   export const workstreamsWidget = createWorkstreamsWidget(defaultDepsFactory);
 *
 *   // Test use:
 *   const widget = createWorkstreamsWidget(async () => ({ taskService: mockSvc, taskGraphService: mockGraphSvc }));
 */
export function createWorkstreamsWidget(getDeps: () => Promise<WorkstreamsDeps>): WidgetModule {
  return {
    id: "workstreams",
    title: "Workstreams",
    // Workstream state changes slowly — 30s polling is lighter than agents/task-graph
    updateMode: { type: "polling", intervalMs: 30_000 },

    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const { taskService, taskGraphService } = await getDeps();

        // Fetch all tasks (no limit — we want the full picture)
        const tasks = await taskService.listTasks({});

        // Build a map from task ID → task for quick lookup and orphan filtering
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        // Fetch all parent relationships.
        // Edge semantics: fromTaskId = child, toTaskId = parent
        // (same as task-graph-service.ts addParent: "edge direction is child→parent")
        const parentRelationships = await taskGraphService.getAllRelationships("parent");

        // Build parent → children[] map from relationships.
        // Only include edges where BOTH parent and child exist in the task list
        // (defensive filter against orphaned edges — same as task-graph.ts).
        const parentToChildren = new Map<string, string[]>();
        for (const rel of parentRelationships) {
          const childId = rel.fromTaskId;
          const parentId = rel.toTaskId;
          // Skip orphaned edges: either endpoint absent from the authoritative list
          if (!taskMap.has(childId) || !taskMap.has(parentId)) continue;

          if (!parentToChildren.has(parentId)) {
            parentToChildren.set(parentId, []);
          }
          const existing = parentToChildren.get(parentId);
          if (existing) {
            existing.push(childId);
          }
        }

        // Build workstream cards for parents that have at least one active child
        const workstreams: WorkstreamCard[] = [];

        for (const [parentId, childIds] of parentToChildren) {
          const parentTask = taskMap.get(parentId);
          if (!parentTask) continue; // should not happen given the filter above, but be safe

          // Build child rows from the child IDs (all are guaranteed to be in taskMap
          // because we filtered orphaned edges above)
          const children: WorkstreamChild[] = childIds.flatMap((childId) => {
            const childTask = taskMap.get(childId);
            if (!childTask) return []; // defensive: should not happen after orphan filter
            return [
              {
                id: formatTaskIdForDisplay(childTask.id),
                title: childTask.title ?? "",
                status: normaliseStatus(childTask.status ?? "TODO"),
              },
            ];
          });

          // Sort children by status weight
          children.sort((a, b) => statusWeight(a.status) - statusWeight(b.status));

          // Compute counts
          const activeChildCount = children.filter((c) => isActive(c.status)).length;
          const doneChildCount = children.filter((c) => c.status === "DONE").length;
          const blockedChildCount = children.filter((c) => c.status === "BLOCKED").length;

          // Filter rule: only include workstreams with at least one active child
          if (activeChildCount === 0) continue;

          workstreams.push({
            parentId: formatTaskIdForDisplay(parentTask.id),
            parentTitle: parentTask.title ?? "",
            parentStatus: normaliseStatus(parentTask.status ?? "TODO"),
            children,
            activeChildCount,
            doneChildCount,
            blockedChildCount,
          });
        }

        // Sort workstreams by activeChildCount descending (most active first),
        // with parentId ascending as a deterministic tie-breaker. PR #1032 R1
        // reviewer finding: without the secondary sort, two workstreams with
        // the same active count would render in nondeterministic order across
        // polling refreshes.
        workstreams.sort((a, b) => {
          if (b.activeChildCount !== a.activeChildCount) {
            return b.activeChildCount - a.activeChildCount;
          }
          return a.parentId.localeCompare(b.parentId);
        });

        const payload: WorkstreamsPayload = { workstreams };
        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `workstreams error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default production widget
//
// Uses the cockpit-wide PersistenceService singleton (shared-persistence.ts).
// ---------------------------------------------------------------------------

import { getSharedPersistenceService } from "../shared-persistence";

let _cachedDeps: WorkstreamsDeps | null = null;

async function defaultDepsFactory(): Promise<WorkstreamsDeps> {
  if (_cachedDeps) {
    return _cachedDeps;
  }

  const { createConfiguredTaskService } = await import("../../domain/tasks/taskService");
  const { TaskGraphService } = await import("../../domain/tasks/task-graph-service");

  const svc = await getSharedPersistenceService();
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

/** Default workstreams widget — ready to drop into WIDGET_REGISTRY */
export const workstreamsWidget: WidgetModule = createWorkstreamsWidget(defaultDepsFactory);
