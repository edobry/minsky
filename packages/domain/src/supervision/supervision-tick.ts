/**
 * The unattended supervisor's tick (mt#4571).
 *
 * One pass over every active supervision: settle what finished, recompute the
 * frontier, dispatch what is now unblocked up to the WIP limit. This is the
 * whole "walk the task tree while the operator is away" behaviour, and it is
 * written against `SupervisionTickDeps` rather than a database handle so it can
 * be exercised end-to-end with an in-memory fake — a real `claude` child cannot
 * be spawned in a test, and the DAG walking is the part that has to be right.
 *
 * **Two settlement signals, doing different jobs.** mt#4571 SC3 asks for
 * `pr.merged` plus a reconciling tick, and both are load-bearing:
 *
 *  - `pr.merged` is the PROMPT, PRECISE signal — it names the task and fires at
 *    the moment the child's work lands.
 *  - Re-reading each in-flight child's task status from the graph is the
 *    BACKSTOP, which makes a missed or unread event non-fatal. That is
 *    `decision-defaults.mdc §Reliability`'s sweeper-over-queue default applied,
 *    not invented here.
 *
 * **`task.status_changed` is deliberately NOT used.** Its only emitter is
 * `emitTaskStatusChangedEvent`, called from the `tasks_status_set` path. A
 * merge-driven DONE goes through `applyPostMergeStateSync`, which calls
 * `taskService.setTaskStatus` directly and emits nothing — so a child completing
 * the ordinary way produces no row at all. mt#4574 owns closing that gap; it is
 * deliberately not a dependency of this task, because `pr.merged` already covers
 * the trigger and mt#4574 buys a uniform stream rather than unblocking anything.
 *
 * **What this never does (mt#4571 SC7).** It calls exactly three actuators:
 * resolve a workspace, spawn a child, hand that child its prompt. It does not
 * merge, does not answer asks, does not change scope, and does not retry a
 * failed child. Anything a child escalates reaches the operator through the
 * ordinary asks surface, independently of the supervisor.
 *
 * @see ./types.ts — the dependency interfaces
 * @see ../tasks/umbrella-frontier.ts — the shared frontier computation
 * @see mt#2750 / mt#3038 — the spawn host and its persistence, consumed via `dispatchChild`
 */
import { isTerminal } from "../tasks/workflows";
import type {
  DispatchView,
  SettledBy,
  SupervisionAdvance,
  SupervisionTickDeps,
  SupervisionTickResult,
  SupervisionView,
} from "./types";

/**
 * Cap on `pr.merged` rows read per tick.
 *
 * Matches the 500-row ceiling `listEvents` already enforces. Exceeding it is
 * survivable rather than a correctness problem — the graph reconciliation in the
 * same tick settles the same dispatches from task status, so an unread event
 * costs latency, not a stranded child.
 */
export const MERGED_EVENT_READ_LIMIT = 500;

/**
 * How long a supervision may go without advancing before it is reported stalled
 * (mt#4571 SC9).
 *
 * 8 hours, grounded in measurement rather than picked
 * (`decision-defaults.mdc §Thresholds`): child duration measured over
 * `[session.started, pr.merged]` for 1,156 spans in the 60 days to 2026-08-25
 * was median 0.68h, p90 7.26h, p95 18.37h. This is p90 rounded up to the next
 * whole hour — the point past which "nothing has moved" stops being ordinary.
 *
 * Distinct from anything `startSweepMetaWatchdog` can see. That watches for a
 * DEAD tick; this is the SEMANTIC stall, where the tick is perfectly healthy and
 * has moved nothing, which from the outside looks identical to a healthy tick
 * with nothing to do.
 */
export const SUPERVISION_STALL_THRESHOLD_MS = 8 * 60 * 60 * 1000;

/** Hold reasons recorded on the supervision when a tick dispatches nothing. */
export const HOLD_WIP_LIMIT = "wip-limit";
export const HOLD_FRONTIER_EMPTY = "frontier-empty";
export const HOLD_ALL_BLOCKED = "all-children-blocked";
export const HOLD_ALREADY_DISPATCHED = "frontier-already-dispatched";

