/**
 * Cockpit periodic sweepers (mt#2615 — extracted from server.ts).
 *
 * Houses the shared `createIntervalSweeper` factory (with mt#2625's per-tick
 * timeout + watchdog fix baked in) and the concrete periodic sweepers that
 * use it:
 *
 *   - startAskAdvancementSweeper   (mt#2265)
 *   - startStaleAskCloseSweeper    (mt#3001)
 *   - startProdStateRefreshSweeper (mt#2506)
 *   - startTopologySweeper         (mt#2602)
 *   - startTranscriptSweepBackstop (mt#2321)
 *   - startDispatchWatchdogSweeper (mt#2646)
 *   - startDeploySmokeSweeper      (mt#2599)
 *   - startConversationTitleSweeper (mt#3321)
 *
 * These previously duplicated an ~8-line skeleton (running-guard, boot tick,
 * setInterval, clearInterval) with NO protection against a single tick
 * hanging forever — see mt#2625: `startProdStateRefreshSweeper` stalled for
 * 28+ hours on 2026-07-05 because a hung `getRawSqlConnection()` call left
 * the `running` guard permanently `true`, silently starving every later tick.
 */
import { log } from "@minsky/shared/logger";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DEFAULT_SWEEP_INTERVAL_MS } from "@minsky/domain/ask/advancement";
import {
  getServerAskRepository,
  getServerFollowUpService,
  getServerTaskService,
} from "./db-providers";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
import { ProdStateSweepTracker } from "./prod-state-sweep-tracker";
import {
  getSchemaReadiness,
  isSchemaBehind,
  refreshSchemaReadinessFromDb,
} from "./schema-readiness";
import { createPresenceSweepState } from "./conversation-presence-sweep";

// ---------------------------------------------------------------------------
// Shared sweeper timer helper (mt#2602 R1 review) — centralizes the
// `.unref()` guard that was previously duplicated inline across every
// periodic sweeper, so a runtime whose `setInterval` return value doesn't
// expose `.unref()` (or exposes it under a different shape) is handled in
// one place instead of four near-identical inline checks.
// ---------------------------------------------------------------------------

/**
 * Best-effort `.unref()` on a `setInterval` handle so a sweeper alone never
 * holds the process open. Safe no-op when the handle has no callable
 * `unref` (e.g. a non-Node/Bun runtime) rather than throwing.
 */
export function unrefSweeperTimer(id: ReturnType<typeof setInterval>): void {
  if (
    typeof id === "object" &&
    id !== null &&
    "unref" in id &&
    typeof (id as { unref?: unknown }).unref === "function"
  ) {
    (id as { unref: () => void }).unref();
  }
}

// ---------------------------------------------------------------------------
// createIntervalSweeper — shared factory with mt#2625's starvation fix
// ---------------------------------------------------------------------------

