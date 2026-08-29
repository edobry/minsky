/**
 * Cockpit task routes (mt#2615 — extracted from server.ts).
 *
 *   GET /api/tasks/ids  — uncapped ids-only endpoint for the linkifier (mt#2518 R5)
 *   GET /api/tasks/meta — batch {id,title,status} label channel for the entity-
 *                         reference layer (mt#3174); lazy over requested ids
 *   GET /api/tasks/:id  — task detail for the drill-down page (mt#1918)
 *   GET /api/tasks      — lightweight task list for the command palette (mt#1917)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import {
  getServerTaskService,
  getServerTaskDetailDeps,
  getServerSessionProvider,
  describeServerPersistenceUnavailability,
} from "../db-providers";
import { TaskTitleCache, type TaskProviderLike } from "../task-title-cache";
// Static, matching `widgets/agents.ts`'s use of the same registry: the host
// module is dependency-light by design, and a deployment that never spawns a
// driven session just reads an empty registry.
import { drivenSessionRegistry, isTerminalStatus } from "../driven-session-host";
import { ServerTimingRecorder } from "../server-timing";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";
import { resolveCockpitProjectScope } from "../project-scope";

/**
 * Pick the driven session an operator should be returned to for a task
 * (mt#3400), or null when none applies.
 *
 * Extracted as a pure function for the same reason `parseTaskMetaIds` is: the
 * `/api/tasks/:id` route has no DI seam and `mock.module` is banned in this
 * codebase, so the selection RULES are tested here directly and the route keeps
 * only the registry read (see ./tasks.test.ts's header).
 *
 * Three rules, each load-bearing:
 *   - Ids are compared through `normalize`, never raw. The record's `taskId` is
 *     an opaque string recorded at launch by whichever surface launched it; the
 *     route's comes from the URL. A raw `===` would silently never match if the
 *     two ever disagree on display form.
 *   - `isTerminal` excludes finished sessions so an exited/crashed/unrecoverable
 *     record can never hijack the action — but everything non-terminal DOES
 *     qualify, including `"reconnecting"`. That state (a record rebuilt after a
 *     daemon restart) is exactly the one the originating incident hit, and it is
 *     genuinely reachable: attaching to `/driven/:id` resumes it.
 *   - Newest-started wins when a task has been driven more than once. The
 *     comparator is TOTAL: a missing or non-string `startedAt` sorts last
 *     rather than throwing. Today's producers always supply an ISO string
 *     (`new Date().toISOString()` on spawn, `row.startedAt.toISOString()` on
 *     rehydration, which would itself throw on a null column before reaching
 *     here), so this is not a reachable bug via those paths — but the function
 *     is exported and generic over its record type, so a total comparator
 *     costs nothing and removes the class. (PR #2448 R1.)
 */
export function selectLiveDrivenSession<
  S extends string,
  T extends { localId: string; taskId: string | null; status: S; startedAt: string },
>(
  records: readonly T[],
  wantedTaskId: string,
  normalize: (id: string) => string,
  isTerminal: (status: S) => boolean
): T | null {
  const wanted = normalize(wantedTaskId);
  // Sort key, not the raw field: an absent/non-string `startedAt` becomes ""
  // and therefore sorts last under a descending compare, instead of throwing
  // on `.localeCompare`.
  const startedAtKey = (record: T): string =>
    typeof record.startedAt === "string" ? record.startedAt : "";
  const candidates = records
    .filter(
      (record) =>
        record.taskId !== null && normalize(record.taskId) === wanted && !isTerminal(record.status)
    )
    .sort((a, b) => startedAtKey(b).localeCompare(startedAtKey(a)));
  return candidates[0] ?? null;
}

/**
 * Task-meta provider (mt#3174) — adapts `getServerTaskService()` to
 * `TaskProviderLike`'s batch shape, returning `{id, title, status}` (status
 * included, unlike the title-only providers `widgets/agents.ts` and
 * `widgets/context-inspector.ts` construct for their own `TaskTitleCache`
 * instances). Module-level singleton cache, separate instance from those two
 * widgets' caches — no shared state, no cross-contamination.
 */
/**
 * Collect the task ids referenced by a task's graph neighborhood, deduplicated
 * and in a stable order (mt#3696).
 *
 * Extracted as a pure function for the same reason `selectLiveDrivenSession` is:
 * the `/api/tasks/:id` route has no DI seam and `mock.module` is banned here, so
 * the RULES are tested directly (see ./tasks.test.ts) and the route keeps only
 * the wiring.
 *
 * Every argument is a settled result rather than a value because the four graph
 * reads run under `Promise.allSettled` — one of them failing must degrade that
 * edge to "no neighbors" rather than fail the whole detail read, which is the
 * behavior this preserves.
 */