/** True when a supervision has gone longer than the threshold without advancing. */
export function isSupervisionStalled(
  supervision: Pick<SupervisionView, "lastAdvanceAt" | "lastTickAt">,
  now: Date,
  thresholdMs: number = SUPERVISION_STALL_THRESHOLD_MS
): boolean {
  // Before the first advance, measure from the first tick: a supervision that
  // has never moved anything since it started is exactly the case worth
  // surfacing, and anchoring on `lastAdvanceAt` alone would make it invisible
  // forever because that column is still null.
  const anchor = supervision.lastAdvanceAt ?? supervision.lastTickAt;
  if (anchor === null) return false;
  return now.getTime() - anchor.getTime() > thresholdMs;
}

/**
 * Run one supervision's pass. Assumes the caller already holds its lock.
 *
 * Exported for tests, which drive a single supervision rather than the whole
 * active set.
 */
export async function runSupervisionPass(
  supervision: SupervisionView,
  deps: SupervisionTickDeps
): Promise<SupervisionAdvance> {
  const { store } = deps;
  const now = deps.now();
  const advance: SupervisionAdvance = {
    supervisionId: supervision.id,
    umbrellaTaskId: supervision.umbrellaTaskId,
    lockAcquired: true,
    dispatched: [],
    settled: [],
    holdReason: null,
    completed: false,
    error: null,
  };

  // ---- 1. Settle from pr.merged (the prompt, precise signal) --------------
  const inFlight = await store.listInFlightDispatches(supervision.id);
  const unsettled = new Map<string, DispatchView>(inFlight.map((d) => [d.taskId, d]));

  let watermark = supervision.eventsWatermark;
  if (inFlight.length > 0) {
    const merged = await store.listMergedSince(
      supervision.eventsWatermark,
      MERGED_EVENT_READ_LIMIT
    );
    for (const event of merged) {
      if (watermark === null || event.at > watermark) watermark = event.at;
      const dispatch = unsettled.get(event.taskId);
      if (!dispatch) continue;
      await settle(store, dispatch, "succeeded", "pr.merged", null, now, advance);
      unsettled.delete(event.taskId);
    }
  }

  // ---- 2. Reconcile the rest against the graph (the backstop) -------------
  if (unsettled.size > 0) {
    const statuses = await deps.getTaskStatuses([...unsettled.keys()]);
    for (const [taskId, dispatch] of [...unsettled]) {
      const status = statuses.get(taskId);
      if (status !== undefined && isTerminal(status)) {
        await settle(store, dispatch, "succeeded", "task-status", null, now, advance);
        unsettled.delete(taskId);
        continue;
      }

      // The task is not terminal. Ask the process side whether its child is
      // still working — this is the only way to tell "still going" from
      // "died holding the slot".
      const liveness = dispatch.drivenSessionLocalId
        ? deps.drivenSessionLiveness(dispatch.drivenSessionLocalId)
        : "unknown";

      if (liveness === "crashed") {
        await settle(
          store,
          dispatch,
          "failed",
          "session-exit",
          "driven session crashed before the task reached a terminal status",
          now,
          advance
        );
        unsettled.delete(taskId);
      } else if (liveness === "exited") {
        // Exited cleanly, task still open. Neither a success nor a crash —
        // this is the case mt#4571 SC10 is about, and it is invisible from
        // either signal alone.
        await settle(
          store,
          dispatch,
          "stranded",
          "session-exit",
          `driven session exited with the task still in status ${status ?? "unknown"}`,
          now,
          advance
        );
        unsettled.delete(taskId);
      }
      // "live" keeps the slot. "unknown" ALSO keeps it: a daemon restart
      // erases in-memory knowledge of a child it started, and treating that as
      // an exit would strand every dispatch across every restart — precisely
      // what this feature has to survive.
    }
  }

  // ---- 3. Recompute the frontier -----------------------------------------
  const frontier = await deps.computeFrontier(supervision.umbrellaTaskId, supervision.statusFilter);
  const alreadyDispatched = await store.listDispatchedTaskIds(supervision.id);
  const candidates = frontier.dispatchable.filter((c) => !alreadyDispatched.has(c.taskId));

  // ---- 4. Dispatch up to the free WIP slots -------------------------------
  const stillInFlight = unsettled.size;
  const freeSlots = supervision.wipLimit - stillInFlight;

  if (candidates.length === 0) {
    advance.holdReason =
      frontier.total === 0
        ? HOLD_FRONTIER_EMPTY
        : frontier.dispatchable.length === 0
          ? HOLD_ALL_BLOCKED
          : HOLD_ALREADY_DISPATCHED;
  } else if (freeSlots <= 0) {
    // Refuse with the reason stated rather than queue (mt#4571 SC7). A queue
    // would need its own durability and its own draining, and the frontier is
    // recomputed every tick anyway — the work is not lost, it is simply picked
    // up when a slot frees.
    advance.holdReason = HOLD_WIP_LIMIT;
  } else {
    for (const candidate of candidates.slice(0, freeSlots)) {
      try {
        const result = await deps.dispatchChild({
          taskId: candidate.taskId,
          model: supervision.model,
          umbrellaTaskId: supervision.umbrellaTaskId,
        });
        await store.recordDispatch({
          supervisionId: supervision.id,
          taskId: candidate.taskId,
          drivenSessionLocalId: result.drivenSessionLocalId,
          minskySessionId: result.minskySessionId,
        });
        advance.dispatched.push(candidate.taskId);
      } catch (err) {
        // One child failing to start must not abandon the rest of the frontier.
        const message = err instanceof Error ? err.message : String(err);
        deps.logWarn(
          `[supervision] ${supervision.umbrellaTaskId}: failed to dispatch ${candidate.taskId}: ${message}`
        );
        advance.error = advance.error ?? message;
      }
    }
  }

  // ---- 5. Completion + clocks --------------------------------------------
  const movedSomething = advance.dispatched.length > 0 || advance.settled.length > 0;
  // Complete only when there is genuinely nothing left: no child in flight, and
  // no child of the umbrella still in a dispatchable status. `frontier.total`
  // counts children that PASSED the status filter, so a fully-merged umbrella
  // reports zero.
  advance.completed =
    stillInFlight === 0 && frontier.total === 0 && advance.dispatched.length === 0;

  await store.updateSupervision({
    supervisionId: supervision.id,
    ...(advance.completed ? { status: "completed" as const } : {}),
    ...(watermark !== supervision.eventsWatermark ? { eventsWatermark: watermark } : {}),
    lastTickAt: now,
    ...(movedSomething ? { lastAdvanceAt: now } : {}),
    lastHoldReason: advance.holdReason,
  });

  return advance;
}

