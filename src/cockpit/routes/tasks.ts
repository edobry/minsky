/**
 * Cockpit task routes (mt#2615 — extracted from server.ts).
 *
 *   GET /api/tasks/ids — uncapped ids-only endpoint for the linkifier (mt#2518 R5)
 *   GET /api/tasks/:id — task detail for the drill-down page (mt#1918)
 *   GET /api/tasks     — lightweight task list for the command palette (mt#1917)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import {
  getServerTaskService,
  getServerTaskDetailDeps,
  getServerSessionProvider,
} from "../db-providers";

/** Mount the /api/tasks* routes on `app`. */
export function mountTaskRoutes(app: express.Express): void {
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
      const taskService = await getServerTaskService();
      if (!taskService) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      // Fetch ALL tasks regardless of status (no 500 cap, no sort needed — ids only).
      const tasks = await taskService.listTasks({ all: true });
      const ids = tasks.map((t) => formatTaskIdForDisplay(t.id));
      res.json({ ids });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[tasks] GET /api/tasks/ids — internal error: ${message}`);
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

    try {
      const taskDetailDeps = await getServerTaskDetailDeps();
      if (!taskDetailDeps) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }

      const { taskService, taskGraphService } = taskDetailDeps;
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

      // Fetch task metadata and spec in parallel — they don't depend on each other
      const [taskResult, specResult] = await Promise.allSettled([
        taskService.getTask(taskId),
        taskService.getTaskSpecContent(taskId).catch(() => null),
      ]);

      if (taskResult.status === "rejected") {
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
        await Promise.allSettled([
          taskGraphService.getParent(taskId),
          taskGraphService.listChildren(taskId),
          taskGraphService.listDependencies(taskId),
          taskGraphService.listDependents(taskId),
        ]);

      // Collect all referenced task IDs so we can batch-fetch their metadata
      const referencedIds = new Set<string>();
      if (parentIdResult.status === "fulfilled" && parentIdResult.value) {
        referencedIds.add(parentIdResult.value);
      }
      if (childIdsResult.status === "fulfilled") {
        for (const id of childIdsResult.value ?? []) referencedIds.add(id);
      }
      if (outgoingIdsResult.status === "fulfilled") {
        for (const id of outgoingIdsResult.value ?? []) referencedIds.add(id);
      }
      if (incomingIdsResult.status === "fulfilled") {
        for (const id of incomingIdsResult.value ?? []) referencedIds.add(id);
      }

      // Batch-fetch metadata for all referenced tasks
      const refTasksArr =
        referencedIds.size > 0 ? await taskService.getTasks([...referencedIds]) : [];
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
        kind: "plan" | "start" | "resume" | "view-pr";
        /** Workspace session id — set on "resume". */
        sessionId?: string;
        /** PR number — set on "view-pr" when known. */
        prNumber?: number;
        /** Secondary explanation rendered under the control (honesty layer). */
        note?: string;
      }

      let existingWorkspace: { sessionId: string; prNumber: number | null } | null = null;
      try {
        const sessionProvider = await getServerSessionProvider();
        if (sessionProvider) {
          const existing = await sessionProvider.getSessionByTaskId(taskId);
          if (existing) {
            existingWorkspace = {
              sessionId: existing.sessionId,
              prNumber: existing.pullRequest?.number ?? null,
            };
          }
        }
      } catch (workspaceErr) {
        log.warn(
          `[tasks] actions workspace probe failed for ${taskId}: ${
            workspaceErr instanceof Error ? workspaceErr.message : String(workspaceErr)
          }`
        );
      }

      const { sessionStartBlockedReason } = await import(
        "@minsky/domain/session/session-startability"
      );

      const status = (task.status ?? "TODO").toUpperCase();
      const kind = task.kind ?? "implementation";
      const isTerminal = status === "DONE" || status === "CLOSED";
      const actions: TaskAction[] = [];

      if (!isTerminal) {
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
        } else if (status === "IN-PROGRESS") {
          if (resumeAction) {
            actions.push(resumeAction);
          } else {
            actions.push({ kind: "start" });
          }
        } else if (status === "IN-REVIEW") {
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
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[tasks] GET /api/tasks/:id — internal error: ${message}`);
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
    try {
      const taskService = await getServerTaskService();
      if (!taskService) {
        res.status(503).json({
          error: "Task service unavailable — persistence provider not ready",
        });
        return;
      }
      const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");
      const { sortTasksByRecency } = await import("../palette-tasks");
      // ?all=true: include DONE/CLOSED tasks (needed by the entity-index
      // linkifier in ConversationView — mt#2518). Without this flag the backend
      // default hides terminal-status tasks, leaving most transcript refs unlinkified.
      const includeAll = req.query.all === "true";
      const tasks = await taskService.listTasks({ all: includeAll });
      const taskList = sortTasksByRecency(tasks)
        .slice(0, 500)
        .map((t) => ({
          id: formatTaskIdForDisplay(t.id),
          title: t.title ?? "",
          status: (t.status ?? "TODO").toUpperCase(),
        }));
      res.json({ tasks: taskList });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[tasks] GET /api/tasks — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while listing tasks." });
    }
  });
}
