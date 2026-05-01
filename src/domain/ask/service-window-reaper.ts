/**
 * Service-window Reaper — mt#1490.
 *
 * The Reaper bridges service-window events to Ask lifecycle transitions.
 * It is the runtime arm of the mt#1411 service-window primitive:
 *
 *   1. On `minsky.attention_window_opened` NOTIFY:
 *      - Queries `pendingAsksForWindow(windowKey)` for eligible Asks.
 *      - Transitions matching Asks from `suspended` → `routed`.
 *      - Dispatches each via its resolved transport (records the dispatch).
 *
 *   2. Periodic deadline-bound poll (default 60s tick):
 *      - Finds all `suspended` deadline-bound Asks.
 *      - Dispatches those whose deadline is within PAGE_THRESHOLD_MS.
 *
 *   3. On `minsky.attention_window_closed` NOTIFY:
 *      - Increments `windowMissedCount` for each Ask still in the closed cohort.
 *      - If `windowMissedCount >= window.maxMisses` (and maxMisses !== -1):
 *        sets `forceImmediate=true` and dispatches via escalation transport.
 *      - Emits a close-summary payload (servedCount, reBatchedCount,
 *        escalatedCount, droppedCount).
 *
 *   4. Idempotent on restart:
 *      - Re-evaluates all suspended Asks on startup.
 *      - Dispatch deduplication is the caller's responsibility (transport
 *        adapters must be idempotent per their own contracts).
 *
 * The Reaper does NOT manage Postgres LISTEN/NOTIFY connections directly.
 * Instead it exposes an `onWindowOpened` / `onWindowClosed` method pair that
 * the infrastructure layer (e.g. a Postgres LISTEN subscriber) calls. This
 * keeps the domain logic testable without a live database.
 *
 * Reference: ADR draft Notion `352937f03cb481669ab9c57be181d5b8`, mt#1490.
 */

import { log } from "../../utils/logger";
import type { Ask } from "./types";
import type { AskRepository } from "./repository";
import type { AttentionWindowConfig } from "./attention-windows/config";
import type {
  WindowOpenedPayload,
  WindowClosedPayload,
  WindowClosedSummary,
} from "./attention-windows/notify";
import { pendingAsksForWindow } from "./pending-asks-for-window";
import { PAGE_THRESHOLD_MS } from "./router";
import type { ForceImmediateCounterStore } from "./force-immediate-counters";
import { InMemoryForceImmediateCounterStore } from "./force-immediate-counters";

// ---------------------------------------------------------------------------
// Dispatch callback interface
// ---------------------------------------------------------------------------

/**
 * Callback invoked when the Reaper decides to dispatch a suspended Ask.
 *
 * The Reaper itself does not know about specific transport implementations
 * (inbox, subagent, mesh, etc.) — those are separate child tasks. Instead,
 * it calls this callback so the transport layer can handle the actual
 * delivery. The callback receives the transititioned (routed) Ask.
 *
 * @param ask     The Ask after the `suspended → routed` transition.
 * @param reason  Human-readable reason for the dispatch (for logging/audit).
 */