export function collectReferencedTaskIds(
  parent: PromiseSettledResult<string | null | undefined>,
  children: PromiseSettledResult<readonly string[] | undefined>,
  outgoing: PromiseSettledResult<readonly string[] | undefined>,
  incoming: PromiseSettledResult<readonly string[] | undefined>
): string[] {
  const ids = new Set<string>();
  if (parent.status === "fulfilled" && parent.value) ids.add(parent.value);
  for (const list of [children, outgoing, incoming]) {
    if (list.status !== "fulfilled") continue;
    for (const id of list.value ?? []) ids.add(id);
  }
  return [...ids];
}

async function taskMetaProvider(): Promise<TaskProviderLike> {
  const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
  return {
    async getTask(taskId: string) {
      const taskService = await getServerTaskService();
      if (!taskService) return null;
      const task = await taskService.getTask(taskId);
      if (!task) return null;
      return { title: task.title ?? "", status: (task.status ?? "TODO").toUpperCase() };
    },
    async getTasks(ids: string[]) {
      const taskService = await getServerTaskService();
      if (!taskService) return [];
      const tasks = await taskService.getTasks(ids);
      return tasks.map((t) => ({
        id: formatTaskIdForDisplay(t.id),
        title: t.title ?? "",
        status: ((t.status ?? "TODO") as string).toUpperCase(),
      }));
    },
  };
}

const taskMetaCache = new TaskTitleCache(taskMetaProvider);

/**
 * Parse the `?ids=` query param for `GET /api/tasks/meta` into a clean id
 * list — comma-separated, each segment percent-decoded and trimmed, empty
 * segments dropped. Pure (no I/O) so it's unit-testable without a running
 * server or task service (mt#3174).
 */
export function parseTaskMetaIds(rawIds: unknown): string[] {
  if (typeof rawIds !== "string" || rawIds.length === 0) return [];
  return rawIds
    .split(",")
    .map((s) => {
      try {
        return decodeURIComponent(s.trim());
      } catch {
        return "";
      }
    })
    .filter((s) => s.length > 0);
}

export interface TaskRoutesOptions {
  /**
   * Test seam (mt#4727, mirrors `asks.ts`'s `askRepoOverride` /
   * `conversation-search.ts`'s `getDb` options): overrides `getServerTaskService()`
   * for `/api/tasks` and `/api/tasks/ids` so project-scope wiring can be
   * tested with a real, injectable `TaskServiceInterface` (e.g. an
   * in-memory fake seeded with two-project fixtures) rather than the real
   * DB-backed singleton. Production callers never set this.
   */
  taskServiceOverride?: TaskServiceInterface;
  /**
   * Test seam (mt#4727, mirrors `widgets/agents.ts`'s `getProjectScopeDb`):
   * overrides `resolveCockpitProjectScope`'s own db-fetch for `/api/tasks`
   * and `/api/tasks/ids`'s `?project=` resolution. Production callers never
   * set this — `resolveCockpitProjectScope` falls back to its own
   * `defaultGetDb` (the real `getContextInspectorDb()` singleton).
   */
  getProjectScopeDb?: () => Promise<
    import("@minsky/domain/project/scope-resolver").ScopeResolverDb | null
  >;
}

