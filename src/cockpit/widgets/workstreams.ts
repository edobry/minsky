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
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import { isTerminal } from "@minsky/domain/tasks/workflows";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";
import { describeWidgetDegradedReason } from "../db-providers";

// ---------------------------------------------------------------------------
// Public shapes — mirrored in Workstreams.tsx (no server imports allowed on
// the frontend). Keep in sync, with ONE standing exception, stated here
// because "verbatim" used to be claimed and is not true (PR #3523 R1): the
// frontend may declare a field OPTIONAL that is required here, when a
// freshly-built bundle can receive a payload from a not-yet-restarted daemon
// — the bundle and the daemon are rebuilt by separate watchers (mt#2297 /
// mt#2299). `altitude` and `projectId` are both that case, and each carries
// the reason at its own declaration on the frontend side. The reverse
// (required on the frontend, optional here) is always drift.
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
  /**
   * Newest `updatedAt` across the parent and all children, ISO string
   * (mt#2885) — the stream's last-motion signal; null when no task in the
   * stream carries a timestamp. Stall detection derives from this
   * render-side against the decision-defaults thresholds.
   */
  lastActivityAt: string | null;
  /**
   * The PARENT task's owning project uuid (mt#4773) — a workstream belongs to
   * its root's project. Resolved to a label client-side (`projectLabelById`)
   * for the all-projects badge; null for a legacy/unscoped root.
   */
  projectId: string | null;
}

/**
 * Slice/altitude vocabulary (mt#2385, Constraint-2 of mt#2373).
 *
 * Names are SEMANTIC, not persona-named — lenses (mt#2372) are user-definable
 * modes that will parameterize widgets with these slices; the widget itself
 * must not encode a persona model (memory bd38be2c §2).
 *
 *   full       — default; the current complete card view
 *   rollup     — outcome rollup: card headers + counts only, no child rows
 *   actionable — actionable-now: children narrowed to statuses needing action
 *                (IN-PROGRESS / IN-REVIEW / READY / BLOCKED); only workstreams
 *                with at least one such child are included
 */
export type WorkstreamAltitude = "full" | "rollup" | "actionable";

const KNOWN_ALTITUDES: ReadonlySet<string> = new Set(["full", "rollup", "actionable"]);

/** Unknown / absent altitude values fall back to "full" (never an error). */
export function parseAltitude(raw: string | undefined): WorkstreamAltitude {
  if (raw !== undefined && KNOWN_ALTITUDES.has(raw)) {
    return raw as WorkstreamAltitude;
  }
  return "full";
}

/** Full payload returned by this widget when state === "ok" */
export interface WorkstreamsPayload {
  workstreams: WorkstreamCard[];
  /** The slice that produced this payload — echoed so slices are observably distinct */
  altitude: WorkstreamAltitude;
}

// ---------------------------------------------------------------------------
// Deps type injected by the factory
// ---------------------------------------------------------------------------

export interface WorkstreamsDeps {
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

/**
 * A child in a non-terminal status keeps the workstream "active" (mt#3010:
 * delegates to the domain registry's isTerminal instead of a hand-maintained
 * NON_TERMINAL_STATUSES Set — this file runs server-side, unlike its frontend
 * twin Workstreams.tsx, so importing the registry here is safe).
 */
function isActive(status: TaskStatus): boolean {
  return !isTerminal(status);
}

/**
 * Actionable-now statuses for the "actionable" altitude — children in motion
 * or needing unblocking. Deliberately narrower than NON_TERMINAL_STATUSES:
 * TODO/PLANNING children are upcoming, not actionable now.
 */
const ACTIONABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "IN-PROGRESS",
  "IN-REVIEW",
  "READY",
  "BLOCKED",
]);

/**
 * Apply an altitude slice to the full card list. Counts on each card always
 * describe the COMPLETE child set (the workstream's true state); only the
 * rendered child rows are narrowed.
 */
export function sliceWorkstreams(
  cards: WorkstreamCard[],
  altitude: WorkstreamAltitude
): WorkstreamCard[] {
  switch (altitude) {
    case "rollup":
      return cards.map((card) => ({ ...card, children: [] }));
    case "actionable":
      return cards.flatMap((card) => {
        const actionable = card.children.filter((c) => ACTIONABLE_STATUSES.has(c.status));
        if (actionable.length === 0) return [];
        return [{ ...card, children: actionable }];
      });
    case "full":
      return cards;
  }
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

    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const altitude = parseAltitude(ctx.query?.["altitude"]);
        const { taskService, taskGraphService, getDb } = await getDeps();

        // Project scope (mt#4727): ?project=<slug> resolved to a project
        // uuid, defaulting to ALL_PROJECTS when omitted/"all" — same
        // resolution rules as every other cockpit project-scoped read
        // (mt#2418 pattern, task-list.ts:91-93). resolveCockpitProjectScope
        // owns its own db-fetch and never throws (fail-open to ALL_PROJECTS
        // on any resolution failure — PR #2056 R1), so a scoping problem can
        // never take this widget down.
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.["project"], { getDb });

        // Fetch all tasks in scope (no limit — we want the full picture).
        // ADR-046 (mt#2911): work packages are excluded by kind — a package is
        // a claimable bundle, not a workstream node, and its members are
        // reference rows rather than graph edges, so one must never render as
        // a card or a child here.
        const tasks = (await taskService.listTasks({ projectScope })).filter(
          (t) => t.kind !== "work-package"
        );

        // Build a map from task ID → task for quick lookup and orphan filtering
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        // Fetch all parent relationships. NOT project-scoped itself — the
        // orphan filter just below (both endpoints must be present in the
        // already-scoped `taskMap`) is what confines the rendered cards to
        // the resolved project, same double-duty as task-graph.ts (mt#4727).
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

          // Last-motion signal (mt#2885): newest updatedAt across parent +
          // children. Tasks without a timestamp simply don't contribute.
          let lastActivityMs = parentTask.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
          for (const childId of childIds) {
            const t = taskMap.get(childId)?.updatedAt?.getTime();
            if (t !== undefined && t > lastActivityMs) lastActivityMs = t;
          }
          const lastActivityAt = Number.isFinite(lastActivityMs)
            ? new Date(lastActivityMs).toISOString()
            : null;

          workstreams.push({
            parentId: formatTaskIdForDisplay(parentTask.id),
            parentTitle: parentTask.title ?? "",
            parentStatus: normaliseStatus(parentTask.status ?? "TODO"),
            children,
            activeChildCount,
            doneChildCount,
            blockedChildCount,
            lastActivityAt,
            projectId: parentTask.projectId ?? null,
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

        const payload: WorkstreamsPayload = {
          workstreams: sliceWorkstreams(workstreams, altitude),
          altitude,
        };
        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("workstreams", err) };
      }
    },
  };
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
 * no epoch check; it happened to read `ok` during the originating incident only
 * because it was built AFTER that recycle, which is timing, not immunity.
 */
const defaultDepsFactory = createEpochKeyedCache(async (): Promise<WorkstreamsDeps> => {
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

/** Default workstreams widget — ready to drop into WIDGET_REGISTRY */
export const workstreamsWidget: WidgetModule = createWorkstreamsWidget(defaultDepsFactory);