/** Persist one settlement and record it on the advance. */
async function settle(
  store: SupervisionTickDeps["store"],
  dispatch: DispatchView,
  status: "succeeded" | "failed" | "stranded",
  settledBy: SettledBy,
  lastError: string | null,
  at: Date,
  advance: SupervisionAdvance
): Promise<void> {
  await store.settleDispatch({ dispatchId: dispatch.id, status, settledBy, lastError, at });
  advance.settled.push({ taskId: dispatch.taskId, status, settledBy });
}

/**
 * One sweeper tick: every active supervision, each under its own lock.
 *
 * A supervision whose pass throws is recorded and skipped; the others still run.
 * The returned `ok` is false in that case, which is what the sweeper reports as
 * its {@link SweepTickResult} — a blanket `ok: true` would make a supervisor
 * that is failing every pass indistinguishable from one with nothing to do.
 */
export async function runSupervisionTick(
  deps: SupervisionTickDeps
): Promise<SupervisionTickResult> {
  const supervisions = await deps.store.listActiveSupervisions();
  const advances: SupervisionAdvance[] = [];
  let ok = true;

  for (const supervision of supervisions) {
    try {
      const result = await deps.store.withSupervisionLock(supervision.id, () =>
        runSupervisionPass(supervision, deps)
      );
      if (result === null) {
        // Another actuator holds it. Not an error and not a stall — say so
        // explicitly rather than emitting a silent no-op.
        advances.push({
          supervisionId: supervision.id,
          umbrellaTaskId: supervision.umbrellaTaskId,
          lockAcquired: false,
          dispatched: [],
          settled: [],
          holdReason: "lock-held-elsewhere",
          completed: false,
          error: null,
        });
        continue;
      }
      advances.push(result);
      if (result.error !== null) ok = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logWarn(`[supervision] ${supervision.umbrellaTaskId}: tick failed: ${message}`);
      await deps.store
        .updateSupervision({
          supervisionId: supervision.id,
          lastTickAt: deps.now(),
          lastError: message,
        })
        .catch(() => {
          // The tick already failed; a failure to record that must not mask it.
        });
      advances.push({
        supervisionId: supervision.id,
        umbrellaTaskId: supervision.umbrellaTaskId,
        lockAcquired: true,
        dispatched: [],
        settled: [],
        holdReason: null,
        completed: false,
        error: message,
      });
      ok = false;
    }
  }

  return { supervisionsConsidered: supervisions.length, advances, ok };
}