/** Mount the /api/tasks* routes on `app`. */
export function mountTaskRoutes(app: express.Express, opts: TaskRoutesOptions = {}): void {
  const { taskServiceOverride, getProjectScopeDb } = opts;
  /**
   * GET /api/tasks/meta?ids=mt%231,mt%232 — batch task-label channel (mt#3174).
   *
   * Returns: { tasks: {id, title, status}[] } for whichever of the requested
   * ids resolve — unknown/missing ids are simply omitted (never an error),
   * so a caller degrades to bare-id rendering for anything not returned.
   *
   * Built on `TaskTitleCache` (TTL-cached batch resolution, mt#2770) rather
   * than a widened `/api/tasks/ids` — this channel is lazy over the ids
   * actually requested, not a comprehensive/uncapped list (that property
   * belongs to `/api/tasks/ids` alone; see its doc comment below).
   *
   * IMPORTANT: registered BEFORE /api/tasks/:id so "meta" is not interpreted
   * as a task id parameter by Express's first-match-wins routing (same
   * reasoning as the /api/tasks/ids route below).
   */
  app.get("/api/tasks/meta", async (req, res) => {
    try {
      const ids = parseTaskMetaIds(req.query.ids);
      if (ids.length === 0) {
        res.json({ tasks: [] });
        return;
      }
      const meta = await taskMetaCache.getTaskMeta(ids);
      const tasks = Array.from(meta, ([id, m]) => ({ id, title: m.title, status: m.status }));
      res.json({ tasks });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "tasks")) return;
      log.error(`[tasks] GET /api/tasks/meta — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while resolving task labels." });
    }
  });

  /**
   * GET /api/tasks/ids — uncapped ids-only endpoint for the linkifier (mt#2518 R5).
   *
   * Returns: { ids: string[] } containing EVERY task id with no count cap.
   * Task ids are tiny (~2 KB for ~2K tasks) so fetching all is cheap.
   * This is the correct fetch target for the entity-index linkifier in
   * ConversationView — it must have a comprehensive id-set so every real
   * mt#NNNN reference in a transcript can be linked.
   *
   * The normal /api/tasks list carries a 500-cap (correct for the list UI)
   * and returns full objects. This route is ids-only and uncapped: it is NOT
   * a general-purpose task-list replacement.
   *
   * IMPORTANT: registered BEFORE /api/tasks/:id so "ids" is not interpreted
   * as a task id parameter by Express's first-match-wins routing.
   */
  app.get("/api/tasks/ids", async (req, res) => {
    try {
      const taskService = taskServiceOverride ?? (await getServerTaskService());
      if (!taskService) {
        res.status(503).json({
          error: `Task service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      // Project scope (mt#4727): ?project=<slug>, same resolution rules as
      // every other cockpit project-scoped read (mt#2418 pattern). Absent/"all"
      // resolves to ALL_PROJECTS, preserving the pre-mt#4727 comprehensive
      // id-set behavior this endpoint's docblock promises the linkifier.
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectScope = await resolveCockpitProjectScope(projectParam, {
        getDb: getProjectScopeDb,
      });
      // Fetch ALL tasks regardless of status (no 500 cap, no sort needed — ids only).
      const tasks = await taskService.listTasks({ all: true, projectScope });
      const ids = tasks.map((t) => formatTaskIdForDisplay(t.id));
      res.json({ ids });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "tasks")) return;
      log.error(`[tasks] GET /api/tasks/ids — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while listing task ids." });
    }
  });

  /**
   * GET /api/tasks/:id — task detail for the drill-down page (mt#1918).
   *
   * Returns: { task, spec, parent, children, deps }
   * Uses the shared task-detail deps singleton (TaskService + TaskGraphService).
   * IMPORTANT: This route must be registered BEFORE /api/tasks (the list
   * endpoint) so Express evaluates it first. Express matches routes in
   * registration order; the parameterised /:id would otherwise never fire
   * because /api/tasks (exact) would catch same-length paths first — but to
   * be safe we register /:id before the exact /api/tasks route.
   */
  app.get("/api/tasks/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Task ID required" });
      return;
    }
    // Accept both URL-encoded (mt%231918) and raw (mt#1918) forms
    const taskId = decodeURIComponent(rawId);

    // Per-phase attribution for this handler (mt#3696). The detail read is the
    // cockpit's dominant server cost, and its waves are individually invisible
    // from the browser — a client can see the total and nothing else.
    //
    // Attached rather than applied per-exit so the 503/404/500 responses carry
    // the attribution too: a slow FAILURE is exactly the case someone reaches
    // for this header to explain (PR #2637 R1).
    const timing = new ServerTimingRecorder();
    timing.attachTo(res);

    try {
      const taskDetailDeps = await timing.time("deps", () => getServerTaskDetailDeps());
      if (!taskDetailDeps) {
        res.status(503).json({
          error: `Task service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }

      const { taskService, taskGraphService } = taskDetailDeps;
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

      // Three independent reads, all started before any is awaited (mt#3696).
      //
      // Each of these needs only `taskId`, which is known at request entry —
      // none consumes another's output. Awaiting them in sequence therefore
      // serialized three round trips to a remote Postgres for no reason, and
      // that serialization WAS the page's cost, not the size of any one query:
      // measured on the detail route, task=583ms + graph=171ms +
      // workspace-lookup=246ms summed to a ~1.0s handler against a ~4KB
      // response, while the 71KB list route answered in a fifth of the time.
      //
      // Only `refs` below is genuinely dependent — it needs the ids `graph`
      // returns — so it stays sequenced after it.
      //
      // Starting all three here means a rejection could go unhandled if an
      // early return fires before the await. `Promise.allSettled` cannot
      // reject, and the workspace probe catches internally and resolves to
      // null, so every promise started here is already non-rejecting.
      //
      // Deliberate load-vs-latency trade (PR #2637 R1): a request for an id
      // that does not exist still runs the graph and workspace reads before the
      // 404, so a 404 costs reads it does not use. Accepted, because the
      // alternative does not work — "check the task exists first" IS the
      // `getTask` round trip, so gating on it re-serializes the whole handler
      // and gives back the ~400ms this change bought on every successful read.
      // A 404 here means a malformed URL, not a normal flow.
      const taskPromise = timing.time("task", () =>
        Promise.allSettled([
          taskService.getTask(taskId),
          taskService.getTaskSpecContent(taskId).catch(() => null),
        ])
      );

      const graphPromise = timing.time("graph", () =>
        Promise.allSettled([
          taskGraphService.getParent(taskId),
          taskGraphService.listChildren(taskId),
          taskGraphService.listDependencies(taskId),
          taskGraphService.listDependents(taskId),
        ])
      );

      // `refs` is the ONE genuinely dependent read — it needs the ids `graph`
      // returns — so it chains off `graphPromise` rather than off the awaits
      // below. Sequencing it after `await taskPromise` instead would have made
      // it wait on a read it has nothing to do with: measured, that pushed the
      // handler to task(468ms) + refs(157ms) = 625ms when graph+refs together
      // finish in ~310ms and could hide entirely inside the task read.
      //
      // Unlike its two siblings this CAN reject, and an early 404 return could
      // leave that rejection unobserved. The no-op catch marks it handled
      // without swallowing it: `await refsPromise` below still throws, so a
      // genuine failure still reaches the handler's catch and still 500s.
      const refsPromise = graphPromise.then(async (settled) => {
        const ids = collectReferencedTaskIds(...settled);
        if (ids.length === 0) return [];
        return timing.time("refs", () => taskService.getTasks(ids));
      });
      refsPromise.catch(() => {});

      const workspacePromise = timing.time("workspace-lookup", async () => {
        try {
          const sessionProvider = await getServerSessionProvider();
          if (!sessionProvider) return null;
          const existing = await sessionProvider.getSessionByTaskId(taskId);
          return existing
            ? { sessionId: existing.sessionId, prNumber: existing.pullRequest?.number ?? null }
            : null;
        } catch (workspaceErr) {
          log.warn(
            `[tasks] actions workspace probe failed for ${taskId}: ${
              workspaceErr instanceof Error ? workspaceErr.message : String(workspaceErr)
            }`
          );
          return null;
        }
      });

      const [taskResult, specResult] = await taskPromise;

      if (taskResult.status === "rejected") {
        // A rejected task fetch can be the DATABASE being unreachable, not a
        // missing task — the reason carries the driver error the same way a
        // catch would (mt#4125).
        if (await respondIfDatabaseUnavailable(res, taskResult.reason, "tasks")) return;
        const reason =
          taskResult.reason instanceof Error
            ? taskResult.reason.message
            : String(taskResult.reason);
        if (reason.toLowerCase().includes("not found")) {
          res.status(404).json({ error: `Task ${taskId} not found` });
        } else {
          res.status(500).json({ error: reason });
        }
        return;
      }

      const task = taskResult.value;
      if (!task) {
        res.status(404).json({ error: `Task ${taskId} not found` });
        return;
      }

      const specContent =
        specResult.status === "fulfilled" && specResult.value ? specResult.value.content : null;

      // Fetch parent, children, and deps in parallel via TaskGraphService
      // listDependencies → outgoing (what this task depends on)
      // listDependents  → incoming (what depends on this task)
      const [parentIdResult, childIdsResult, outgoingIdsResult, incomingIdsResult] =
        await graphPromise;

      const refTasksArr = await refsPromise;
      const refTaskMap = new Map(refTasksArr.map((t) => [t.id, t]));

      function taskRef(id: string): { id: string; title: string; status: string } {
        const t = refTaskMap.get(id);
        return {
          id: formatTaskIdForDisplay(id),
          title: t?.title ?? "",
          status: ((t?.status ?? "TODO") as string).toUpperCase(),
        };
      }

      const parentId = parentIdResult.status === "fulfilled" ? parentIdResult.value : null;
      const parent = parentId ? taskRef(parentId) : null;

      const childIds = childIdsResult.status === "fulfilled" ? (childIdsResult.value ?? []) : [];
      const children = childIds.map(taskRef);

      const outgoingIds =
        outgoingIdsResult.status === "fulfilled" ? (outgoingIdsResult.value ?? []) : [];
      const incomingIds =
        incomingIdsResult.status === "fulfilled" ? (incomingIdsResult.value ?? []) : [];

      const taskDeps = {
        outgoing: outgoingIds.map(taskRef),
        incoming: incomingIds.map(taskRef),
      };

      // Stage-appropriate actions for the cockpit act-here region (mt#2986,
      // superseding mt#2959's button-shaped `startability` boolean). Every
      // non-terminal stage maps to at least one action that can actually
      // succeed (the mt#2959 honesty invariant, kept): a principal-driven
      // launch is exempt from the planning gate (session-startability.ts), so
      // pre-READY stages offer "plan" (a driven session primed to plan) rather
      // than a dead-end explanation. The workspace probe degrades to
      // "no workspace" on any error rather than failing the detail read.
      interface TaskAction {
        kind: "plan" | "start" | "resume" | "view-pr" | "drive";
        /** Workspace session id — set on "resume". */
        sessionId?: string;
        /** Driven-session local id — set on "drive" (mt#3400). */
        drivenSessionId?: string;
        /** PR number — set on "view-pr" when known. */
        prNumber?: number;
        /** Secondary explanation rendered under the control (honesty layer). */
        note?: string;
      }

      // Started concurrently with the task and graph reads above; by the time
      // control reaches here it has usually already resolved. It still degrades
      // to "no workspace" on any error rather than failing the detail read —
      // the catch now lives inside the promise rather than around this await.
      const existingWorkspace = await workspacePromise;

      // mt#3400 — a live driven session bound to this task is the operator's
      // actual work surface, and until this probe existed the task page could
      // not see it: the workspace probe above answers "does a clone exist",
      // never "is something running in it". The result was that the page's own
      // recovery affordance ("Open session" -> /agents/:id) pointed AWAY from
      // the live drive view, making the return path four hops. Registry read
      // only — this route and the driven-session host share one process, so
      // there is no HTTP round-trip and no new external dependency. Degrades to
      // "no live driven session" on any error, matching the workspace probe's
      // posture directly above: a task page must still render if the driven
      // registry is unavailable.
      let liveDriven: { drivenSessionId: string } | null = null;
      try {
        const { formatTaskIdForDisplay: formatForCompare } = await import(
          "@minsky/domain/tasks/task-id-utils"
        );
        const newest = selectLiveDrivenSession(
          drivenSessionRegistry.list(),
          taskId,
          formatForCompare,
          isTerminalStatus
        );
        if (newest) {
          liveDriven = { drivenSessionId: newest.localId };
        }
      } catch (drivenErr) {
        log.warn(
          `[tasks] driven-session probe failed for ${taskId}: ${
            drivenErr instanceof Error ? drivenErr.message : String(drivenErr)
          }`
        );
      }

      const { sessionStartBlockedReason } = await import(
        "@minsky/domain/session/session-startability"
      );
      // mt#3010: single-authority consolidation — this route runs server-side
      // (not part of the Vite-bundled cockpit web client, unlike
      // status-colors.ts / TaskList.tsx, which stay on self-contained literals
      // for bundle-size/Node-built-in reasons), so importing the registry's
      // predicates directly is safe here.
      const { isTerminal, isActiveWork, isAwaitingReview } = await import(
        "@minsky/domain/tasks/workflows"
      );

      const status = (task.status ?? "TODO").toUpperCase();
      const kind = task.kind ?? "implementation";
      const actions: TaskAction[] = [];

      if (!isTerminal(status)) {
        const resumeAction: TaskAction | null = existingWorkspace
          ? { kind: "resume", sessionId: existingWorkspace.sessionId }
          : null;

        const preReady = status === "TODO" || (status === "PLANNING" && kind !== "umbrella");
        if (preReady) {
          // The autonomous gate's reason doubles as the honest explanation of
          // WHY this is a plan launch rather than a plain start.
          actions.push({
            kind: "plan",
            note: sessionStartBlockedReason(status, kind) ?? undefined,
          });
        } else if (status === "READY" || (status === "PLANNING" && kind === "umbrella")) {
          actions.push({ kind: "start" });
        } else if (isActiveWork(status)) {
          if (resumeAction) {
            actions.push(resumeAction);
          } else {
            actions.push({ kind: "start" });
          }
        } else if (isAwaitingReview(status)) {
          actions.push({
            kind: "view-pr",
            prNumber: existingWorkspace?.prNumber ?? undefined,
          });
        } else if (status === "BLOCKED") {
          actions.push({
            ...(resumeAction ?? { kind: "start" }),
            note: "Task is BLOCKED — review its dependencies below before driving it.",
          });
        }

        // Resume is always reachable as a secondary action when a workspace
        // exists and isn't already the primary.
        if (resumeAction && !actions.some((a) => a.kind === "resume")) {
          actions.push(resumeAction);
        }

        // mt#3400 — a live driven session LEADS, whatever the stage-appropriate
        // action would otherwise have been. Unshift rather than replace, so the
        // workspace link and the stage action both stay reachable behind it.
        //
        // This also removes a duplicate-launch footgun on the pre-READY stages:
        // "Plan in session" SPAWNS a new driven session, so a task already
        // being driven previously offered launch-another as its primary
        // control, with the live session invisible.
        if (liveDriven) {
          actions.unshift({ kind: "drive", drivenSessionId: liveDriven.drivenSessionId });
        }
      }

      res.json({
        task: {
          id: formatTaskIdForDisplay(task.id),
          title: task.title ?? "",
          status: (task.status ?? "TODO").toUpperCase(),
          kind: task.kind ?? "implementation",
          tags: task.tags ?? [],
        },
        spec: specContent,
        parent,
        children,
        deps: taskDeps,
        actions,
      });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "tasks")) return;
      log.error(`[tasks] GET /api/tasks/:id — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while fetching the task." });
    }
  });

  /**
   * GET /api/tasks — lightweight task list for the command palette (mt#1917).
   *
   * Returns: { tasks: { id, title, status }[] }
   * Uses the shared task service singleton (same bootstrap pattern as
   * workstreams.ts). Returns 503 when the task service is unavailable.
   * Most-recently-updated first before the 500-cap (mt#2444): an unordered
   * slice over a >500 backlog hid every recent task from the palette.
   *
   * Query params:
   *   ?all=true — return ALL task ids regardless of status (DONE/CLOSED
   *               included). Used by the entity-index linkifier (mt#2518) to make
   *               the task id-set comprehensive so every transcript ref links.
   *               Without this flag the default excludes terminal statuses, which
   *               caused only 2 of 70 task refs to link in live transcripts.
   */
  app.get("/api/tasks", async (req, res) => {
    // mt#3696 — instrumented alongside the detail route so a measurement can
    // compare them: the list returns ~20x the payload of a detail read, which
    // is what makes the detail read's cost recognizably not payload-bound.
    const timing = new ServerTimingRecorder();
    timing.attachTo(res);

    try {
      const taskService =
        taskServiceOverride ?? (await timing.time("service", () => getServerTaskService()));
      if (!taskService) {
        res.status(503).json({
          error: `Task service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      const { sortTasksByRecency } = await import("../palette-tasks");
      // ?all=true: include DONE/CLOSED tasks (needed by the entity-index
      // linkifier in ConversationView — mt#2518). Without this flag the backend
      // default hides terminal-status tasks, leaving most transcript refs unlinkified.
      const includeAll = req.query.all === "true";
      // Project scope (mt#4727): ?project=<slug>, same resolution rules as
      // every other cockpit project-scoped read (mt#2418 pattern). Absent/"all"
      // resolves to ALL_PROJECTS. resolveCockpitProjectScope owns its own
      // db-fetch and never throws (fail-open — PR #2056 R1), so a scoping
      // failure can never take this route down.
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectScope = await resolveCockpitProjectScope(projectParam, {
        getDb: getProjectScopeDb,
      });
      const tasks = await timing.time("list", () =>
        taskService.listTasks({ all: includeAll, projectScope })
      );
      const taskList = sortTasksByRecency(tasks)
        .slice(0, 500)
        .map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title ?? "",
          status: (t.status ?? "TODO").toUpperCase(),
        }));
      res.json({ tasks: taskList });
    } catch (err) {
      if (await respondIfDatabaseUnavailable(res, err, "tasks")) return;
      log.error(`[tasks] GET /api/tasks — internal error: ${getLoggableErrorSummary(err)}`);
      res.status(500).json({ error: "An internal error occurred while listing tasks." });
    }
  });
}