export type AskDispatchCallback = (ask: Ask, reason: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Reaper configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the service-window Reaper.
 */
export interface ReaperConfig {
  /**
   * Interval in milliseconds for the deadline-bound polling loop.
   * Default: 60_000 (60 seconds).
   */
  pollIntervalMs?: number;

  /**
   * Window configurations keyed by `windowKey`.
   * The Reaper needs these to look up `maxMisses` on close events.
   * When absent, missed-window escalation is disabled (safe default for tests).
   */
  windowConfigs?: AttentionWindowConfig[];
}

// ---------------------------------------------------------------------------
// Reaper service
// ---------------------------------------------------------------------------

/**
 * The Service-Window Reaper.
 *
 * Wires together the Ask repository, dispatch callback, and window event
 * handlers. Designed for dependency injection — all external I/O is
 * injected so unit tests can drive the Reaper without a live database or
 * Postgres NOTIFY connection.
 *
 * @example
 *   const reaper = new ServiceWindowReaper(
 *     repo,
 *     async (ask, reason) => { await inboxTransport.dispatch(ask); },
 *     { windowConfigs: loadedWindows }
 *   );
 *
 *   // Wire to Postgres LISTEN:
 *   pgClient.on("notification", async (n) => {
 *     if (n.channel === "minsky.attention_window_opened") {
 *       await reaper.onWindowOpened(JSON.parse(n.payload));
 *     } else if (n.channel === "minsky.attention_window_closed") {
 *       await reaper.onWindowClosed(JSON.parse(n.payload));
 *     }
 *   });
 *
 *   // Start the deadline poll loop:
 *   reaper.startDeadlinePoll();
 */
export class ServiceWindowReaper {
  private readonly repo: AskRepository;
  private readonly dispatch: AskDispatchCallback;
  private readonly pollIntervalMs: number;
  private readonly windowConfigs: Map<string, AttentionWindowConfig>;
  private readonly counterStore: ForceImmediateCounterStore;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    repo: AskRepository,
    dispatch: AskDispatchCallback,
    config: ReaperConfig = {},
    counterStore?: ForceImmediateCounterStore
  ) {
    this.repo = repo;
    this.dispatch = dispatch;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.windowConfigs = new Map((config.windowConfigs ?? []).map((w) => [w.key, w]));
    this.counterStore = counterStore ?? new InMemoryForceImmediateCounterStore();
  }

  // -------------------------------------------------------------------------
  // Window-open handler
  // -------------------------------------------------------------------------

  /**
   * Handle a `minsky.attention_window_opened` event.
   *
   * Queries pending Asks for the opening window, transitions each from
   * `suspended → routed`, and invokes the dispatch callback.
   *
   * Idempotent: if an Ask has already been transitioned (e.g. due to a
   * reaper restart), the state-machine guard in `repo.transition` will
   * throw `InvalidAskTransitionError`; we catch and log it rather than
   * failing the entire batch.
   */
  async onWindowOpened(payload: WindowOpenedPayload): Promise<void> {
    const { windowKey } = payload;
    const nowMs = Date.now();

    log.debug("reaper: window opened", { windowKey });

    const eligible = await pendingAsksForWindow(this.repo, windowKey, nowMs);
    log.debug("reaper: eligible asks for window", {
      windowKey,
      count: eligible.length,
      ids: eligible.map((a) => a.id),
    });

    let dispatched = 0;
    for (const ask of eligible) {
      try {
        const transitioned = await this.transitionToRouted(ask.id);
        if (transitioned) {
          await this.dispatch(transitioned, `window opened: ${windowKey}`);
          dispatched++;
        }
      } catch (err) {
        // Log and continue — one failing Ask should not block the batch.
        log.warn("reaper: failed to dispatch ask on window open", {
          askId: ask.id,
          windowKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("reaper: window-open dispatch complete", {
      windowKey,
      eligible: eligible.length,
      dispatched,
    });
  }

  // -------------------------------------------------------------------------
  // Window-close handler
  // -------------------------------------------------------------------------

  /**
   * Handle a `minsky.attention_window_closed` event.
   *
   * For each Ask that was in the closed window's cohort and is still
   * `suspended` (operator did not respond during the window), increments
   * `windowMissedCount`. If the count meets or exceeds `window.maxMisses`
   * (and maxMisses is not -1), forces immediate dispatch via escalation.
   *
   * Returns a close-summary payload (for logging and downstream consumption
   * by Cockpit mt#1147).
   */
  async onWindowClosed(payload: WindowClosedPayload): Promise<WindowClosedSummary> {
    const { windowKey } = payload;
    const nowMs = Date.now();

    log.debug("reaper: window closed", { windowKey });

    // Re-query the cohort — anything still suspended that targets this window.
    const cohort = await pendingAsksForWindow(this.repo, windowKey, nowMs);
    const stillSuspended = cohort.filter((a) => a.state === "suspended");

    const windowConfig = this.windowConfigs.get(windowKey);
    const maxMisses = windowConfig?.maxMisses ?? -1; // -1 = never escalate

    let servedCount = 0;
    let reBatchedCount = 0;
    let escalatedCount = 0;
    const droppedCount = 0; // v1: no drop logic

    for (const ask of stillSuspended) {
      const newMissCount = (ask.windowMissedCount ?? 0) + 1;

      if (maxMisses !== -1 && newMissCount >= maxMisses) {
        // Escalate: force immediate dispatch.
        try {
          const escalated = await this.escalateAsk(ask.id, newMissCount);
          if (escalated) {
            await this.dispatch(
              escalated,
              `missed-window escalation: ${windowKey} (miss #${newMissCount})`
            );
            escalatedCount++;
            log.info("reaper: escalated ask after max misses", {
              askId: ask.id,
              windowKey,
              missCount: newMissCount,
              maxMisses,
            });
          }
        } catch (err) {
          log.warn("reaper: failed to escalate ask", {
            askId: ask.id,
            windowKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Re-batch: keep suspended, just increment miss count.
        try {
          await this.incrementMissCount(ask.id, newMissCount);
          reBatchedCount++;
          log.debug("reaper: re-batched ask for next window", {
            askId: ask.id,
            windowKey,
            missCount: newMissCount,
          });
        } catch (err) {
          log.warn("reaper: failed to increment miss count", {
            askId: ask.id,
            windowKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // "served" = asks that were dispatched when the window opened (not still suspended).
    servedCount = cohort.length - stillSuspended.length;

    const summary: WindowClosedSummary = {
      servedCount,
      reBatchedCount,
      escalatedCount,
      droppedCount,
    };

    log.info("reaper: window-close summary", { windowKey, ...summary });

    return summary;
  }

  // -------------------------------------------------------------------------
  // Deadline-bound poll
  // -------------------------------------------------------------------------

  /**
   * Perform a single deadline-bound poll pass.
   *
   * Finds all suspended `deadline-bound` Asks whose deadline is within
   * PAGE_THRESHOLD_MS, transitions them to `routed`, and dispatches.
   *
   * Called by the periodic timer started by `startDeadlinePoll`.
   * Also safe to call manually in tests or on startup for idempotent recovery.
   */
  async pollDeadlineBoundAsks(nowMs: number = Date.now()): Promise<number> {
    const suspended = await this.repo.listByState("suspended");

    const urgent = suspended.filter((ask) => {
      if ((ask.serviceStrategy ?? "asap") !== "deadline-bound") return false;
      const deadline = ask.deadline ? new Date(ask.deadline).getTime() : null;
      return deadline !== null && deadline - nowMs <= PAGE_THRESHOLD_MS;
    });

    let dispatched = 0;
    for (const ask of urgent) {
      try {
        const transitioned = await this.transitionToRouted(ask.id);
        if (transitioned) {
          await this.dispatch(transitioned, "deadline-bound poll: within page-threshold");
          dispatched++;
        }
      } catch (err) {
        log.warn("reaper: deadline poll dispatch failed", {
          askId: ask.id,
          deadline: ask.deadline,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (dispatched > 0) {
      log.info("reaper: deadline poll dispatched asks", { dispatched });
    }

    return dispatched;
  }

  /**
   * Startup sweep: re-evaluate all suspended Asks for idempotent recovery.
   *
   * On reaper restart, some Asks may have been in an eligible state before
   * the crash. This pass runs `pollDeadlineBoundAsks` once and can be
   * extended to replay recent window-open events.
   *
   * The caller should await this before starting the poll timer if strict
   * recovery semantics are needed.
   *
   * @param nowMs  Current timestamp (injectable for tests; defaults to Date.now()).
   */
  async startupSweep(nowMs: number = Date.now()): Promise<void> {
    log.info("reaper: startup sweep");
    await this.pollDeadlineBoundAsks(nowMs);
  }

  /**
   * Start the periodic deadline-bound poll loop.
   *
   * Idempotent: calling this twice on the same instance has no effect.
   * Call `stopDeadlinePoll` to tear down the timer (e.g. in tests or on
   * graceful shutdown).
   */
  startDeadlinePoll(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      this.pollDeadlineBoundAsks().catch((err) => {
        log.warn("reaper: deadline poll error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.pollIntervalMs);
  }

  /** Stop the periodic deadline-bound poll loop. */
  stopDeadlinePoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Transition an Ask from its current state to `"routed"`.
   *
   * Returns the transitioned Ask on success, or `null` if the Ask is no
   * longer in a transitionable state (idempotent guard).
   */
  private async transitionToRouted(id: string): Promise<Ask | null> {
    const ask = await this.repo.getById(id);
    if (!ask) {
      log.warn("reaper: ask not found during dispatch", { askId: id });
      return null;
    }

    // Only transition from suspended (or routed — already dispatched).
    if (ask.state === "routed") {
      log.debug("reaper: ask already routed, skipping", { askId: id });
      return null;
    }

    if (ask.state !== "suspended") {
      log.debug("reaper: ask in unexpected state, skipping", {
        askId: id,
        state: ask.state,
      });
      return null;
    }

    // Transition suspended → routed (added to state-machine by mt#1490).
    // Window-deferred Asks are placed in "suspended" by the router's Phase 3;
    // the reaper wakes them up by transitioning back to "routed" so the
    // transport adapter can dispatch them.
    try {
      const transitioned = await this.repo.transition(id, "routed");
      return transitioned;
    } catch (err) {
      // InvalidAskTransitionError means the ask was already moved by another
      // actor — treat as idempotent and skip.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Invalid Ask transition")) {
        log.debug("reaper: ask transition rejected (concurrent actor), skipping", {
          askId: id,
          error: msg,
        });
        return null;
      }
      throw err;
    }
  }

  /**
   * Force-escalate an Ask by setting `forceImmediate=true` and transitioning
   * to `"routed"`.
   *
   * Because the repository interface doesn't have a `setForceImmediate` method
   * at v1, we record the escalation in the counter store and transition.
   * The `forceImmediate` flag is carried in-memory on the returned Ask for
   * the dispatch callback's reference.
   *
   * In a full implementation this would update the DB row; for v1 the counter
   * store serves as the audit trail.
   */
  private async escalateAsk(id: string, newMissCount: number): Promise<Ask | null> {
    const ask = await this.repo.getById(id);
    if (!ask) {
      log.warn("reaper: ask not found during escalation", { askId: id });
      return null;
    }

    // Record in the forceImmediate counter store (anti-pattern audit).
    this.counterStore.record(ask.requestor, new Date().toISOString());

    // Transition to routed with updated miss count reflected in metadata.
    // v1: we don't have a DB-level forceImmediate update path, so we
    // augment the in-memory Ask object before dispatching.
    const transitioned = await this.transitionToRouted(id);
    if (!transitioned) return null;

    // Return an augmented copy with forceImmediate=true and updated miss count.
    return {
      ...transitioned,
      forceImmediate: true,
      windowMissedCount: newMissCount,
    };
  }

  /**
   * Increment the missed-window counter on an Ask.
   *
   * Persists the updated `windowMissedCount` on the Ask row via
   * `repo.updateWindowMissedCount`, and also records the event in the
   * per-requestor counter store for observability.
   */
  private async incrementMissCount(id: string, newMissCount: number): Promise<void> {
    const ask = await this.repo.getById(id);
    if (!ask) return;

    // Persist windowMissedCount on the DB row.
    await this.repo.updateWindowMissedCount(id, newMissCount);

    // Record in counter store for observability.
    this.counterStore.record(`window-miss:${ask.requestor}`, new Date().toISOString());

    log.debug("reaper: miss count incremented", {
      askId: id,
      newMissCount,
      requestor: ask.requestor,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `ServiceWindowReaper` with the given repository and dispatch callback.
 *
 * Convenience factory for composition code that doesn't need to manage the
 * class directly.
 */
export function createServiceWindowReaper(
  repo: AskRepository,
  dispatch: AskDispatchCallback,
  config: ReaperConfig = {},
  counterStore?: ForceImmediateCounterStore
): ServiceWindowReaper {
  return new ServiceWindowReaper(repo, dispatch, config, counterStore);
}