/** Default per-tick abandonment timeout when a caller doesn't supply one. */
export const DEFAULT_TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Sweep-liveness registry (mt#2894)
//
// mt#2625's per-tick timeout + watchdog force-release protects against a
// HUNG or THROWING tick killing the loop — but neither can protect against
// the underlying `setInterval` handle itself being dropped/cleared (a wedged
// or lost JS timer). mt#2891's incident evidence (absorbed into mt#2894) shows
// BOTH the prod-state sweep and the dispatch-watchdog sweep stopped attempting
// ticks within ~5 minutes of each other while the daemon process stayed alive —
// pointing at the SHARED scheduling layer, not per-sweep tick logic. This
// registry makes that class of failure OBSERVABLE (via the `/api/sweeps` route,
// see routes/sweeps.ts) and the meta-watchdog below makes it SELF-HEALING.
// ---------------------------------------------------------------------------

/** Reason a sweep's interval was force-restarted — surfaced for observability. */
export type SweepRestartReason = "bounded-reinit" | "meta-watchdog";

/** Per-sweep liveness snapshot exposed via `GET /api/sweeps`. */
export interface SweepLivenessSnapshot {
  /** Human-readable sweep name (matches {@link IntervalSweeperOptions.name}). */
  name: string;
  /** Configured cadence in milliseconds. */
  intervalMs: number;
  /** ISO timestamp of the last time the interval callback fired (fired, not necessarily succeeded), or null if no tick has fired yet. */
  lastAttemptAt: string | null;
  /** ISO timestamp of the last tick that completed without timing out or throwing, or null. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last tick that timed out or threw unexpectedly, or null. */
  lastErrorAt: string | null;
  /** Consecutive failed ticks (timeout or unexpected throw) since the last success. */
  consecutiveFailures: number;
  /** Count of bounded re-inits this sweep triggered on itself (SC "N consecutive tick failures"). */
  reinits: number;
  /** Count of force-restarts the meta-watchdog triggered (dropped/wedged timer class). */
  metaRestarts: number;
  /**
   * ISO timestamp of the last tick that reported its DOMAIN work succeeded, or
   * null when this sweep reports no domain outcome (mt#3684).
   *
   * Separate from `lastSuccessAt`, which answers the SCHEDULING question — did
   * the timer fire and the callback return. The two diverge exactly when a tick
   * applies the fail-open try/catch this factory's `tick` contract asks for: it
   * returns normally, so scheduling is healthy, while its work failed.
   */
  lastDomainSuccessAt: string | null;
  /** ISO timestamp of the last tick that reported its domain work FAILED, or null. */
  lastDomainFailureAt: string | null;
  /** Consecutive reported domain failures since the last reported domain success. */
  consecutiveDomainFailures: number;
  /** False when this sweep has never reported a domain outcome — the three fields above are then meaningless rather than healthy. */
  reportsDomainOutcome: boolean;
}

interface SweepLivenessEntry {
  name: string;
  intervalMs: number;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  consecutiveFailures: number;
  reinits: number;
  metaRestarts: number;
  lastDomainSuccessAtMs: number | null;
  lastDomainFailureAtMs: number | null;
  consecutiveDomainFailures: number;
  reportsDomainOutcome: boolean;
  /**
   * True once this sweep's `stop()` has been called (PR #2019 R1 BLOCKING
   * #1). The entry is deliberately kept in {@link sweepLivenessRegistry}
   * rather than deleted — `restartInterval` and the meta-watchdog both check
   * this flag and refuse to act on a stopped sweep, so the entry stays the
   * single, authoritative, always-inspectable record of "is anything running
   * under this name" instead of a stopped sweep silently vanishing from the
   * registry while a late-arriving async re-init resurrects an UNTRACKED
   * interval. {@link getSweepLivenessSnapshot} filters stopped entries out
   * of the public `/api/sweeps` payload, so callers still see stop() as
   * deregistration — only the internal bookkeeping keeps the record alive.
   */
  stopped: boolean;
  /** Force-restart this sweep's interval. Called by the sweep itself (bounded re-init) or the meta-watchdog. Refuses (no-op) once `stopped` is true. */
  restart: (reason: SweepRestartReason) => void;
  /**
   * TEST-ONLY hook: clear the underlying `setInterval` handle WITHOUT
   * deregistering the sweep or calling its public `stop()` — reproduces the
   * "timer silently dropped while the process stays alive" failure class the
   * meta-watchdog exists to recover from, without needing to kill anything.
   */
  clearUnderlyingTimer: () => void;
}

/** Process-lifetime registry of every sweep created via {@link createIntervalSweeper}. */
const sweepLivenessRegistry = new Map<string, SweepLivenessEntry>();

/** Bounded re-init threshold: N consecutive tick failures triggers a self re-init. */
export const REINIT_FAILURE_THRESHOLD = 3;

/** Default meta-watchdog cadence — how often it scans the registry for stalled sweeps. */
export const DEFAULT_META_WATCHDOG_INTERVAL_MS = 60 * 1000; // 1 minute

/** A sweep is considered stalled once it hasn't ATTEMPTED a tick in this many multiples of its own cadence. */
export const META_WATCHDOG_STALL_MULTIPLIER = 2;

/**
 * Snapshot the current sweep-liveness registry for the `/api/sweeps` route
 * (see `./routes/sweeps.ts`). Read-only; ISO timestamps for JSON transport.
 */
export function getSweepLivenessSnapshot(): SweepLivenessSnapshot[] {
  // A stopped sweep is excluded — /api/sweeps reports what's ACTUALLY
  // running, matching what a caller who saw stop() take effect would
  // expect. The entry itself is retained internally (see SweepLivenessEntry
  // doc comment) so restartInterval/the meta-watchdog can still refuse to
  // resurrect it even from a late-arriving async completion.
  return Array.from(sweepLivenessRegistry.values())
    .filter((e) => !e.stopped)
    .map((e) => ({
      name: e.name,
      intervalMs: e.intervalMs,
      lastAttemptAt: e.lastAttemptAtMs === null ? null : new Date(e.lastAttemptAtMs).toISOString(),
      lastSuccessAt: e.lastSuccessAtMs === null ? null : new Date(e.lastSuccessAtMs).toISOString(),
      lastErrorAt: e.lastErrorAtMs === null ? null : new Date(e.lastErrorAtMs).toISOString(),
      consecutiveFailures: e.consecutiveFailures,
      reinits: e.reinits,
      metaRestarts: e.metaRestarts,
      lastDomainSuccessAt:
        e.lastDomainSuccessAtMs === null ? null : new Date(e.lastDomainSuccessAtMs).toISOString(),
      lastDomainFailureAt:
        e.lastDomainFailureAtMs === null ? null : new Date(e.lastDomainFailureAtMs).toISOString(),
      consecutiveDomainFailures: e.consecutiveDomainFailures,
      reportsDomainOutcome: e.reportsDomainOutcome,
    }));
}

/**
 * TEST-ONLY: simulate the underlying `setInterval` handle being silently
 * dropped/cleared without deregistering the sweep — the exact failure class
 * mt#2891's incident evidence points at (both sweeps stopped ATTEMPTING
 * ticks while the daemon stayed alive). Used by the meta-watchdog regression
 * test in sweepers.test.ts. No-op if `name` isn't currently registered.
 */
export function _simulateDroppedTimerForTest(name: string): void {
  sweepLivenessRegistry.get(name)?.clearUnderlyingTimer();
}

/** TEST-ONLY: clear the registry. Call between test files that assert on registry contents. */
export function _resetSweepLivenessRegistryForTest(): void {
  sweepLivenessRegistry.clear();
}

/**
 * What a tick may report about its own DOMAIN work (mt#3684).
 *
 * The scheduling layer cannot infer this: the `tick` contract asks each sweep
 * to swallow its own errors, so a total domain outage and a clean run are
 * indistinguishable from outside the callback. During the 2026-08-06 incident
 * that produced a `/api/sweeps` entry reading `lastSuccessAt` one minute old
 * and `consecutiveFailures: 0` while every tick had been failing for 13 hours.
 */
export interface SweepTickResult {
  /** False when the tick's work did not succeed, even though it returned normally. */
  ok: boolean;
}

/** Options accepted by {@link createIntervalSweeper}. */
export interface IntervalSweeperOptions {
  /** Human-readable name used in log messages (e.g. "ask advancement"). */
  name: string;
  /** Cadence in milliseconds between ticks. */
  intervalMs: number;
  /**
   * The tick callback — the actual sweep work. Should apply its OWN
   * fail-open try/catch with a domain-specific log message; the factory's
   * own catch (below) is only a last-resort safety net for an unexpected
   * throw escaping it.
   *
   * Because of that contract a tick that handled its own failure still
   * RETURNS NORMALLY, which the scheduling bookkeeping below correctly reads
   * as "the timer fired and the callback returned". To also report whether the
   * WORK succeeded, return a {@link SweepTickResult} (mt#3684). Returning
   * nothing is unchanged behavior and reports no domain outcome at all —
   * which is why adding this did not require touching the other sweeps.
   */
  tick: () => Promise<SweepTickResult | void>;
  /**
   * Per-tick abandonment timeout in milliseconds (mt#2625). A tick that
   * hasn't settled within this window is abandoned: the `running` guard is
   * force-released (via `Promise.race` against an internal timer) so the
   * NEXT scheduled tick can proceed, and a warning is logged. The abandoned
   * tick's underlying promise is NOT cancelled (no AbortSignal threading
   * here) — it may still complete and log its own outcome later; releasing
   * the guard early is what prevents PERMANENT starvation of every future
   * tick, which is the mt#2625 failure mode. Defaults to
   * {@link DEFAULT_TICK_TIMEOUT_MS}.
   *
   * The SAME value also serves as the watchdog invariant threshold: if a
   * scheduled tick attempt finds the guard already held for longer than
   * this value, it force-releases and logs loudly even if (for whatever
   * reason) the primary `Promise.race` path above did not already do so.
   * This is deliberately NOT derived from `intervalMs` — sweepers may be
   * scheduled at intervals far shorter than any sane hang-detection window
   * (e.g. tests), and tying the timeout to the interval would make the
   * overlap-skip guard indistinguishable from a hang.
   */
  tickTimeoutMs?: number;
}

/**
 * Build a periodic sweeper: boot tick + `setInterval` cadence, an
 * overlap-skip guard, a bounded per-tick timeout, and a watchdog invariant
 * (mt#2625) so a single hung tick can never starve every later tick forever.
 *
 * @returns stop function (clears the interval).
 */
export function createIntervalSweeper(options: IntervalSweeperOptions): () => void {
  const { name, intervalMs, tick } = options;
  const tickTimeoutMs = options.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;

  let running = false;
  let runningSinceMs: number | null = null;
  let id: ReturnType<typeof setInterval> | null = null;
  // Authoritative "this sweep has been stopped" flag (PR #2019 R1 BLOCKING
  // #1). Mirrored onto `entry.stopped` below, but also held here in the
  // closure so `runTick`/`restartInterval` can check it even in the window
  // where they're executing on a captured `entry` reference — belt-and-
  // braces against any future refactor that stops mirroring the two.
  let stopped = false;

  // Duplicate-registration guard (PR #2019 R1 BLOCKING #2). Each concrete
  // sweeper name is fixed and unique by convention (one literal string per
  // `start*Sweeper` call site) — an ACTIVE duplicate is always a bug: the
  // second `.set(name, entry)` would silently overwrite the registry's
  // reference to the FIRST sweep, leaving its `setInterval` running with no
  // `/api/sweeps` visibility and no meta-watchdog reach (untracked-running,
  // the same failure shape BLOCKING #1 fixes for the stop() race). Re-
  // registering the SAME name after a clean `stop()` is legitimate (e.g. a
  // future restart-from-scratch call site) and is allowed — the stopped
  // entry is simply replaced.
  const existingActive = sweepLivenessRegistry.get(name);
  if (existingActive && !existingActive.stopped) {
    throw new Error(
      `cockpit: duplicate active sweep registration for "${name}" — a sweep with this name is ` +
        "already registered and running. createIntervalSweeper names must be unique among " +
        "active sweeps (call the existing sweep's stop() first if this is an intentional restart)."
    );
  }

  // Sweep-liveness registry entry (mt#2894) — registered synchronously so
  // it's visible on `/api/sweeps` even before the boot tick's promise settles.
  // `restart`/`clearUnderlyingTimer` are wired below once `restartInterval`/
  // `startInterval` exist; the placeholders here are never reachable in
  // practice (nothing calls them until after the real wiring below runs).
  const entry: SweepLivenessEntry = {
    name,
    intervalMs,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    consecutiveFailures: 0,
    reinits: 0,
    metaRestarts: 0,
    lastDomainSuccessAtMs: null,
    lastDomainFailureAtMs: null,
    consecutiveDomainFailures: 0,
    reportsDomainOutcome: false,
    stopped: false,
    restart: () => {},
    clearUnderlyingTimer: () => {
      if (id !== null) clearInterval(id);
    },
  };
  sweepLivenessRegistry.set(name, entry);

  const runTick = async (): Promise<void> => {
    // mt#2894 R1 BLOCKING #1: a tick already in flight when stop() fires
    // must not touch the (retired) entry or trigger a re-init once it
    // resumes. Checked again below, after the tick settles, for the same
    // reason — stop() can land at any point during the await.
    if (stopped) return;

    // Liveness (mt#2894): record every time the interval callback FIRES,
    // regardless of overlap-skip/timeout/success below — this is what lets
    // the meta-watchdog distinguish "timer still alive, tick logic stuck" (an
    // existing case per-tick isolation already handles) from "timer itself
    // stopped firing" (the class this task's meta-watchdog adds recovery for).
    entry.lastAttemptAtMs = Date.now();

    // Watchdog (mt#2625): if a PRIOR tick has been "running" longer than
    // tickTimeoutMs, the per-tick timeout below should already have released
    // it. This is the fail-safe for the (unexpected) case where it somehow
    // didn't — force-release so this and future ticks can proceed, and log
    // loudly so the stall is observable instead of silent.
    if (running && runningSinceMs !== null) {
      const heldForMs = Date.now() - runningSinceMs;
      if (heldForMs > tickTimeoutMs) {
        log.warn(
          `cockpit: ${name} sweep watchdog — guard held ${heldForMs}ms (> ${tickTimeoutMs}ms); force-releasing`,
          {
            heldForMs,
            tickTimeoutMs,
          }
        );
        running = false;
        runningSinceMs = null;
      }
    }

    if (running) return; // Overlapping tick — skip (pre-existing behavior).
    running = true;
    runningSinceMs = Date.now();

    // Per-tick timeout (mt#2625): race the real tick against a timer so a
    // hung dependency (DB call, subprocess, etc.) can never wedge the guard
    // forever.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed-out"), tickTimeoutMs);
    });

    let failed = false;
    // null = this tick reported no domain outcome (the pre-mt#3684 behavior of
    // every sweep, and still the behavior of any tick returning nothing).
    let domainOk: boolean | null = null;
    try {
      const outcome = await Promise.race([
        tick().then((result) => {
          if (result && typeof result.ok === "boolean") domainOk = result.ok;
          return "completed" as const;
        }),
        timedOut,
      ]);
      if (outcome === "timed-out") {
        log.warn(
          `cockpit: ${name} sweep tick timed out after ${tickTimeoutMs}ms — releasing guard for next tick`,
          {
            tickTimeoutMs,
          }
        );
        failed = true;
      }
    } catch (err) {
      // Last-resort safety net — the tick callback is expected to apply its
      // own fail-open try/catch; this only fires on an unexpected throw
      // escaping it.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`cockpit: ${name} sweep tick threw unexpectedly`, { message });
      failed = true;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      running = false;
      runningSinceMs = null;
    }

    // mt#2894 R1 BLOCKING #1: re-check after the await — stop() may have
    // fired while the tick was in flight. A retired entry must not be
    // bookkept further, and a trailing failure must never trigger a re-init.
    if (stopped) return;

    // Domain outcome (mt#3684), recorded BESIDE the scheduling fields below
    // and never folded into them. mt#2894 deliberately scoped this registry to
    // the scheduling layer and deferred domain outcome to "the per-sweep
    // trackers (TranscriptSweepTracker etc.)" — that separation is kept, but
    // its premise did not hold: only 3 of the 11 sweeps have such a tracker,
    // and prod-state's sits inside a call its failing paths never reach. So a
    // tick may now report its own outcome, and a reader sees the scheduling
    // and domain answers as two fields instead of inferring one from the other.
    //
    // Deliberately NOT counted toward REINIT_FAILURE_THRESHOLD: re-init is a
    // recovery for a wedged TICK, and mt#3682 established that restarting the
    // interval is a no-op against a failure below the sweep. Restarting the
    // timer because the database is unreachable is the churn mt#3826 exists to
    // stop. Domain failures are reported, not acted on.
    if (domainOk !== null) {
      entry.reportsDomainOutcome = true;
      if (domainOk) {
        entry.lastDomainSuccessAtMs = Date.now();
        entry.consecutiveDomainFailures = 0;
      } else {
        entry.lastDomainFailureAtMs = Date.now();
        entry.consecutiveDomainFailures++;
      }
    }

    // Liveness bookkeeping + bounded re-init (mt#2894 SC "(c)"). A tick only
    // reaches here via the timeout or unexpected-throw paths above (the tick
    // callback's OWN fail-open try/catch means a domain failure it already
    // handled internally still resolves "completed" here — intentional; this
    // registry tracks the SCHEDULING layer's health, which is a different
    // question from the domain outcome recorded just above).
    if (failed) {
      entry.lastErrorAtMs = Date.now();
      entry.consecutiveFailures++;
      if (entry.consecutiveFailures >= REINIT_FAILURE_THRESHOLD) {
        log.warn(
          `cockpit: ${name} sweep — ${entry.consecutiveFailures} consecutive tick failures; attempting bounded re-init`,
          { consecutiveFailures: entry.consecutiveFailures }
        );
        entry.consecutiveFailures = 0;
        restartInterval("bounded-reinit");
      }
    } else {
      entry.lastSuccessAtMs = Date.now();
      entry.consecutiveFailures = 0;
    }
  };

  const startInterval = (): void => {
    id = setInterval(() => void runTick(), intervalMs);
    unrefSweeperTimer(id);
  };

  /**
   * Force-restart this sweep's interval (mt#2894). Used both for the bounded
   * re-init above (self-triggered, persistent tick failures) and by the
   * meta-watchdog (externally triggered, dropped/wedged timer — the class
   * per-tick isolation structurally cannot cover since the interval callback
   * never fires again to isolate anything). Clears any existing handle first
   * so this is safe to call even if the timer already stopped firing.
   *
   * mt#2894 R1 BLOCKING #1: refuses (no-op) once `stopped` is true — this is
   * what makes stop() authoritative against a LATE bounded-re-init trigger
   * from a tick that was already in flight when stop() was called (the
   * `stopped` check inside `runTick` prevents most such calls from ever
   * reaching here, but this is the last line of defense for the restart
   * mechanism itself, and it's what the meta-watchdog's restart call also
   * goes through).
   *
   * mt#3060: MUST fire an immediate tick (mirroring the boot sequence's
   * `void runTick(); startInterval();`), not just re-arm the timer. Without
   * this, a restart only schedules the NEXT natural tick `intervalMs` in the
   * future — and for every real sweep, `intervalMs` (minutes) is far larger
   * than the meta-watchdog's own scan cadence (`DEFAULT_META_WATCHDOG_INTERVAL_MS`,
   * 60s). Since a re-armed-but-not-yet-fired interval never advances
   * `entry.lastAttemptAtMs`, the NEXT watchdog scan (60s later) still sees a
   * stale sweep and force-restarts AGAIN — clearing the freshly-armed
   * interval before its own cadence ever elapses. That produces an infinite
   * "restart storm": force-restarting is logged every scan, `staleMs` never
   * resets, and no domain tick ever actually runs — exactly the runtime-log
   * signature from the 2026-07-22 incident (mt#3051/mt#3060). Firing the
   * tick here breaks the storm: `entry.lastAttemptAtMs` is stamped at the
   * TOP of `runTick`, before any guard, so even a single successful restart
   * resets staleness immediately, regardless of how long the DOMAIN tick
   * itself takes to complete.
   */
  const restartInterval = (reason: SweepRestartReason): void => {
    if (stopped) return;
    if (id !== null) {
      clearInterval(id);
      id = null;
    }
    if (reason === "meta-watchdog") {
      entry.metaRestarts++;
    } else {
      entry.reinits++;
    }
    startInterval();
    // mt#3060: see the doc comment above — a restart that doesn't ALSO fire
    // an immediate tick can never outrun a watchdog scanning faster than
    // this sweep's own cadence.
    void runTick();
  };
  entry.restart = restartInterval;

  void runTick();
  startInterval();

  return () => {
    // mt#2894 R1 BLOCKING #1: stop() is now authoritative. Setting `stopped`
    // BEFORE clearing the interval closes the resurrection window — any
    // tick already in flight (and any bounded-reinit/meta-watchdog restart
    // attempt racing this call) sees `stopped === true` and refuses to act.
    // The entry is retained in the registry (marked `stopped`, filtered out
    // of the public snapshot) rather than deleted — see SweepLivenessEntry's
    // doc comment for why keeping it is what makes the guard reliable.
    stopped = true;
    entry.stopped = true;
    if (id !== null) {
      clearInterval(id);
      id = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Sweep meta-watchdog ("sweep of sweeps") — mt#2894
// ---------------------------------------------------------------------------

/**
 * Start the meta-watchdog: a periodic scan of the sweep-liveness registry
 * that force-restarts any registered sweep whose interval has stopped
 * ATTEMPTING ticks (`lastAttemptAt` stale by more than
 * {@link META_WATCHDOG_STALL_MULTIPLIER} times its own cadence).
 *
 * Deliberately scheduled on a self-rescheduling `setTimeout` CHAIN — a
 * DIFFERENT timer primitive than every sweep's `setInterval` — rather than
 * its own `setInterval`. The failure class this recovers from (mt#2891's
 * incident evidence: two independent sweeps stopped attempting ticks within
 * ~5 minutes of each other while the daemon stayed alive) implicates the
 * shared interval-scheduling layer; sharing that same primitive for the
 * watchdog itself would risk it dying alongside the thing it's meant to
 * detect. A `setTimeout` chain re-arms itself only after each check
 * completes, so it can never overlap itself the way a `setInterval` could
 * under a slow tick.
 *
 * Per the Plan decision's Covers/Does NOT cover enumeration: this does NOT
 * protect against the meta-watchdog's OWN `setTimeout` chain dying (total
 * timer death) — that residual is covered honestly, not silently, by the
 * `/api/sweeps` liveness surface plus the existing consumer-side staleness
 * banners (inject-prod-state.ts / inject-dispatch-watchdog.ts), with
 * recovery falling to tray/operator supervision (mt#2786).
 *
 * @returns stop function (clears the pending timeout, if any).
 */
export function startSweepMetaWatchdog(
  intervalMs: number = DEFAULT_META_WATCHDOG_INTERVAL_MS
): () => void {
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    handle = setTimeout(runCheck, intervalMs);
    unrefSweeperTimer(handle);
  };

  const runCheck = (): void => {
    if (stopped) return;
    const now = Date.now();
    for (const entry of sweepLivenessRegistry.values()) {
      // mt#2894 R1 BLOCKING #1: never restart a sweep that was cleanly
      // stopped — its entry stays in the registry (see SweepLivenessEntry's
      // doc comment) but is retired, not actionable. `entry.restart` itself
      // also refuses once stopped; this explicit skip keeps the intent
      // legible at the call site the finding named.
      if (entry.stopped) continue;
      // No tick has fired yet (e.g. the sweep just registered and its boot
      // tick's microtask hasn't run) — nothing to evaluate yet.
      if (entry.lastAttemptAtMs === null) continue;
      const threshold = entry.intervalMs * META_WATCHDOG_STALL_MULTIPLIER;
      const staleMs = now - entry.lastAttemptAtMs;
      if (staleMs > threshold) {
        log.warn(
          `cockpit: meta-watchdog — sweep "${entry.name}" has not attempted a tick in ${staleMs}ms ` +
            `(> ${threshold}ms, ${META_WATCHDOG_STALL_MULTIPLIER}x its ${entry.intervalMs}ms cadence); ` +
            "force-restarting",
          { name: entry.name, staleMs, threshold, intervalMs: entry.intervalMs }
        );
        entry.restart("meta-watchdog");
      }
    }
    scheduleNext();
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (handle) clearTimeout(handle);
  };
}

// ---------------------------------------------------------------------------
// Ask advancement sweeper (mt#2265)
// ---------------------------------------------------------------------------

/**
 * Start the periodic ask-advancement sweep in this cockpit process.
 *
 * Advances `detected` asks the create path missed (emission-callsite rows,
 * rows from crashed processes) and expires stale ones, so the operator
 * surface reflects reality without a manual probe. Runs one pass at boot,
 * then every `intervalMs` (sweeper-not-queue per decision-defaults
 * §Reliability; the asks table is the single source of truth).
 *
 * Fail-open: a failed pass logs and waits for the next tick — the sweep
 * must never crash the cockpit. Overlapping ticks are skipped.
 *
 * @returns stop function (clears the interval).
 */
export function startAskAdvancementSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "ask advancement",
    intervalMs: intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const repo = await getServerAskRepository();
        if (!repo) return;
        const { runAskAdvancementSweep } = await import("@minsky/domain/ask/advancement");
        await runAskAdvancementSweep(repo);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: ask advancement sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Stale-suspended-ask close sweeper (mt#3001)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the stale-ask close sweep. Staleness is a day-scale
 * signal (parent tasks finish, TTLs are 7 days), so a 15-minute pass keeps
 * the operator inbox clean without re-listing tasks every advancement tick.
 */
const STALE_ASK_CLOSE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Start the periodic stale-suspended-ask close sweep in this cockpit process
 * (mt#3001).
 *
 * The recurring reconciliation layer over `suspended` asks: closes
 * `authorization.approve` / `quality.review` asks whose parent task has since
 * reached a terminal status, closes failed-commit orphans superseded by a
 * later landed commit from the same session, and expires commit-auth asks
 * older than the TTL. Sweeper-not-event per decision-defaults §Reliability —
 * this pass catches everything the mt#2593 same-call closes structurally
 * cannot (crashed processes, gh# parents, debris between one-time sweeps).
 *
 * Fail-open: a missing task service or a failed task listing degrades to an
 * empty status map (parent-terminal closes nothing; supersession and TTL
 * still apply); a failed pass logs and waits for the next tick.
 *
 * @returns stop function (clears the interval).
 */
export function startStaleAskCloseSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "stale-ask close",
    intervalMs: intervalMs ?? STALE_ASK_CLOSE_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const repo = await getServerAskRepository();
        if (!repo) return;
        const { runStaleSuspendedAskCloseSweep } = await import(
          "@minsky/domain/ask/stale-suspended-close"
        );
        let taskStatusById: ReadonlyMap<string, string> = new Map();
        try {
          const taskService = await getServerTaskService();
          if (taskService) {
            const tasks = await taskService.listTasks({ all: true });
            taskStatusById = new Map(tasks.map((t) => [t.id, t.status]));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            "cockpit: stale-ask close sweep could not build task-status map; parent-terminal pass skipped this tick",
            { message }
          );
        }
        await runStaleSuspendedAskCloseSweep(repo, { taskStatusById });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: stale-ask close sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Prod-state cache refresh sweeper (mt#2506)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the prod-state cache. Kept well below the consumer hook's
 * staleness threshold (`PROD_STATE_STALENESS_MS` = 30m in inject-prod-state.ts) so a healthy
 * sweep keeps the injected snapshot labelled "fresh"; only a stalled/absent sweep trips the
 * hook's STALE path.
 */
const PROD_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Start the periodic prod-state cache refresh in this cockpit process (mt#2506).
 *
 * The PRODUCER half of the hybrid cached-injection for the R10 no-tool-boundary status-claim
 * seam: reads the prod migration ledger via the provider's raw-SQL connection and writes a
 * small local cache that `.claude/hooks/inject-prod-state.ts` injects each turn. Doing the
 * network read here (once at boot, then every `intervalMs`) keeps the per-turn hook read
 * cheap (local fs only) per memory `08606f7c`'s ≤50ms bar.
 *
 * Fail-open: no DB / unreadable ledger / a failed pass logs and waits for the next tick —
 * never crashes the cockpit, and leaves the last-good cache in place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
/**
 * The prod-state tick's decision, with its IO injected (mt#3684).
 *
 * Extracted from the sweeper below so each failure path can be exercised
 * without patching `./shared-persistence` or `./prod-state-cache` in place,
 * which ADR-036 bans — the tick reaches both through dynamic imports, so there
 * is no other seam.
 *
 * **Every exit reports a domain outcome.** Before this, only the final
 * `refreshProdStateCache` call touched an instrument (it owns
 * `ProdStateSweepTracker` internally), so the three exits above it were
 * invisible to BOTH health surfaces — which is why `/api/health`'s
 * `prodStateSweep` read `lastErrorAt: null, consecutiveFailures: 0` through
 * ~130 consecutive failures on 2026-08-06. The failures never got far enough
 * to be counted.
 */
export async function runProdStateRefreshTick(deps: {
  /** Resolve the provider's raw-SQL accessor, or null when it exposes none. */
  resolveRawSql: () => Promise<(() => Promise<unknown>) | null>;
  /** Refresh the cache; returns whether it actually wrote. */
  refresh: (sql: unknown, nowIso: string) => Promise<boolean>;
  /** Injectable clock so a test need not depend on wall time. */
  now?: () => string;
  /** Defaults to the process singleton; injectable so a test can assert on an isolated instance. */
  tracker?: Pick<ProdStateSweepTracker, "recordRun" | "recordFailure">;
  /**
   * Warning sink, defaulting to the real logger. Injected rather than patched
   * because for the no-raw-SQL path the log IS the behavior under test — that
   * path emitted nothing at all before mt#3684, so "a line is emitted" is the
   * fix, not incidental output (`testing-boundaries.mdc` §support vs
   * diagnostic; ADR-036 bans patching the logger to observe it).
   */
  logWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<SweepTickResult> {
  // The domain tracker behind /api/health.prodStateSweep is recorded HERE for
  // the paths that never reach `refreshProdStateCache` (which records itself).
  // Without this the two health surfaces would disagree during exactly the
  // outage this task exists to make visible: /api/sweeps would show the domain
  // failure while /api/health still read `lastErrorAt: null,
  // consecutiveFailures: 0`. The paths are mutually exclusive — an upstream
  // failure never reaches the refresh — so no attempt is counted twice.
  const tracker = deps.tracker ?? ProdStateSweepTracker.getInstance();
  const warn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));
  const recordUpstreamFailure = (): void => {
    tracker.recordRun();
    tracker.recordFailure();
  };

  try {
    const getRawSql = await deps.resolveRawSql();
    if (!getRawSql) {
      // Previously a bare `return` — no log, no counter, no trace anywhere. A
      // provider without raw SQL cannot refresh the cache, so this is a
      // failure, not a quiet no-op.
      warn("cockpit: prod-state refresh sweep skipped — provider exposes no raw SQL connection");
      recordUpstreamFailure();
      return { ok: false };
    }
    const sql = await getRawSql();
    const nowIso = (deps.now ?? (() => new Date().toISOString()))();
    // From here on `refreshProdStateCache` owns the tracker bookkeeping.
    return { ok: await deps.refresh(sql, nowIso) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn("cockpit: prod-state refresh sweep failed", { message });
    recordUpstreamFailure();
    return { ok: false };
  }
}

export function startProdStateRefreshSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "prod-state refresh",
    intervalMs: intervalMs ?? PROD_STATE_REFRESH_INTERVAL_MS,
    tick: () =>
      runProdStateRefreshTick({
        resolveRawSql: async () => {
          const { getSharedPersistenceService } = await import("./shared-persistence");
          const svc = await getSharedPersistenceService();
          const provider = svc.getProvider();
          return "getRawSqlConnection" in provider &&
            typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection ===
              "function"
            ? (
                provider as { getRawSqlConnection: () => Promise<unknown> }
              ).getRawSqlConnection.bind(provider)
            : null;
        },
        refresh: async (sql, nowIso) => {
          const { refreshProdStateCache } = await import("./prod-state-cache");
          return refreshProdStateCache(
            sql as import("./prod-state-cache").UnsafeSql | null | undefined,
            nowIso
          );
        },
      }),
  });
}

// ---------------------------------------------------------------------------
// Short-id map refresh sweeper (mt#3914)
// ---------------------------------------------------------------------------

/**
 * Refresh interval for the short-id -> UUID map the display linkifier reads.
 *
 * Grounded in observed mint cadence rather than a round number
 * (`decision-defaults.mdc §Thresholds`): asks are the fastest-growing family at
 * ~135/day measured 2026-08-10 (947 over 7 days), i.e. one roughly every 11
 * minutes. A 5-minute sweep therefore lands a newly-minted id in the map before
 * the next one typically exists.
 *
 * Freshness is the SMALL half of the value here — every recurrence mem#623
 * measured (R3, R4, R6, R7) referenced an id that already existed, most of them
 * days old and carried in a handoff. The window matters for the just-minted
 * edge case only; a miss there degrades to a bare ref, never a wrong one.
 */
const SHORT_ID_MAP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic short-id map refresh in this cockpit process (mt#3914).
 *
 * The PRODUCER half: reads `(short_id, id)` for asks, memories, and workspaces
 * and writes them to a local cache the MessageDisplay hook reads. The hook
 * cannot do this read itself — a hook process's Postgres connect is capped at
 * 2s against a measured 4.3-5.5s cold connect (mt#3744 / mt#3879), so the
 * provider resolves to null deterministically there.
 *
 * Fail-open: no DB / a failed read logs and waits for the next tick, leaving the
 * last-good map in place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startShortIdMapSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "short-id map refresh",
    intervalMs: intervalMs ?? SHORT_ID_MAP_REFRESH_INTERVAL_MS,
    tick: async () => {
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      const hasRawSql =
        "getRawSqlConnection" in provider &&
        typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function";
      if (!hasRawSql) return;
      const sql = await (
        provider as { getRawSqlConnection: () => Promise<unknown> }
      ).getRawSqlConnection();
      const { refreshShortIdMapCache } = await import("./short-id-map-cache");
      await refreshShortIdMapCache(
        sql as import("./short-id-map-cache").UnsafeSql | null | undefined,
        Date.now()
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Dispatch watchdog refresh sweeper (mt#2646)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the dispatch-watchdog cache. Well below the
 * default stale-detection window (`DISPATCH_WATCHDOG_STALE_MS` = 30m in
 * dispatch-watchdog.ts) so a healthy sweep can flag a stalled dispatch
 * within a few minutes of crossing the threshold rather than waiting a full
 * refresh-interval extra.
 */
const DISPATCH_WATCHDOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic dispatch-watchdog cache refresh in this cockpit process
 * (mt#2646).
 *
 * The PRODUCER half of the hybrid cached-injection mechanism: queries
 * in-flight `subagent_invocations` rows (dispatched, not yet Stop-classified)
 * whose task is IN-PROGRESS/IN-REVIEW, checks each for activity (session-
 * branch commits, related system events), and writes the flagged set to a
 * small local cache that `.claude/hooks/inject-dispatch-watchdog.ts` injects
 * each turn. Doing the DB/git reads here (once at boot, then every
 * `intervalMs`) keeps the per-turn hook read cheap (local fs only).
 *
 * Fail-open: no DB / unreadable ledger / a failed pass logs and waits for the
 * next tick — never crashes the cockpit, and leaves the last-good cache in
 * place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startDispatchWatchdogSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "dispatch watchdog",
    intervalMs: intervalMs ?? DISPATCH_WATCHDOG_REFRESH_INTERVAL_MS,
    tick: async () => {
      try {
        const { refreshDispatchWatchdogCache } = await import("./dispatch-watchdog");
        await refreshDispatchWatchdogCache();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: dispatch watchdog sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Slow-clock topology sweeper (mt#2602)
// ---------------------------------------------------------------------------

/**
 * Default refresh interval for the slow-clock topology cache: hourly-class,
 * per the mt#2375 "SLOW — plant grows valves" timescale and mt#2602's
 * "boot + hourly-class sweep, never per-request" constraint.
 */
const TOPOLOGY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the periodic slow-clock topology refresh in this cockpit process
 * (mt#2602). Recomputes the guard-hook registry + git-derived install dates +
 * `retrospective.fired` correlation (see `topology-cache.ts` /
 * `topology-derivation.ts`) once at boot, then every `intervalMs`. The
 * `slow-topology` widget's `fetch()` only ever reads the resulting in-process
 * cache — this sweeper is the sole place the bounded `git log` subprocess and
 * the DB query run.
 *
 * Fail-open: a failed pass logs and waits for the next tick, leaving the
 * last-good cache (if any) in place — never crashes the cockpit. Overlapping
 * ticks are skipped.
 *
 * @returns stop function (clears the interval).
 */
export function startTopologySweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "topology",
    intervalMs: intervalMs ?? TOPOLOGY_REFRESH_INTERVAL_MS,
    tick: async () => {
      try {
        const { refreshTopologyCache } = await import("./topology-cache");
        await refreshTopologyCache(new Date().toISOString());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: topology sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Transcript sweep backstop (mt#2321)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the transcript sweep backstop. Longer than the prod-state
 * sweeper (10m) because a full ingestAll + embedding backfill is heavy — it
 * re-discovers every JSONL session in ~/.claude/projects and calls the DB for each.
 * 30m keeps the backstop meaningful (catches sessions missed while the daemon was
 * down, dropped FS events) without hammering the DB on a tight loop.
 */
const TRANSCRIPT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Per-tick timeout for the transcript sweep backstop (mt#2625): larger than
 * {@link DEFAULT_TICK_TIMEOUT_MS} because a full ingestAll + embedding
 * backfill over a large historical corpus can legitimately take longer than
 * the simpler sweepers' work — an aggressive timeout here would false-positive
 * on a cold-start sweep over a big `~/.claude/projects` tree, not just on a
 * genuine hang.
 */
const TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolve the sweep cadence (SC1 — externally configurable). An explicit
 * `MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS` env override (positive-integer
 * milliseconds) wins; otherwise the default. Env-var config mirrors the
 * cockpit's existing `MINSKY_COCKPIT_*` reads — no config-schema change needed.
 */
export function resolveSweepIntervalMs(): number {
  const raw = process.env.MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn("cockpit: ignoring invalid MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS", { raw });
  }
  return TRANSCRIPT_SWEEP_INTERVAL_MS;
}

/**
 * Injectable runners for the sweep tick — separate from the real DB wiring so
 * unit tests can inject spies without a real DB or filesystem.
 */
export interface TranscriptSweepDeps {
  /** Run a full ingest sweep (wraps ingestAll). Must be idempotent/HWM-gated. */
  runIngest: () => Promise<{
    sessionsProcessed: number;
    sessionsErrored: number;
    /** mt#3278 — sessions skipped because they are quarantined. */
    sessionsQuarantined?: number;
  }>;
  /** Run the embedding backfill (wraps PerTurnEmbeddingPipeline.run). May throw. */
  runEmbeddings: () => Promise<void>;
  /** Tracker singleton to record observability counters. */
  tracker: TranscriptSweepTracker;
}

/** Options accepted by startTranscriptSweepBackstop. */
export interface TranscriptSweepBackstopOptions {
  /** Cadence override in milliseconds (default: TRANSCRIPT_SWEEP_INTERVAL_MS). */
  intervalMs?: number;
  /**
   * Injectable deps for testing. When absent, the real DB path is used
   * (ClaudeCodeTranscriptSource + AgentTranscriptIngestService + PerTurnEmbeddingPipeline).
   */
  deps?: TranscriptSweepDeps;
  /**
   * Set false to skip the schema-readiness gate (mt#3297). Tests that inject
   * `deps` have no real database for the check to interrogate, so leaving it on
   * would make every such test depend on live persistence.
   */
  schemaReadiness?: boolean;
}

/**
 * Build the real sweep deps from the shared persistence service.
 * Returns null when the provider is not SQL-capable.
 */
async function buildRealSweepDeps(): Promise<TranscriptSweepDeps | null> {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    return null;
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  const tracker = TranscriptSweepTracker.getInstance();

  const runIngest = async (): Promise<{
    sessionsProcessed: number;
    sessionsErrored: number;
    sessionsQuarantined: number;
  }> => {
    const { ClaudeCodeTranscriptSource } = await import(
      "@minsky/domain/transcripts/claude-code-transcript-source"
    );
    const { AgentTranscriptIngestService } = await import(
      "@minsky/domain/transcripts/agent-transcript-ingest-service"
    );
    const source = new ClaudeCodeTranscriptSource();
    const svcIngest = new AgentTranscriptIngestService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      source
    );
    const result = await svcIngest.ingestAll();
    return {
      sessionsProcessed: result.sessionsProcessed,
      sessionsErrored: result.sessionsErrored,
      sessionsQuarantined: result.sessionsQuarantined,
    };
  };

  const runEmbeddings = async (): Promise<void> => {
    // createEmbeddingServiceFromConfig throws when no embedding provider is
    // configured or reachable. The tick's outer try/catch (fail-open) handles
    // that case: the sweep ingest counters are already recorded, and only the
    // embedding backfill is skipped — per SC2's requirement that a missing
    // embedding provider must not crash the sweep.
    const { createEmbeddingServiceFromConfig } = await import(
      "@minsky/domain/ai/embedding-service-factory"
    );
    const embeddingService = await createEmbeddingServiceFromConfig();
    const { PerTurnEmbeddingPipeline } = await import(
      "@minsky/domain/transcripts/per-turn-embedding-pipeline"
    );
    const pipeline = new PerTurnEmbeddingPipeline(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
      embeddingService
    );
    await pipeline.run();
  };

  return { runIngest, runEmbeddings, tracker };
}

/**
 * Start the periodic transcript sweep backstop in this cockpit process (mt#2321).
 *
 * BACKSTOP half of ADR-017 (the primary capture path is the FS watcher, mt#2320).
 * Covers failure modes the watcher cannot recover:
 *   - Dropped / coalesced / lost FS-watch events
 *   - Sessions that completed while the cockpit daemon was DOWN
 *   - Sessions predating the watcher's attach that seedExisting did not cover
 *   - Stale / missing pgvector embeddings (via the embedded backfill pass)
 *
 * Sweeper convention (mirrors startAskAdvancementSweeper and startProdStateRefreshSweeper):
 *   - `running` flag skips overlapping ticks
 *   - fail-open try/catch + log.warn on every failure path
 *   - `void tick()` boot pass
 *   - `setInterval` + `.unref()` so the process never stays alive for the sweep alone
 *   - returns `() => clearInterval(id)` stop function
 *   - per-tick timeout + watchdog (mt#2625) via the shared createIntervalSweeper factory
 *
 * Deps are injectable so the sweep core can be unit-tested without a real DB or filesystem.
 *
 * @see docs/architecture/cockpit.md — Transcript sweep backstop (cadence + /api/health payload)
 * @returns stop function (clears the interval).
 */
export function startTranscriptSweepBackstop(opts?: TranscriptSweepBackstopOptions): () => void {
  const resolvedInterval = opts?.intervalMs ?? resolveSweepIntervalMs();

  return createIntervalSweeper({
    name: "transcript sweep backstop",
    intervalMs: resolvedInterval,
    tickTimeoutMs: TRANSCRIPT_SWEEP_TICK_TIMEOUT_MS,
    tick: async () => {
      try {
        // Resolve deps: injected (for tests) or real (for production).
        let sweepDeps: TranscriptSweepDeps | null;
        if (opts?.deps) {
          sweepDeps = opts.deps;
        } else {
          sweepDeps = await buildRealSweepDeps();
        }

        if (!sweepDeps) {
          // Non-SQL provider: nothing to sweep.
          log.debug("cockpit: transcript sweep: no SQL-capable DB, skipping tick");
          return;
        }

        const { runIngest, runEmbeddings, tracker } = sweepDeps;

        // ── Phase 0: schema readiness (mt#3297) ───────────────────────────────
        // Every write below targets columns this build expects the DB to have.
        // After a merge that carries a migration, the tray restarts the daemon
        // onto the new code within seconds while the migration is (correctly)
        // NOT applied automatically to a shared database — so there is a window
        // where all of this fails on a missing column. Skipping the sweep once,
        // with a reason, replaces one failure per session per tick.
        //
        // Re-checked every tick rather than only at boot, so applying the
        // migration lifts the pause on the next tick with no restart.
        if (opts?.schemaReadiness !== false) {
          await refreshSchemaReadinessFromDb();
          if (isSchemaBehind()) {
            // At debug, not warn: `refreshSchemaReadinessFromDb` already logged
            // the transition into behind at warn, and repeating the reason on
            // every tick would make a check whose purpose is bounding log volume
            // into a recurring writer (PR #2379 R1). The standing condition is
            // on /api/health.
            log.debug("cockpit: transcript sweep skipped — schema behind", {
              pending: getSchemaReadiness().pending,
            });
            return;
          }
        }

        // ── Phase 1: ingest sweep (idempotent/HWM-gated) ──────────────────────
        let ingestResult: {
          sessionsProcessed: number;
          sessionsErrored: number;
          sessionsQuarantined?: number;
        };
        try {
          ingestResult = await runIngest();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: ingest failed", { message });
          sweepDeps.tracker.recordSweepError();
          return; // Can't meaningfully record a completed sweep if ingest threw.
        }

        // Record ingest counters (includes error count — surfaced, not dropped).
        if (ingestResult.sessionsErrored > 0) {
          log.warn("cockpit: transcript sweep: ingest completed with per-session errors", {
            sessionsProcessed: ingestResult.sessionsProcessed,
            sessionsErrored: ingestResult.sessionsErrored,
          });
        }
        // mt#3278: a quarantined session is not an error this pass — nothing was
        // attempted — but it IS a standing condition an operator needs to see,
        // so it is logged every sweep rather than only when it first happens.
        if ((ingestResult.sessionsQuarantined ?? 0) > 0) {
          log.warn("cockpit: transcript sweep: sessions quarantined and not attempted", {
            sessionsQuarantined: ingestResult.sessionsQuarantined,
          });
        }
        tracker.recordSweepCompleted(
          ingestResult.sessionsProcessed,
          ingestResult.sessionsErrored,
          ingestResult.sessionsQuarantined ?? 0
        );

        // ── Phase 2: embedding backfill (heavy, fail-open) ─────────────────────
        // SC2: default semantic-embedding backfill, run off the critical path.
        // A missing embedding provider, API error, or DB timeout must NOT crash
        // the sweep or prevent the ingest counters from being recorded.
        try {
          await runEmbeddings();
          tracker.recordEmbedRunCompleted();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: embedding backfill failed (non-fatal)", {
            message,
          });
          tracker.recordSweepError();
          // No return: the ingest phase already completed successfully.
        }
      } catch (err) {
        // Outermost safety net — unexpected throw escaping either phase.
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: transcript sweep: unexpected error in tick", { message });
        // If we have injected deps, at least record an error.
        if (opts?.deps) {
          opts.deps.tracker.recordSweepError();
        } else {
          TranscriptSweepTracker.getInstance().recordSweepError();
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// deploy.smoke sweep (mt#2599)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the deploy.smoke sweep. The bundle-boot-smoke workflow
 * typically completes within a few minutes of the triggering push; 5 minutes
 * matches the dispatch-watchdog sweeper's cadence for a similarly
 * GitHub-API-backed poll.
 */
const DEPLOY_SMOKE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the periodic deploy.smoke sweep in this cockpit process (mt#2599).
 *
 * See `deploy-smoke-sweep.ts`'s module doc block for the full design
 * (poll-not-webhook rationale, which commit gets checked, dedup strategy).
 * In short: each tick asks "has the bundle-boot-smoke check-run for the
 * commit THIS cockpit process was deployed from (`RAILWAY_GIT_COMMIT_SHA`)
 * completed?" and emits a best-effort `deploy.smoke` system event once per
 * distinct commit when it has.
 *
 * Fail-open: no GitHub backend configured / no commit SHA / a failed GitHub
 * API call all no-op and retry next tick — never crashes the cockpit.
 * Overlapping ticks are skipped (via `createIntervalSweeper`).
 *
 * @returns stop function (clears the interval).
 */
export function startDeploySmokeSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "deploy.smoke",
    intervalMs: intervalMs ?? DEPLOY_SMOKE_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const { getSharedProvider } = await import("./shared-persistence");
        const { triggerDeploySmokeSweep } = await import("./deploy-smoke-sweep");
        const provider = await getSharedProvider();
        await triggerDeploySmokeSweep(provider);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: deploy.smoke sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Scheduled follow-up sweeper (mt#2322 — general recurring-job scheduler
// facility's first consumer; remaining scope of parent mt#2234)
// ---------------------------------------------------------------------------

/**
 * Default cadence for the scheduled-follow-up sweeper. A follow-up's "fires
 * locally at its scheduled time" contract only needs local precision — 1
 * minute matches the meta-watchdog's own cadence and keeps a follow-up's
 * fire-delay bounded without a tight DB-polling loop.
 */
const FOLLOW_UP_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Start the periodic scheduled-follow-up sweep in this cockpit process
 * (mt#2322). This IS the "recurring-job scheduler facility" concretely
 * instantiated: `createIntervalSweeper` is the general recurring-job
 * primitive (already proven general by every OTHER sweeper in this file —
 * ask advancement, prod-state, topology, transcript backstop, dispatch
 * watchdog, deploy.smoke); the follow-up sweep is simply its newest
 * registrant, and the DB-durable `scheduled_follow_ups` table is the
 * one-shot "fire at a specific time" primitive layered on top (storage-backed
 * rather than an in-memory `setTimeout`, so a follow-up survives a daemon
 * restart between creation and its due time — sweeper-not-durable-queue per
 * `decision-defaults.mdc §Reliability`).
 *
 * Each tick calls `FollowUpService.fireDue()`, which is idempotent (only
 * `pending` rows are affected, via a status-guarded UPDATE) — so overlapping
 * ticks, a sweep re-run, or the daemon restarting mid-cycle can never
 * double-fire a follow-up.
 *
 * Fail-open: no SQL-capable DB / a failed pass logs and waits for the next
 * tick — never crashes the cockpit. Sweep-liveness (lastAttemptAt/
 * lastSuccessAt/lastErrorAt) is already covered generically by
 * `createIntervalSweeper`'s registry (`GET /api/sweeps`, mt#2894) — no
 * follow-up-specific tracker is needed.
 *
 * @returns stop function (clears the interval).
 */

/**
 * Minimal shape the follow-up sweeper needs from a FollowUpService — just
 * `fireDue`. Declared narrowly (rather than importing the concrete class)
 * so tests can inject a fake without constructing a real DB-backed service.
 */
export interface FollowUpSweepDeps {
  fireDue: () => Promise<{
    fired: Array<{ id: string }>;
    errored: Array<{ id: string; error: string }>;
  }>;
}

/** Options accepted by {@link startFollowUpSweeper}. */
export interface FollowUpSweeperOptions {
  /** Cadence override in milliseconds (default: FOLLOW_UP_SWEEP_INTERVAL_MS). */
  intervalMs?: number;
  /**
   * Injectable deps for testing. When absent, the real DB path is used
   * (getServerFollowUpService — the cockpit-wide PersistenceService
   * singleton's FollowUpService).
   */
  deps?: FollowUpSweepDeps;
}

export function startFollowUpSweeper(opts?: FollowUpSweeperOptions): () => void {
  return createIntervalSweeper({
    name: "scheduled follow-ups",
    intervalMs: opts?.intervalMs ?? FOLLOW_UP_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const service: FollowUpSweepDeps | null = opts?.deps ?? (await getServerFollowUpService());
        if (!service) {
          // Non-SQL provider: nothing to sweep.
          log.debug("cockpit: follow-up sweep: no SQL-capable DB, skipping tick");
          return;
        }
        const { fired, errored } = await service.fireDue();
        if (fired.length > 0) {
          log.info(`cockpit: fired ${fired.length} scheduled follow-up(s)`, {
            ids: fired.map((f) => f.id),
          });
        }
        if (errored.length > 0) {
          log.warn(`cockpit: ${errored.length} scheduled follow-up(s) failed to fire`, {
            errored,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: follow-up sweep failed", { message });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Conversation presence absence-detection sweep (mt#3201, mt#3130 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Cadence for the presence sweep.
 *
 * Deliberately much SHORTER than the stall threshold it detects against
 * (`PRESENCE_STALL_THRESHOLD_MS`, the measured ~24-minute turn-grain p99): the
 * sweep's job is to notice a crossing promptly AFTER it happens, so its
 * interval bounds detection LATENCY, not the threshold itself. One minute
 * matches the meta-watchdog's own cadence and keeps the worst-case lag between
 * "went stale" and "operator sees STALLED" to about a minute.
 *
 * The tick is cheap — one indexed range scan
 * (`idx_conversation_run_state_last_event_at`) over a table with one row per
 * conversation, plus a pure derivation per row.
 */
const CONVERSATION_PRESENCE_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Start the conversation-presence absence-detection sweep (mt#3201).
 *
 * Detects presence TRANSITIONS (notably `LIVE` -> `STALLED`, which no writer
 * can emit because a killed process emits nothing) and pushes them on
 * `minsky.conversation.presence_changed` for the SSE broker to forward.
 *
 * It does NOT write a `presence` column — the schema deliberately has none, and
 * the read path re-derives the value on every request. This sweep exists for
 * PUSH and for other consumers, not to make the read path honest.
 *
 * Fail-open throughout: no SQL provider, a failed scan, or a dead NOTIFY all
 * log and wait for the next tick. The read endpoint remains the contract.
 *
 * @returns stop function (clears the interval).
 */
export function startConversationPresenceSweeper(intervalMs?: number): () => void {
  const state = createPresenceSweepState();

  return createIntervalSweeper({
    name: "conversation presence",
    intervalMs: intervalMs ?? CONVERSATION_PRESENCE_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const { getSharedPersistenceService } = await import("./shared-persistence");
        const svc = await getSharedPersistenceService();
        const provider = svc.getProvider();

        const getDb =
          "getDatabaseConnection" in provider &&
          typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection ===
            "function"
            ? (
                provider as {
                  getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
                }
              ).getDatabaseConnection.bind(provider)
            : null;
        if (!getDb) {
          log.debug("cockpit: presence sweep: no SQL-capable DB, skipping tick");
          return;
        }
        const db = await getDb();
        if (!db) return;

        const getRawSql =
          "getRawSqlConnection" in provider &&
          typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
            ? (
                provider as { getRawSqlConnection: () => Promise<unknown> }
              ).getRawSqlConnection.bind(provider)
            : null;

        const { listConversationsQuietSince } = await import(
          "@minsky/domain/conversation-run-state/read"
        );
        const { runPresenceSweepTick } = await import("./conversation-presence-sweep");

        const transitions = await runPresenceSweepTick(state, {
          listQuietSince: (olderThan) => listConversationsQuietSince(db, olderThan),
          now: () => new Date(),
          emit: async (channel, payload) => {
            if (!getRawSql) return;
            const sql = (await getRawSql()) as {
              unsafe: (query: string, params: unknown[]) => Promise<unknown>;
            } | null;
            if (!sql) return;
            await sql.unsafe("SELECT pg_notify($1, $2)", [channel, payload]);
          },
        });

        if (transitions.length > 0) {
          log.info(`cockpit: ${transitions.length} conversation presence transition(s)`, {
            transitions: transitions.map((t) => `${t.conversationId}: ${t.from ?? "-"}->${t.to}`),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation presence sweep failed", { message });
      }
    },
  });
}

// ── Conversation-title sweeper (mt#3321) ────────────────────────────────────

/**
 * Cadence for generating conversation titles. Slower than the presence/
 * follow-up sweeps because it is not latency-sensitive — a conversation
 * without a title still renders, it just falls back to the older prompt-snippet
 * label. Paired with `DEFAULT_TITLE_BATCH_SIZE`, this drains the historical
 * backlog over hours rather than in one burst of completion calls.
 */
const CONVERSATION_TITLE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Injectable seam so tests can drive a tick without a DB or an AI provider. */
export interface ConversationTitleSweepDeps {
  /** Run one bounded titling batch. Returns per-run counters. */
  runTitling: () => Promise<{
    candidates: number;
    titled: number;
    skipped: number;
    errored: number;
  }>;
}

export interface ConversationTitleSweepOptions {
  /** Cadence override in milliseconds. */
  intervalMs?: number;
  /** Injected deps for testing; when absent the real DB + AI path is built. */
  deps?: ConversationTitleSweepDeps;
}

/**
 * Build the real titling runner from the shared persistence service and the
 * configured AI completion service. Returns null when the provider is not
 * SQL-capable — the same degradation the transcript backstop uses.
 */
async function buildRealTitleSweepDeps(): Promise<ConversationTitleSweepDeps | null> {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    return null;
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  return {
    runTitling: async () => {
      const { getConfiguration } = await import("@minsky/domain/configuration");
      const { DefaultAICompletionService } = await import("@minsky/domain/ai/completion-service");
      const { DirectCognitionProvider } = await import("@minsky/domain/cognition/providers/direct");
      const { TitlePipeline } = await import("@minsky/domain/transcripts/title-pipeline");

      const configService = {
        loadConfiguration: () => Promise.resolve({ resolved: getConfiguration() }),
      };
      const cognitionProvider = new DirectCognitionProvider(
        new DefaultAICompletionService(configService)
      );

      return new TitlePipeline(db, cognitionProvider).run();
    },
  };
}

/**
 * Start the conversation-title sweeper — the invocation path for mt#3321.
 *
 * This is the piece the pre-existing summary pipeline never had: `SummaryPipeline`
 * has run only when an operator manually invoked `transcripts index-embeddings`,
 * which is why 11 of 1,992 transcripts carried a summary and none of the 281
 * from the preceding week did. A titling mechanism with no caller would repeat
 * that exactly, so the caller ships in the same change as the mechanism.
 *
 * Degrades quietly and retries: a non-SQL provider, a DB outage, or an AI
 * failure logs and waits for the next tick. Rows stay NULL and are retried —
 * no partial or placeholder title is ever written.
 *
 * @returns stop function (clears the interval).
 */
export function startConversationTitleSweeper(options?: ConversationTitleSweepOptions): () => void {
  return createIntervalSweeper({
    name: "conversation title",
    intervalMs: options?.intervalMs ?? CONVERSATION_TITLE_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const deps = options?.deps ?? (await buildRealTitleSweepDeps());
        if (!deps) {
          // Not an error — a non-SQL provider simply has nothing to title. Logged
          // so a permanently-idle sweeper is distinguishable from a working one
          // with no backlog (PR #2408 R1).
          log.debug("cockpit: conversation title sweep skipped (no SQL persistence)");
          return;
        }
        const result = await deps.runTitling();
        // Per-run counters at the sweeper level, not only inside the pipeline:
        // `errored > 0` is the signal that titling is failing while the sweeper
        // itself looks healthy.
        if (result.candidates > 0 || result.errored > 0) {
          log.info("cockpit: conversation title sweep complete", {
            candidates: result.candidates,
            titled: result.titled,
            skipped: result.skipped,
            errored: result.errored,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation title sweep failed", { message });
      }
    },
  });
}

// ── Conversation summary sweeper (mt#3441) ───────────────────────────────────

/**
 * Same 10-minute cadence as titling, for the same reason: a conversation with no
 * summary still renders and is still searchable by title, so this drains the
 * backlog over hours rather than in one burst. Paired with
 * `DEFAULT_SUMMARY_BATCH_SIZE`, a tick costs at most 25 completions + 25
 * embedding calls.
 */
const CONVERSATION_SUMMARY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Injectable seam so tests can drive a tick without a DB, an AI provider, or embeddings. */
export interface ConversationSummarySweepDeps {
  /** Run one bounded summarization batch. Returns per-run counters. */
  runSummarizing: () => Promise<{
    transcriptsScanned: number;
    transcriptsSkipped: number;
    transcriptsProcessed: number;
    transcriptsErrored: number;
    embeddingCallsMade: number;
  }>;
}

export interface ConversationSummarySweepOptions {
  /** Cadence override in milliseconds. */
  intervalMs?: number;
  /** Injected deps for testing; when absent the real DB + AI + embedding path is built. */
  deps?: ConversationSummarySweepDeps;
}

/**
 * Build the real summarizing runner. Mirrors {@link buildRealTitleSweepDeps},
 * plus an embedding service — a summary costs a completion AND an embedding,
 * which titling does not.
 *
 * Returns null when the provider is not SQL-capable.
 */
async function buildRealSummarySweepDeps(): Promise<ConversationSummarySweepDeps | null> {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (
    !("getDatabaseConnection" in provider) ||
    typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
  ) {
    return null;
  }

  const sqlProvider = provider as {
    getDatabaseConnection: () => Promise<
      import("drizzle-orm/postgres-js").PostgresJsDatabase | null
    >;
  };
  const db = await sqlProvider.getDatabaseConnection();
  if (!db) return null;

  return {
    runSummarizing: async () => {
      const { getConfiguration } = await import("@minsky/domain/configuration");
      const { DefaultAICompletionService } = await import("@minsky/domain/ai/completion-service");
      const { DirectCognitionProvider } = await import("@minsky/domain/cognition/providers/direct");
      const { createEmbeddingServiceFromConfig } = await import(
        "@minsky/domain/ai/embedding-service-factory"
      );
      const { SummaryPipeline } = await import("@minsky/domain/transcripts/summary-pipeline");

      const configService = {
        loadConfiguration: () => Promise.resolve({ resolved: getConfiguration() }),
      };
      const cognitionProvider = new DirectCognitionProvider(
        new DefaultAICompletionService(configService)
      );
      const embeddingService = await createEmbeddingServiceFromConfig();

      // No batchSize: the pipeline's bounded default is exactly what a sweeper
      // wants, and inheriting it is the point of making it the default (mt#3441).
      return new SummaryPipeline(db, cognitionProvider, embeddingService).run();
    },
  };
}

/**
 * Start the conversation-summary sweeper — the invocation path for mt#3441.
 *
 * `SummaryPipeline` shipped without one: its only caller was the manual
 * `transcripts index-embeddings` command, so summaries existed only where an
 * operator happened to run it — 11 rows out of 2,108 (0.5%), against 34% for
 * titles, which have had a sweeper since mt#3321. That gap is why the index
 * could not answer "which conversation was the one about X".
 *
 * Degrades quietly and retries, matching the title sweeper: a non-SQL provider,
 * a DB outage, an AI failure, or an unavailable embedding backend logs and waits
 * for the next tick. Rows stay NULL and are retried — no partial or placeholder
 * summary is ever written. The embedding dependency makes this more than
 * theoretical: the embeddings backend has been observed quota-exhausted, and a
 * tick during an outage must cost one failed batch, not a poisoned column.
 *
 * @returns stop function (clears the interval).
 */
export function startConversationSummarySweeper(
  options?: ConversationSummarySweepOptions
): () => void {
  return createIntervalSweeper({
    name: "conversation summary",
    intervalMs: options?.intervalMs ?? CONVERSATION_SUMMARY_SWEEP_INTERVAL_MS,
    tick: async () => {
      try {
        const deps = options?.deps ?? (await buildRealSummarySweepDeps());
        if (!deps) {
          log.debug("cockpit: conversation summary sweep skipped (no SQL persistence)");
          return;
        }
        const result = await deps.runSummarizing();
        // `transcriptsErrored > 0` is the signal that summarizing is failing
        // while the sweeper itself looks healthy — the shape that let the
        // original no-caller gap sit unnoticed.
        if (result.transcriptsScanned > 0 || result.transcriptsErrored > 0) {
          log.info("cockpit: conversation summary sweep complete", {
            scanned: result.transcriptsScanned,
            processed: result.transcriptsProcessed,
            skipped: result.transcriptsSkipped,
            errored: result.transcriptsErrored,
            embeddingCalls: result.embeddingCallsMade,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation summary sweep failed", { message });
      }
    },
  });
}
