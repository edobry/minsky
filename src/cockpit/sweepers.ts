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
  getCachedPersistenceProvider,
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
// mt#3744: the ask-state sweeper's two cheap, pure-fs halves are imported
// statically (the DB half stays a dynamic import, like every sibling sweeper's).
import { readWatermarkAskIds } from "./ask-state-cache";
import { findRepoRoot } from "./web-dist";

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

/**
 * How much longer than `tickTimeoutMs` an ABANDONED tick may hold the guard
 * before the watchdog force-releases it anyway (mt#4335).
 *
 * The two deadlines answer different questions and both are needed:
 *
 * - `tickTimeoutMs` is when we stop WAITING on a tick — it is marked failed,
 *   its `AbortSignal` fires, and the sweep stops treating it as live work.
 * - `tickTimeoutMs * this` is when we stop letting it hold the guard, whether
 *   or not it ever settles.
 *
 * Between the two, the guard stays held. That is the whole fix: releasing the
 * guard at `tickTimeoutMs` (the pre-mt#4335 behaviour) let the next tick start
 * BESIDE an abandoned predecessor that was still holding a database
 * connection, so a persistently-slow tick leaked roughly one connection per
 * cycle until the pool was exhausted.
 *
 * Why a ceiling at all, rather than waiting forever: mt#2625's guarantee is
 * that one hung tick can never starve every later tick permanently, and its
 * regression tests assert exactly that with a tick that NEVER settles. Waiting
 * unconditionally would reintroduce that bug. So a never-settling tick still
 * gets force-released — just after 3 tick-timeouts instead of 1, which is a
 * bounded delay rather than a lost guarantee.
 *
 * 3 is chosen as the smallest multiplier that leaves room for a tick to finish
 * shortly after its deadline (the common case for a slow query — the
 * interceptor rollup measured 2.73s cold against a 120s budget) without
 * meaningfully extending mt#2625's recovery window. It is deliberately a
 * multiplier rather than a fixed duration: sweeps run at cadences from
 * milliseconds (tests) to minutes (production), so any absolute number would
 * be wrong at one end.
 */
export const ABANDONED_TICK_HARD_RELEASE_MULTIPLIER = 3;

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
  /**
   * Cumulative count of ticks abandoned for exceeding `tickTimeoutMs` (mt#4335).
   *
   * A non-zero and RISING value is the signal that this sweep's work no longer
   * fits its budget — which is what preceded the 2026-08-19 pool exhaustion.
   * Surfaced here rather than only logged because the incident was diagnosed by
   * reading `pg_stat_activity` by hand; the point of the counter is that a
   * recurrence is visible from `/api/sweeps` without doing that.
   */
  abandonedTicks: number;
  /**
   * Abandoned ticks that have STILL not settled (mt#4335).
   *
   * This is the one to alert on. It is normally 0 — a tick that overruns and
   * then finishes decrements it. A value that stays above 0, or grows, means
   * work is accumulating with resources still held, which is the shape that
   * exhausted the connection pool.
   */
  abandonedTicksOutstanding: number;
  /**
   * Count of abandoned ticks that outlived even the hard-release ceiling and
   * had their guard force-released by the watchdog anyway (mt#4335).
   *
   * Distinct from {@link abandonedTicks}: those settled late, these never
   * settled at all. A non-zero value here means the mt#2625 escape hatch fired
   * and a resource may still be held with nothing left to release it — the
   * residual leak this design accepts in exchange for not starving the sweep.
   */
  abandonedTickHardReleases: number;
  /** False when this sweep has never reported a domain outcome — the three fields above are then meaningless rather than healthy. */
  reportsDomainOutcome: boolean;
  /**
   * Whether this registrant's contract REQUIRES it to state a domain outcome
   * (mt#4412) — static, fixed at registration, and the sibling
   * {@link reportsDomainOutcome} is deliberately NOT.
   *
   * The two answer different questions and conflating them is what made the
   * invariant uncheckable. `reportsDomainOutcome` is a runtime OBSERVATION: it
   * starts false and flips the first time a tick actually returns a result, so
   * a registrant that has not completed a tick yet reads false however it is
   * typed — as does one whose tick never settles at all (mt#4384's wedge).
   * Neither is a defect, and no type change can pre-satisfy either.
   *
   * This field is the DECLARATION, so "every registrant is obliged to speak"
   * is assertable the moment the registry is populated, without waiting out
   * the slowest cadence (60m) to find out.
   *
   * Both registration paths set it true, which is the point rather than a
   * tautology: it is a required field, so a THIRD registration path cannot be
   * added without deciding, and the registry-level test fails if one decides
   * wrong. mem#1060 — the class lives in the enumeration, not the member.
   */
  declaresDomainOutcome: boolean;
  /**
   * True when this participant drives its own cadence (mt#4185) rather than
   * having its tick fired by {@link createIntervalSweeper}'s `setInterval`.
   *
   * This is the discriminator for reading `intervalMs`. For an interval sweep
   * it is a CADENCE — how often the timer fires. For a self-scheduling
   * participant it is a PROGRESS BUDGET — the longest legitimate gap between
   * two `noteProgress()` calls. The stall predicate is the same either way
   * (`lastAttemptAt` staler than `intervalMs` × {@link
   * META_WATCHDOG_STALL_MULTIPLIER}), which is why one field carries both;
   * this flag is what lets a reader say which one it is looking at.
   */
  selfScheduled: boolean;
  /**
   * ISO timestamp of when this sweep joined the registry (mt#4206).
   *
   * Present so "registered, never reported" is a DATEABLE reading rather than
   * an inference from `lastAttemptAt: null`. The two are different states with
   * different responses — one is a sweep that has not started yet, the other is
   * one that started and never got anywhere — and a null alone cannot say which
   * without knowing how long it has been null.
   *
   * It is also the meta-watchdog's staleness reference for a self-scheduling
   * participant that has reported nothing, which is what makes a first-cycle
   * park visible instead of permanently skipped.
   */
  registeredAt: string;
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
  /** See {@link SweepLivenessSnapshot.declaresDomainOutcome} (mt#4412). */
  declaresDomainOutcome: boolean;
  /** See {@link SweepLivenessSnapshot.abandonedTicks} (mt#4335). */
  abandonedTicks: number;
  /** See {@link SweepLivenessSnapshot.abandonedTicksOutstanding} (mt#4335). */
  abandonedTicksOutstanding: number;
  /** See {@link SweepLivenessSnapshot.abandonedTickHardReleases} (mt#4335). */
  abandonedTickHardReleases: number;
  /** See {@link SweepLivenessSnapshot.selfScheduled} (mt#4185). */
  selfScheduled: boolean;
  /** See {@link SweepLivenessSnapshot.registeredAt} (mt#4206). */
  registeredAtMs: number;
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
      abandonedTicks: e.abandonedTicks,
      abandonedTicksOutstanding: e.abandonedTicksOutstanding,
      abandonedTickHardReleases: e.abandonedTickHardReleases,
      reportsDomainOutcome: e.reportsDomainOutcome,
      declaresDomainOutcome: e.declaresDomainOutcome,
      selfScheduled: e.selfScheduled,
      registeredAt: new Date(e.registeredAtMs).toISOString(),
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
   * as "the timer fired and the callback returned". Reporting whether the
   * WORK succeeded is what {@link SweepTickResult} is for (mt#3684), and as of
   * mt#4412 it is MANDATORY: `void` is no longer assignable.
   *
   * It was optional from mt#3684 until mt#4412, and the docblock here used to
   * say why — "returning nothing is unchanged behavior ... which is why adding
   * this did not require touching the other sweeps." That convenience is
   * exactly what this type change retires: 15 of 17 registrants took the
   * default, so for 88% of them `/api/sweeps` could not distinguish a working
   * sweep from one whose tick caught its own error and returned. The compiler,
   * not a convention, is now what asks each sweep to state an outcome.
   *
   * **Report the sweep's OWN result, never a blanket `{ ok: true }`.** A
   * uniform `ok: true` reproduces the defect in a shape that reads as covered,
   * which is worse than the honest `void` this replaced. Where "did the work
   * succeed?" is genuinely not decidable at the tick boundary, say so in the
   * sweep's own docblock with the reason.
   *
   * Receives an {@link AbortSignal} that fires when the tick exceeds
   * `tickTimeoutMs` (mt#4335). Using it is OPTIONAL and existing ticks that
   * take no arguments remain assignable to this type unchanged — but a tick
   * holding a cancellable resource SHOULD honour it, because the framework
   * cannot reach inside the tick to release what it opened. For a
   * `postgres-js` query that means calling `.cancel()`, which sends a
   * protocol-level CancelRequest (`src/query.js:52` → `src/index.js:350` →
   * `Connection.cancel`, protocol code 80877102 — the wire equivalent of
   * `pg_cancel_backend`).
   */
  tick: (signal: AbortSignal) => Promise<SweepTickResult>;
  /**
   * Per-tick abandonment timeout in milliseconds (mt#2625, amended mt#4335).
   * A tick that hasn't settled within this window is abandoned: it is marked
   * failed, a warning is logged, and its {@link AbortSignal} fires so a tick
   * that opted in can cancel its own work.
   *
   * **The guard is NOT released at this deadline (changed in mt#4335).** It is
   * released when the abandoned tick actually settles, or at
   * `tickTimeoutMs * ABANDONED_TICK_HARD_RELEASE_MULTIPLIER`, whichever comes
   * first. Until mt#4335 the guard WAS released here, and this docblock
   * described that as the fix for mt#2625's permanent-starvation bug — which
   * it was, at the cost of a second bug: the next tick started beside an
   * abandoned predecessor still holding a database connection, and each
   * overlapping tick opened another. Measured 2026-08-19: 16 backends stranded
   * in `state='active', wait_event='ClientRead'` from a single ~40s burst,
   * which exhausted the pooler and took the substrate down for ~25 minutes.
   *
   * mt#2625's guarantee is preserved by the hard-release ceiling rather than
   * by this deadline — see {@link ABANDONED_TICK_HARD_RELEASE_MULTIPLIER}.
   * Defaults to {@link DEFAULT_TICK_TIMEOUT_MS}.
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
  /**
   * Opt-in backoff after repeated DOMAIN failures (mt#4294).
   *
   * Distinct from the bounded re-init above, which reacts to SCHEDULING
   * failures (a timeout, an unexpected throw) by restarting the interval. This
   * reacts to a tick that ran to completion and reported `ok: false` — the
   * work failed, the scheduler is fine, and re-running it on the very next
   * tick just reproduces the failure at full cadence.
   *
   * Opt-in rather than default because most sweeps are cheap and idempotent,
   * and retrying one promptly is the right behaviour; backing every sweeper
   * off on a transient blip would slow recovery across the board. A sweeper
   * asks for this when its failing tick is EXPENSIVE or when the failure
   * class it hits is typically persistent rather than momentary.
   *
   * Only meaningful for a tick that actually returns a {@link SweepTickResult}
   * — a tick returning `void` reports no domain outcome, so its failures are
   * invisible here and no backoff can ever engage.
   */
  domainFailureBackoff?: {
    /** Consecutive `ok: false` ticks before any skipping begins. */
    afterFailures: number;
    /** Ceiling on consecutively skipped ticks, so backoff never becomes a stop. */
    maxSkippedTicks: number;
  };
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
  const domainFailureBackoff = options.domainFailureBackoff ?? null;

  let running = false;
  let runningSinceMs: number | null = null;
  /**
   * Ticks still to be skipped by the domain-failure backoff (mt#4294). Zero
   * whenever the backoff is disengaged, which is also its state for every
   * sweeper that did not opt in.
   */
  let backoffTicksRemaining = 0;
  /**
   * When the in-flight tick was ABANDONED (exceeded `tickTimeoutMs`) but is
   * still holding the guard, mt#4335. Null whenever the current tick is still
   * within its budget. Read by the watchdog to pick which deadline applies.
   */
  let abandonedSinceMs: number | null = null;
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
    abandonedTicks: 0,
    abandonedTicksOutstanding: 0,
    abandonedTickHardReleases: 0,
    reportsDomainOutcome: false,
    // Compiler-guaranteed (mt#4412): `IntervalSweeperOptions.tick` returns
    // `Promise<SweepTickResult>`, so every interval sweep states an outcome.
    declaresDomainOutcome: true,
    selfScheduled: false,
    registeredAtMs: Date.now(),
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
      // mt#4335: two deadlines, and which one applies depends on whether the
      // in-flight tick has already been abandoned.
      //
      // NOT abandoned -> `tickTimeoutMs`, the pre-existing fail-safe for the
      // case where the primary `Promise.race` somehow did not fire at all.
      //
      // Abandoned -> the hard-release ceiling. The tick is deliberately still
      // holding the guard so its successor cannot open a second connection
      // beside it; force-releasing at `tickTimeoutMs` here would undo exactly
      // the fix and is the bug a naive implementation reintroduces.
      const releaseAfterMs =
        abandonedSinceMs !== null
          ? tickTimeoutMs * ABANDONED_TICK_HARD_RELEASE_MULTIPLIER
          : tickTimeoutMs;
      if (heldForMs > releaseAfterMs) {
        log.warn(
          `cockpit: ${name} sweep watchdog — guard held ${heldForMs}ms (> ${releaseAfterMs}ms); force-releasing`,
          {
            heldForMs,
            tickTimeoutMs,
            releaseAfterMs,
            abandoned: abandonedSinceMs !== null,
          }
        );
        // An abandoned tick force-released here is the case mt#2625 exists for
        // (a tick that never settles at all). Count it separately from the
        // ordinary abandonment: it means the tick outlived even the ceiling,
        // so its resources are still held with nothing left to release them.
        if (abandonedSinceMs !== null) entry.abandonedTickHardReleases++;
        running = false;
        runningSinceMs = null;
        abandonedSinceMs = null;
      }
    }

    if (running) return; // Overlapping tick — skip (pre-existing behavior).

    // Domain-failure backoff (mt#4294). Checked AFTER the overlap guard and
    // the watchdog above, so a wedged tick is still force-released on
    // schedule — backing off must not also postpone the fail-safe that
    // unwedges.
    if (backoffTicksRemaining > 0) {
      backoffTicksRemaining--;
      log.debug(`cockpit: ${name} sweep tick skipped by domain-failure backoff`, {
        backoffTicksRemaining,
      });
      return;
    }

    running = true;
    runningSinceMs = Date.now();

    // Per-tick timeout (mt#2625): race the real tick against a timer so a
    // hung dependency (DB call, subprocess, etc.) can never wedge the guard
    // forever.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timed-out"), tickTimeoutMs);
    });

    // mt#4335: fires at `tickTimeoutMs` so a tick holding a cancellable
    // resource can release it. The framework cannot do this on the tick's
    // behalf — it never sees the query — so this is the only channel by which
    // an abandoned tick's own work can actually be cancelled rather than
    // merely un-awaited.
    const abortController = new AbortController();

    let failed = false;
    // mt#4335: true once this tick has been abandoned, so the `finally` below
    // knows not to release a guard that is now owned by the settle handler.
    let abandoned = false;
    // null = this tick reported no domain outcome (the pre-mt#3684 behavior of
    // every sweep, and still the behavior of any tick returning nothing).
    let domainOk: boolean | null = null;

    // Held in a variable rather than inlined into the race (mt#4335): the
    // timeout path needs a handle on the abandoned promise so it can release
    // the guard when it eventually settles.
    const tickPromise = tick(abortController.signal).then((result) => {
      if (result && typeof result.ok === "boolean") domainOk = result.ok;
      return "completed" as const;
    });

    try {
      const outcome = await Promise.race([tickPromise, timedOut]);
      if (outcome === "timed-out") {
        abandoned = true;
        failed = true;
        abandonedSinceMs = Date.now();
        entry.abandonedTicks++;
        entry.abandonedTicksOutstanding++;
        abortController.abort(new Error(`${name} sweep tick exceeded ${tickTimeoutMs}ms`));
        log.warn(
          `cockpit: ${name} sweep tick timed out after ${tickTimeoutMs}ms — abandoned; HOLDING guard until it settles`,
          {
            tickTimeoutMs,
            hardReleaseAfterMs: tickTimeoutMs * ABANDONED_TICK_HARD_RELEASE_MULTIPLIER,
          }
        );

        const abandonedAtMs = abandonedSinceMs;
        // The abandoned tick is no longer awaited by anyone, so its rejection
        // must be absorbed here or it surfaces as an unhandled rejection —
        // which in the cockpit's supervisor is a process-level crash, i.e.
        // exactly the restart loop this incident already produced by another
        // route.
        void tickPromise
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`cockpit: ${name} abandoned sweep tick rejected after abandonment`, {
              message,
            });
          })
          .finally(() => {
            entry.abandonedTicksOutstanding--;
            // Only release if THIS tick is still the one holding the guard.
            // The watchdog's hard-release may have already handed the guard to
            // a successor, and releasing again here would free that
            // successor's guard from under it.
            if (abandonedSinceMs === abandonedAtMs) {
              running = false;
              runningSinceMs = null;
              abandonedSinceMs = null;
            }
            log.warn(`cockpit: ${name} abandoned sweep tick settled; guard released`, {
              heldAfterAbandonmentMs: Date.now() - abandonedAtMs,
            });
          });
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
      // mt#4335: an ABANDONED tick keeps the guard — its settle handler above
      // (or the watchdog's ceiling) owns the release. Releasing here is the
      // pre-mt#4335 behaviour and is precisely what let the next tick open a
      // second connection beside a predecessor that still held one.
      if (!abandoned) {
        running = false;
        runningSinceMs = null;
      }
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
        // A success disengages the backoff immediately, so recovery costs one
        // tick rather than draining whatever skip budget was outstanding. This
        // is the "until a recovery probe succeeds" half — the first tick that
        // is NOT skipped IS the probe.
        backoffTicksRemaining = 0;
      } else {
        entry.lastDomainFailureAtMs = Date.now();
        entry.consecutiveDomainFailures++;
        if (
          domainFailureBackoff !== null &&
          entry.consecutiveDomainFailures >= domainFailureBackoff.afterFailures
        ) {
          // Skip-count doubles per failure past the threshold and is clamped,
          // so a persistent failure decays toward a floor cadence instead of
          // stopping outright — a sweeper that stops never discovers that it
          // recovered.
          const over = entry.consecutiveDomainFailures - domainFailureBackoff.afterFailures;
          backoffTicksRemaining = Math.min(2 ** over, domainFailureBackoff.maxSkippedTicks);
          log.warn(
            `cockpit: ${name} sweep — ${entry.consecutiveDomainFailures} consecutive domain failures; skipping ${backoffTicksRemaining} tick(s)`,
            {
              consecutiveDomainFailures: entry.consecutiveDomainFailures,
              backoffTicksRemaining,
            }
          );
        }
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
// Self-scheduling participants (mt#4185)
// ---------------------------------------------------------------------------

/** Options accepted by {@link registerSelfSchedulingSweep}. */
export interface SelfSchedulingSweepOptions {
  /**
   * Human-readable name, unique among ACTIVE registrants — the same rule
   * {@link createIntervalSweeper} enforces, for the same reason.
   */
  name: string;
  /**
   * The longest legitimate gap between two
   * {@link SelfSchedulingSweepHandle.noteProgress} calls.
   *
   * This occupies `intervalMs` in the registry, so the meta-watchdog's stall
   * predicate applies unchanged: a participant is stalled once it has not
   * reported progress in {@link META_WATCHDOG_STALL_MULTIPLIER} times this
   * value. Derive it from a bound the system actually enforces rather than
   * picking a round number — a budget shorter than a legitimate work unit
   * produces a restart loop, and one much longer just delays detection.
   */
  progressBudgetMs: number;
  /**
   * Called when progress has stalled past the budget above.
   *
   * The registry cannot restart a loop it does not schedule, so the
   * participant supplies the recovery itself. It should return promptly —
   * abandoning or interrupting the stuck work — rather than awaiting it.
   */
  restart: () => void;
}

/** Returned by {@link registerSelfSchedulingSweep}. */
export interface SelfSchedulingSweepHandle {
  /**
   * Report that the loop advanced. Stamps `lastAttemptAt` — the SAME field,
   * with the same meaning, that a timer fire stamps for an interval sweep.
   *
   * Call it where the loop demonstrably moved, not on a timer of its own: a
   * signal that keeps firing while the work is wedged reports health through
   * the exact failure it exists to detect.
   */
  noteProgress(): void;
  /**
   * Report that a unit of work completed successfully — a DOMAIN outcome
   * (mt#4412), and also progress.
   *
   * This and {@link noteFailure} are the self-scheduling path's equivalent of
   * an interval tick returning a {@link SweepTickResult}, and they are how a
   * participant discharges the obligation
   * {@link SweepLivenessSnapshot.declaresDomainOutcome} records.
   * {@link noteProgress} does NOT: it says the loop advanced, which is exactly
   * the scheduling-only signal that cannot distinguish working from wedged.
   */
  noteSuccess(): void;
  /** Report that a unit of work failed — a DOMAIN outcome (mt#4412), and also progress (the loop is still cycling). */
  noteFailure(error?: unknown): void;
  /** Deregister. Idempotent; the meta-watchdog refuses to act on a stopped entry. */
  stop(): void;
}

/**
 * Register a loop that schedules ITSELF with the sweep-liveness registry
 * (mt#4185).
 *
 * {@link createIntervalSweeper} owns both halves of a sweep — it fires the
 * tick AND records that the tick fired — so registration is a side effect of
 * using it, and a loop that schedules itself had no way in. That gap is not
 * theoretical: `startPrincipalChannelPoller` parked on an unsettled await for
 * ~44 hours while `/api/sweeps` listed 16 healthy sweeps and never mentioned
 * it, because it was not a registrant (mt#4183).
 *
 * The split here is deliberate. The participant keeps its own scheduling — the
 * reason it is hand-rolled usually survives, as it does for a long poll that
 * must not overlap itself — and gives up only the RECORDING half, which is the
 * half the meta-watchdog needs. `startSweepMetaWatchdog` requires no knowledge
 * of this: it reads `stopped`, `lastAttemptAtMs`, `intervalMs` and `restart`,
 * none of which is specific to a `setInterval`.
 */
export function registerSelfSchedulingSweep(
  options: SelfSchedulingSweepOptions
): SelfSchedulingSweepHandle {
  const { name, progressBudgetMs, restart } = options;

  // Same duplicate-registration guard as createIntervalSweeper, and for the
  // same reason: a second ACTIVE entry under one name would overwrite the
  // registry's reference to the first, leaving it running with no
  // `/api/sweeps` visibility and no meta-watchdog reach.
  const existingActive = sweepLivenessRegistry.get(name);
  if (existingActive && !existingActive.stopped) {
    throw new Error(
      `cockpit: duplicate active sweep registration for "${name}" — a sweep with this name is ` +
        "already registered and running. Sweep names must be unique among active sweeps " +
        "(call the existing sweep's stop() first if this is an intentional restart)."
    );
  }

  let stopped = false;

  const entry: SweepLivenessEntry = {
    name,
    intervalMs: progressBudgetMs,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    consecutiveFailures: 0,
    reinits: 0,
    metaRestarts: 0,
    lastDomainSuccessAtMs: null,
    lastDomainFailureAtMs: null,
    consecutiveDomainFailures: 0,
    abandonedTicks: 0,
    abandonedTicksOutstanding: 0,
    abandonedTickHardReleases: 0,
    reportsDomainOutcome: false,
    // mt#4412: the handle's outcome methods (`noteSuccess`/`noteFailure`)
    // record a DOMAIN outcome, so a self-scheduling participant is obliged to
    // state one exactly as an interval sweep is. `noteProgress` remains
    // scheduling-only and deliberately does not satisfy the obligation.
    declaresDomainOutcome: true,
    selfScheduled: true,
    registeredAtMs: Date.now(),
    stopped: false,
    restart: (reason: SweepRestartReason): void => {
      if (stopped) return;
      if (reason === "meta-watchdog") {
        entry.metaRestarts++;
      } else {
        entry.reinits++;
      }
      // mt#3060: a restart that does not itself reset staleness cannot outrun
      // a watchdog scanning faster than the budget — the participant would be
      // restarted again on the very next scan, and every scan after it, before
      // its first post-restart progress call had a chance to land.
      entry.lastAttemptAtMs = Date.now();
      restart();
    },
    // Nothing to clear: the participant owns its own scheduling primitive, so
    // there is no handle here to drop. The TEST-ONLY dropped-timer simulation
    // this backs is meaningless for a self-scheduling participant — stopping
    // its progress calls is the equivalent, and needs no hook.
    clearUnderlyingTimer: () => {},
  };
  sweepLivenessRegistry.set(name, entry);

  const noteProgress = (): void => {
    if (stopped) return;
    entry.lastAttemptAtMs = Date.now();
  };

  return {
    noteProgress,
    noteSuccess(): void {
      if (stopped) return;
      const now = Date.now();
      entry.lastAttemptAtMs = now;
      entry.lastSuccessAtMs = now;
      entry.consecutiveFailures = 0;
      // mt#4412: ALSO a domain outcome. Until now this stamped only the
      // SCHEDULING fields, which is the same scheduling-vs-domain conflation
      // the interval path had — "a unit of work completed successfully" is a
      // statement about the WORK, so it belongs in both columns.
      entry.reportsDomainOutcome = true;
      entry.lastDomainSuccessAtMs = now;
      entry.consecutiveDomainFailures = 0;
    },
    noteFailure(error?: unknown): void {
      if (stopped) return;
      const now = Date.now();
      // A failure is still PROGRESS: the loop ran, failed, and will cycle
      // again. Conflating the two would make an erroring-but-alive loop
      // indistinguishable from a wedged one, which is the distinction the
      // meta-watchdog exists to draw.
      entry.lastAttemptAtMs = now;
      entry.lastErrorAtMs = now;
      entry.consecutiveFailures++;
      // mt#4412: ALSO a domain outcome — see `noteSuccess` above for why.
      entry.reportsDomainOutcome = true;
      entry.lastDomainFailureAtMs = now;
      entry.consecutiveDomainFailures++;
      log.warn(`cockpit: self-scheduling sweep "${name}" reported a failed cycle`, {
        name,
        consecutiveFailures: entry.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    },
    stop(): void {
      stopped = true;
      entry.stopped = true;
    },
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
      // Nothing reported yet. For an INTERVAL sweep that is a millisecond-scale
      // window — the registry drives the tick, so a stamp is imminent by
      // construction — and skipping is correct. For a SELF-SCHEDULING
      // participant nothing guarantees the stamp ever arrives: the registry does
      // not drive its loop, so a park before the first `noteProgress()` would
      // leave this null forever and the entry permanently unevaluated (mt#4206).
      // Measuring from REGISTRATION is what closes that, and it is the same
      // fallback mt#4183's health projection uses (`lastProgressAt ?? since`).
      if (entry.lastAttemptAtMs === null && !entry.selfScheduled) continue;
      const threshold = entry.intervalMs * META_WATCHDOG_STALL_MULTIPLIER;
      const referenceMs = entry.lastAttemptAtMs ?? entry.registeredAtMs;
      const staleMs = now - referenceMs;
      if (staleMs > threshold) {
        // A self-scheduling participant (mt#4185) has no timer of ours to
        // have stopped firing and no cadence to be a multiple of — the same
        // two numbers mean "progress" and "budget" there. Say which, so an
        // operator reading the line is not told about a tick that does not
        // exist.
        const stalled = entry.selfScheduled
          ? `has not reported progress in ${staleMs}ms (> ${threshold}ms, ` +
            `${META_WATCHDOG_STALL_MULTIPLIER}x its ${entry.intervalMs}ms progress budget)`
          : `has not attempted a tick in ${staleMs}ms (> ${threshold}ms, ` +
            `${META_WATCHDOG_STALL_MULTIPLIER}x its ${entry.intervalMs}ms cadence)`;
        log.warn(`cockpit: meta-watchdog — sweep "${entry.name}" ${stalled}; force-restarting`, {
          name: entry.name,
          staleMs,
          threshold,
          intervalMs: entry.intervalMs,
          selfScheduled: entry.selfScheduled,
        });
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const repo = await getServerAskRepository();
        if (!repo) {
          // Not a quiet no-op (mt#4412): with no ask repository the
          // advancement pass cannot run, so the WORK did not happen. Same
          // treatment `runProdStateRefreshTick` already gives a provider that
          // exposes no raw SQL.
          log.warn("cockpit: ask advancement sweep skipped — no ask repository available");
          return { ok: false };
        }
        const { runAskAdvancementSweep } = await import("@minsky/domain/ask/advancement");
        await runAskAdvancementSweep(repo);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: ask advancement sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const repo = await getServerAskRepository();
        if (!repo) {
          // Not a quiet no-op (mt#4412) — see `startAskAdvancementSweeper`.
          log.warn("cockpit: stale-ask close sweep skipped — no ask repository available");
          return { ok: false };
        }
        const { runStaleSuspendedAskCloseSweep } = await import(
          "@minsky/domain/ask/stale-suspended-close"
        );
        // NOTE: a failed task-status map is deliberately NOT a domain failure
        // below — the sweep degrades to skipping only its parent-terminal
        // pass, and its supersession and TTL passes still run. That partial
        // degradation is logged where it happens.
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
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: stale-ask close sweep failed", { message });
        return { ok: false };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Service-window sweeper (mt#4313)
// ---------------------------------------------------------------------------

/**
 * Tick cadence for the service-window sweep.
 *
 * 60s matches `ServiceWindowReaper`'s own default `pollIntervalMs`. This sweep
 * drives that poll DIRECTLY rather than calling `reaper.startDeadlinePoll()`,
 * which would spin a second `setInterval` invisible to
 * {@link getSweepLivenessSnapshot} and to {@link startSweepMetaWatchdog} —
 * i.e. exactly the un-observable background loop mt#4313 exists to stop
 * shipping.
 */
const SERVICE_WINDOW_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * RETIRED — deliberately has no caller (mt#4410, 2026-08-21).
 *
 * The principal retired the attention-window concept: *"Forget about the
 * windows. I don't think it's an important concept anymore."* The daemon no
 * longer starts this; `src/commands/cockpit/start-command.ts` carries the
 * matching note where the call used to be.
 *
 * **This being uncalled is intentional, not the bug it looks like.** That
 * distinction is load-bearing here, because an exported-but-uncalled entry
 * point in exactly this subsystem is what mt#4313 existed to fix: mt#1490
 * shipped a reaper nothing constructed and mt#1489 shipped a cron firer
 * nothing called, both for months. Do not "restore" this wiring on the
 * strength of that resemblance — revive mt#1411 (the service-window design,
 * CLOSED) first, and confirm the concept is wanted again.
 *
 * Worth knowing if it is ever revived: the cron half fired correctly on
 * 2026-08-21 at 20:00:09Z (`service window: opened on schedule`) and the 25
 * asks bound to `ask-hours` were still `suspended` afterward. The wake path
 * was never verified end-to-end, so this code is retired UNPROVEN rather than
 * working-but-unwanted.
 *
 * ---
 *
 * Drive the service-window runtime: open windows on their cron schedule, close
 * them when their duration elapses, and run the reaper that awakens the asks
 * suspended against them.
 *
 * ## Why this exists (mt#4313)
 *
 * mt#1411's design shipped as four children on 2026-05-01 and TWO of them
 * closed DONE with their invocation path undelivered:
 *
 *   - mt#1489 owed "Cron-scheduled windows auto-open at the right time".
 *     `checkAndFireCronWindows` was written and exported; nothing called it.
 *   - mt#1490 owed "Reaper service runs as a long-lived process or job".
 *     `ServiceWindowReaper` was written and tested; nothing constructed it.
 *
 * A third piece was never written at all: nothing closed a window when its
 * `durationMin` elapsed, so `onWindowClosed` — miss-counting and escalation —
 * could only ever fire from a manual `window close`.
 *
 * All three are one tick's worth of work and are wired here together, because
 * any one of them alone delivers nothing observable: a reaper with no window
 * opening is idle, and a window opening with no reaper wakes nothing.
 *
 * ## Escalation is deliberately OFF in v1
 *
 * `windowConfigs` is intentionally NOT passed to the reaper. Per its own
 * contract that disables missed-window escalation while leaving miss-COUNTING
 * intact, so an unanswered cohort still accrues `window_missed_count` and is
 * still re-batched — it just never reaches `escalateAsk`, which would set
 * `forceImmediate` on every member and dispatch via an "escalation transport"
 * that does not exist yet (mt#1545 owns the real dispatch contract). Turning
 * escalation on before there is somewhere for it to escalate TO would mutate
 * shared ask state on a schedule to no effect.
 *
 * The dispatch callback is likewise log-only for the same reason. That is not
 * a no-op in practice: the transition to `routed` is what the window surfaces
 * read (`pendingAsksForWindow` covers `routed` and `suspended` alike), so a
 * woken cohort is visible in the Attention widget, `window status` and
 * `window service` without any transport at all.
 *
 * Fail-open throughout, per the sibling sweepers: no repository, no
 * LISTEN-capable connection, or a failing pass logs and waits for the next
 * tick.
 *
 * @returns stop function (clears the interval and tears down subscriptions).
 */
export function startServiceWindowSweeper(intervalMs?: number): () => void {
  // Per-window last-auto-open timestamps. `checkAndFireCronWindows` requires
  // the CALLER to hold this across ticks — it is what keeps a window whose
  // cron minute is still current from re-firing on the very next tick.
  const lastFiredAt = new Map<string, Date>();

  // The reaper is REBUILT every tick around a freshly-resolved repository, and
  // this box is what the NOTIFY handlers read (mt#4364).
  //
  // The original mt#4313 wiring built it once and let it hold its repository
  // for the process lifetime. Every sibling sweeper in this file re-resolves
  // `getServerAskRepository()` per tick, and that is not incidental: the pool
  // recycles (`/api/health` reported `recycleCount: 10` within four hours), and
  // a handle captured before a recycle raises for the rest of the process. The
  // shipped sweep succeeded for six minutes and then failed on every one of its
  // next ~390 ticks, all on `listByState("suspended")`.
  //
  // Rebuilding is cheap — the reaper holds references, not connections — but
  // the miss counter must NOT be rebuilt with it, hence the hoisted store.
  const reaperRef: { current: ServiceWindowReaperInstance | null } = { current: null };
  let counterStore: unknown = null;
  let unsubscribe: (() => Promise<void>) | null = null;
  let subscribed = false;

  const stopInterval = createIntervalSweeper({
    name: "service window",
    intervalMs: intervalMs ?? SERVICE_WINDOW_SWEEP_INTERVAL_MS,
    tick: async (): Promise<SweepTickResult> => {
      try {
        const repo = await getServerAskRepository();
        // No repository yet is "nothing to do", not a failure — the daemon
        // starts sweepers before persistence is guaranteed up.
        if (!repo) return { ok: true };

        const [
          { ServiceWindowReaper },
          { createProviderWindowNotifier },
          { InMemoryForceImmediateCounterStore },
          { loadAttentionWindowsOrThrow },
          windowCommands,
        ] = await Promise.all([
          import("@minsky/domain/ask/service-window-reaper"),
          import("@minsky/domain/ask/attention-windows/notify"),
          import("@minsky/domain/ask/force-immediate-counters"),
          import("@minsky/domain/ask/attention-windows/loader"),
          import("../adapters/shared/commands/window/index"),
        ]);

        // Survives the per-tick rebuild so `window_missed_count` bookkeeping is
        // not reset every 60 seconds.
        counterStore ??= new InMemoryForceImmediateCounterStore();

        // Bound to a local const, then published to the ref. Reading it back
        // off `reaperRef.current` typechecked only through assignment
        // narrowing, which any statement inserted between would silently break
        // (PR #3198 R1 BLOCKING #1).
        const reaper = new ServiceWindowReaper(
          repo,
          async (ask, reason) => {
            // Log-only dispatch (see docblock). The state transition IS the
            // delivery for the window surfaces; a transport belongs to mt#1545.
            log.info("service window: ask awakened", {
              askId: ask.id,
              kind: ask.kind,
              windowKey: ask.windowKey,
              reason,
            });
          },
          {},
          counterStore as ConstructorParameters<typeof ServiceWindowReaper>[3]
        );
        reaperRef.current = reaper;

        // Subscribe ONCE. The handlers read `reaperRef.current`, so they keep
        // working across the per-tick rebuild above without re-registering
        // LISTEN on every tick.
        if (!subscribed) {
          subscribed = true;
          await subscribeReaperToWindowEvents(reaperRef).then(
            (unsub) => {
              unsubscribe = unsub;
            },
            (err) => {
              // Retry on a later tick rather than latching: a subscription that
              // failed because persistence was still coming up must not leave
              // window-open awakening off for the process lifetime.
              subscribed = false;
              const message = err instanceof Error ? err.message : String(err);
              log.warn("service window: NOTIFY subscription failed; window-open wake is inactive", {
                message,
              });
            }
          );
        }

        const provider = await getCachedPersistenceProvider().catch(() => null);
        const notifier = createProviderWindowNotifier(
          // A null provider degrades to a logged no-op inside the notifier
          // rather than throwing.
          (provider ?? undefined) as Parameters<typeof createProviderWindowNotifier>[0]
        );
        const registry = windowCommands.globalRegistry;

        return await runServiceWindowTick({
          now: () => new Date(),
          fireCronWindows: (now) =>
            windowCommands.checkAndFireCronWindows(notifier, registry, lastFiredAt, now),
          listOpenWindows: () =>
            registry.getAllOpen().map((o) => ({
              windowKey: o.windowKey,
              expectedCloseAt: o.expectedCloseAt,
            })),
          closeWindow: async (windowKey) => {
            await windowCommands.closeWindow(windowKey, loadAttentionWindowsOrThrow(), notifier);
          },
          pollDeadlineBound: (nowMs) => reaper.pollDeadlineBoundAsks(nowMs),
        });
      } catch (err) {
        // Report the DOMAIN failure, do not just log it (mt#4364).
        //
        // This catch previously returned normally, so `createIntervalSweeper`
        // recorded a successful tick and `/api/sweeps` showed
        // `consecutiveFailures: 0, lastErrorAt: null` while 100% of ticks were
        // failing. mt#4313 shipped this sweep to stop unobservable background
        // loops and then made itself one — the liveness entry was the evidence
        // offered for its own health criterion.
        const message = err instanceof Error ? err.message : String(err);
        log.warn("service window sweep failed", { message });
        return { ok: false };
      }
    },
  });

  return () => {
    stopInterval();
    void unsubscribe?.().catch(() => {
      // intentional-swallow: the process is shutting down and the LISTEN
      // connection is torn down with the provider regardless.
    });
  };
}

/** The reaper instance type, named once so the ref box below stays readable. */
type ServiceWindowReaperInstance =
  import("@minsky/domain/ask/service-window-reaper").ServiceWindowReaper;

/** What one service-window tick did. */
export interface ServiceWindowTickOutcome extends SweepTickResult {
  /** Window keys opened because their cron schedule came due. */
  opened: string[];
  /** Window keys closed because their duration elapsed. */
  closed: string[];
  /** Windows whose auto-close threw; the tick continues past each. */
  closeFailures: number;
  /** Deadline-bound asks the reaper dispatched this tick. */
  dispatched: number;
}

/**
 * RETIRED with the service-window concept (mt#4410) — reachable only from
 * {@link startServiceWindowSweeper}, which the daemon no longer calls. Read that
 * function's header before reviving anything here. Its tests still run.
 *
 * The service-window tick's decisions, with its IO injected (mt#4313).
 *
 * Extracted from the sweeper above for the same reason
 * {@link runProdStateRefreshTick} was: the sweeper reaches its collaborators
 * through dynamic imports and a module-level `globalRegistry` singleton, so
 * there is no other seam, and patching those in place is what ADR-036 bans.
 *
 * A failing auto-close is contained per-window rather than aborting the tick:
 * one window whose config went missing must not stop the others from closing,
 * and must not stop the deadline poll from running at all.
 */
export async function runServiceWindowTick(deps: {
  /** Current time, injected so a test can drive a schedule without waiting. */
  now: () => Date;
  /** Open any window whose cron schedule is due; returns the keys opened. */
  fireCronWindows: (now: Date) => Promise<string[]>;
  /** Currently-open windows and when each is due to close. */
  listOpenWindows: () => { windowKey: string; expectedCloseAt: Date }[];
  /** Close one window — this is what emits the NOTIFY miss-counting reads. */
  closeWindow: (windowKey: string) => Promise<void>;
  /** Run the reaper's deadline-bound poll; returns how many it dispatched. */
  pollDeadlineBound: (nowMs: number) => Promise<number>;
}): Promise<ServiceWindowTickOutcome> {
  const now = deps.now();
  const outcome: ServiceWindowTickOutcome = {
    ok: true,
    opened: [],
    closed: [],
    closeFailures: 0,
    dispatched: 0,
  };

  // Every dependency call below is contained, so ONE failing step degrades this
  // tick's outcome without cancelling the others and without discarding the
  // counts already collected (PR #3198 R2 BLOCKING).
  //
  // Containing only the auto-close, as the first cut did, left the contract
  // inconsistent: a throwing `pollDeadlineBound` escaped to the caller's outer
  // catch, which reports `ok: false` correctly but loses `opened`/`closed`, and
  // a direct caller of this exported function got a throw where the return type
  // promises an outcome.

  // 1. Open any window whose cron schedule is due (mt#1489's criterion).
  try {
    outcome.opened = await deps.fireCronWindows(now);
    if (outcome.opened.length > 0) {
      log.info("service window: opened on schedule", { windows: outcome.opened });
    }
  } catch (err) {
    outcome.ok = false;
    const message = err instanceof Error ? err.message : String(err);
    log.warn("service window: cron open failed", { message });
  }

  // 2. Close any open window past its expected close time. Nothing did this
  //    before, so `onWindowClosed` never fired without an operator typing it.
  let openWindows: { windowKey: string; expectedCloseAt: Date }[] = [];
  try {
    openWindows = deps.listOpenWindows();
  } catch (err) {
    outcome.ok = false;
    const message = err instanceof Error ? err.message : String(err);
    log.warn("service window: could not enumerate open windows", { message });
  }

  for (const open of openWindows) {
    if (open.expectedCloseAt.getTime() > now.getTime()) continue;
    try {
      await deps.closeWindow(open.windowKey);
      outcome.closed.push(open.windowKey);
      log.info("service window: closed on duration elapse", { windowKey: open.windowKey });
    } catch (err) {
      outcome.closeFailures++;
      // A window that should have closed and did not is a domain failure, even
      // though the tick continues past it to the other windows and the poll.
      outcome.ok = false;
      const message = err instanceof Error ? err.message : String(err);
      log.warn("service window: auto-close failed", { windowKey: open.windowKey, message });
    }
  }

  // 3. Deadline-bound poll. Driven here rather than by the reaper's own timer
  //    so this sweep's liveness entry covers it (see the sweeper's docblock).
  try {
    outcome.dispatched = await deps.pollDeadlineBound(now.getTime());
  } catch (err) {
    outcome.ok = false;
    const message = err instanceof Error ? err.message : String(err);
    log.warn("service window: deadline poll failed", { message });
  }

  return outcome;
}

/**
 * RETIRED with the service-window concept (mt#4410) — reachable only from
 * {@link startServiceWindowSweeper}, which the daemon no longer calls. Nothing
 * subscribes to the window channels now; read that function's header first.
 *
 * Subscribe a reaper to the two window NOTIFY channels.
 *
 * Uses the provider's MEMOIZED listen-capable connection
 * (`getListenCapableSqlConnection`, `max: 1`, `idle_timeout: 0`), so this adds
 * two LISTEN registrations to the connection the SSE broker already holds
 * rather than opening a second one — which matters because per-process
 * connection budget is a measured constraint here (mt#4308).
 *
 * @returns an unsubscribe function.
 * @throws when the provider is not Postgres-backed or the LISTEN connection
 *   cannot be obtained — the caller degrades rather than failing the tick.
 */
async function subscribeReaperToWindowEvents(reaperRef: {
  current: ServiceWindowReaperInstance | null;
}): Promise<() => Promise<void>> {
  const [{ PostgresChannelListener }, { CHANNEL_OPENED, CHANNEL_CLOSED }] = await Promise.all([
    import("@minsky/domain/mesh/postgres-channel-listener"),
    import("@minsky/domain/ask/attention-windows/notify"),
  ]);

  const provider = await getCachedPersistenceProvider();
  if (
    typeof provider !== "object" ||
    provider === null ||
    !("getListenCapableSqlConnection" in provider) ||
    typeof (provider as { getListenCapableSqlConnection?: unknown })
      .getListenCapableSqlConnection !== "function"
  ) {
    throw new Error("persistence provider has no LISTEN-capable connection");
  }

  const sqlProvider = provider as {
    getListenCapableSqlConnection: () => Promise<ReturnType<typeof import("postgres")>>;
  };
  const listener = new PostgresChannelListener(await sqlProvider.getListenCapableSqlConnection());

  // Both handlers discard their return value: `onWindowClosed` resolves to a
  // summary the listener contract has no channel for, and `ChannelListenerFn`
  // is `void | Promise<void>`.
  //
  // They read `reaperRef.current` at CALL time rather than closing over one
  // instance, so the per-tick rebuild (mt#4364) does not leave this
  // subscription pointed at a reaper holding a dead repository handle.
  const onOpened = async (_channel: string, payload: unknown): Promise<void> => {
    const reaper = reaperRef.current;
    if (!reaper) return;
    await reaper.onWindowOpened(payload as Parameters<typeof reaper.onWindowOpened>[0]);
  };
  const onClosed = async (_channel: string, payload: unknown): Promise<void> => {
    const reaper = reaperRef.current;
    if (!reaper) return;
    await reaper.onWindowClosed(payload as Parameters<typeof reaper.onWindowClosed>[0]);
  };

  // Roll back a PARTIAL subscription (PR #3198 R1 BLOCKING #2).
  //
  // These are two separate `subscribe` calls. If the second throws, the first
  // stays registered on the listener and the caller never receives an
  // unsubscribe handle for it — so the registration leaks, and the caller's
  // retry-on-failure path would then register it a SECOND time, delivering
  // every window-open event twice.
  const registered: string[] = [];
  try {
    await listener.subscribe(CHANNEL_OPENED, onOpened);
    registered.push(CHANNEL_OPENED);
    await listener.subscribe(CHANNEL_CLOSED, onClosed);
    registered.push(CHANNEL_CLOSED);
  } catch (err) {
    for (const channel of registered) {
      await listener
        .unsubscribe(channel, channel === CHANNEL_OPENED ? onOpened : onClosed)
        .catch((cleanupErr: unknown) => {
          // Report, never mask the original failure that is about to rethrow.
          const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          log.warn("service window: rollback of partial NOTIFY subscription failed", {
            channel,
            message,
          });
        });
    }
    throw err;
  }

  let torn = false;
  return async () => {
    // Idempotent: the caller may invoke this on stop after having already
    // dropped the handle, and double-unsubscribing is not a no-op on every
    // listener implementation.
    if (torn) return;
    torn = true;
    await listener.unsubscribe(CHANNEL_OPENED, onOpened);
    await listener.unsubscribe(CHANNEL_CLOSED, onClosed);
  };
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
export const PROD_STATE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

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
    tick: async (): Promise<SweepTickResult> => {
      const { getSharedPersistenceService } = await import("./shared-persistence");
      const svc = await getSharedPersistenceService();
      const provider = svc.getProvider();
      const hasRawSql =
        "getRawSqlConnection" in provider &&
        typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function";
      if (!hasRawSql) {
        // Not a quiet no-op (mt#4412) — a provider without raw SQL cannot
        // refresh the map, which is the same condition
        // `runProdStateRefreshTick` already reports as a failure.
        log.warn("cockpit: short-id map refresh skipped — provider exposes no raw SQL connection");
        return { ok: false };
      }
      const sql = await (
        provider as { getRawSqlConnection: () => Promise<unknown> }
      ).getRawSqlConnection();
      const { refreshShortIdMapCache } = await import("./short-id-map-cache");
      // `refreshShortIdMapCache` has ALWAYS returned its own boolean outcome;
      // the tick simply discarded it (mt#4412). No new signal is invented
      // here — an existing one is stopped from being thrown away.
      return {
        ok: await refreshShortIdMapCache(
          sql as import("./short-id-map-cache").UnsafeSql | null | undefined,
          Date.now()
        ),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Ask-state refresh sweeper (mt#3744)
// ---------------------------------------------------------------------------

/**
 * Refresh interval for the ask-state snapshot the calibration-review cadence
 * detector reads.
 *
 * Grounded in what the snapshot is used to decide, not a round number
 * (`decision-defaults.mdc §Thresholds`): the state it tracks changes when the
 * OPERATOR answers a calibration disposition ask, and the failure this task's
 * parent (mt#3270) exists to prevent is reporting an answered ask as still
 * pending. Five minutes matches `startShortIdMapSweeper`'s cadence in the same
 * process — a second tick against the same warm pool is close to free — and
 * bounds "answered but still reported pending" to one sweep interval.
 */
const ASK_STATE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The ask-state tick's decision, with its IO injected (the mt#3684 shape).
 *
 * Extracted from the sweeper below so each failure path can be exercised without
 * patching `./shared-persistence` or `./ask-state-cache` in place, which ADR-036
 * bans — the tick reaches both through dynamic imports, so there is no other
 * seam.
 *
 * **Every exit reports a domain outcome** via {@link SweepTickResult}, so a
 * persistently failing tick is visible at `GET /api/sweeps` instead of looking
 * like a healthy sweep that had nothing to do — the mt#3684 gap that let ~130
 * consecutive prod-state failures read as clean.
 *
 * A repo with no watermark file, or one with no pending disposition asks, is a
 * SUCCESS that writes an empty snapshot — not a skip. That write is what lets
 * the consumer tell "the producer is running and this ask is not pending" from
 * "the producer has never run", which is the distinction SC3 asks for.
 */
export async function runAskStateRefreshTick(deps: {
  /** Resolve the producer's repo root (where the watermark store lives). */
  resolveRepoRoot: () => string;
  /** Read the watermark store's `openAskId` set for that repo root. */
  readAskIds: (repoRoot: string) => string[];
  /** Resolve the provider's raw-SQL accessor, or null when it exposes none. */
  resolveRawSql: () => Promise<(() => Promise<unknown>) | null>;
  /** Refresh the cache; returns whether it actually wrote. */
  refresh: (sql: unknown, askIds: string[], nowIso: string) => Promise<boolean>;
  /** Injectable clock so a test need not depend on wall time. */
  now?: () => string;
  /**
   * Warning sink, defaulting to the real logger. Injected rather than patched
   * because on the no-raw-SQL path the log IS the behavior under test
   * (`testing-boundaries.mdc` §support vs diagnostic; ADR-036 bans patching the
   * logger to observe it).
   */
  logWarn?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<SweepTickResult> {
  const warn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));
  try {
    const askIds = deps.readAskIds(deps.resolveRepoRoot());
    const getRawSql = await deps.resolveRawSql();
    if (!getRawSql) {
      // A provider without raw SQL cannot refresh the snapshot, so this is a
      // failure rather than a quiet no-op — the consumer will go on rendering
      // the previous snapshot as it ages into "stale".
      warn("cockpit: ask-state refresh sweep skipped — provider exposes no raw SQL connection");
      return { ok: false };
    }
    const sql = await getRawSql();
    const nowIso = (deps.now ?? (() => new Date().toISOString()))();
    return { ok: await deps.refresh(sql, askIds, nowIso) };
  } catch (err) {
    warn("cockpit: ask-state refresh sweep failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/**
 * Start the periodic ask-state refresh in this cockpit process (mt#3744).
 *
 * The PRODUCER half: reads the state of every ask the calibration watermark
 * store names as an open disposition and writes them to a local cache the
 * `calibration-review-cadence-detector` hook reads. The hook cannot do this read
 * itself — ADR-028 D7(5) routes unbounded-latency network I/O out of the
 * synchronous dispatcher budget, and a measured cold connect from a hook-shaped
 * process is 2.5-5.5s against that guard's 10s allowance (mt#3879).
 *
 * Fail-open: no DB / a failed read logs and waits for the next tick, leaving the
 * last-good snapshot in place. Overlapping ticks skip.
 *
 * @returns stop function (clears the interval).
 */
export function startAskStateRefreshSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "ask-state refresh",
    intervalMs: intervalMs ?? ASK_STATE_REFRESH_INTERVAL_MS,
    tick: () =>
      runAskStateRefreshTick({
        resolveRepoRoot: () => findRepoRoot([process.cwd()]) ?? process.cwd(),
        readAskIds: (repoRoot) => readWatermarkAskIds(repoRoot),
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
        refresh: async (sql, askIds, nowIso) => {
          const { refreshAskStateCache } = await import("./ask-state-cache");
          return refreshAskStateCache(
            sql as import("./ask-state-cache").UnsafeSql | null | undefined,
            askIds,
            nowIso
          );
        },
      }),
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const { refreshDispatchWatchdogCache } = await import("./dispatch-watchdog");
        // Already returns its own boolean outcome (false on no SQL-capable
        // DB); the tick discarded it until mt#4412.
        return { ok: await refreshDispatchWatchdogCache() };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: dispatch watchdog sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const { refreshTopologyCache } = await import("./topology-cache");
        // Already returns its own boolean outcome; the tick discarded it until
        // mt#4412.
        return { ok: await refreshTopologyCache(new Date().toISOString()) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: topology sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        // Resolve deps: injected (for tests) or real (for production).
        let sweepDeps: TranscriptSweepDeps | null;
        if (opts?.deps) {
          sweepDeps = opts.deps;
        } else {
          sweepDeps = await buildRealSweepDeps();
        }

        if (!sweepDeps) {
          // mt#4412 — cannot sweep, so not a healthy no-op.
          log.debug("cockpit: transcript sweep: no SQL-capable DB, skipping tick");
          return { ok: false };
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
            // mt#4412: a domain failure, even though the pause is DELIBERATE
            // and correct. The sweep is not doing its work, and a daemon left
            // schema-behind indefinitely is exactly the standing inertness
            // this field exists to expose. Self-clearing — the next tick after
            // the migration lands reports ok again — and harmless, because
            // domain failures are reported, never acted on (no re-init, no
            // restart; see the domain-outcome block in createIntervalSweeper).
            return { ok: false };
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
          // Can't meaningfully record a completed sweep if ingest threw.
          return { ok: false };
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
        let embeddingsOk = true;
        try {
          await runEmbeddings();
          tracker.recordEmbedRunCompleted();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: transcript sweep: embedding backfill failed (non-fatal)", {
            message,
          });
          tracker.recordSweepError();
          embeddingsOk = false;
          // No return: the ingest phase already completed successfully.
        }

        // mt#4412: this sweep has TWO phases, so one boolean has to say
        // something honest about both. Non-fatal to the tick is not the same
        // as fine — a permanently failing embedding backfill already called
        // `recordSweepError()` on every pass, and reporting `ok: true` beside
        // that would be the contradiction this task exists to remove.
        // `sessionsErrored` is included for the same reason: a sweep that
        // processes every session and errors on all of them did not succeed.
        return { ok: embeddingsOk && ingestResult.sessionsErrored === 0 };
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
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const { getSharedProvider } = await import("./shared-persistence");
        const { triggerDeploySmokeSweep } = await import("./deploy-smoke-sweep");
        const provider = await getSharedProvider();
        // mt#4412 widened `triggerDeploySmokeSweep` from `void` to a boolean
        // rather than letting this sweep take the documented "not decidable at
        // the tick boundary" exception. It IS decidable — the function's
        // several do-nothing paths are healthy and its two attempted-but-
        // failed paths are not — and a blanket `ok: true` here would have
        // reported a permanently no-oping emit as healthy.
        return { ok: await triggerDeploySmokeSweep(provider) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: deploy.smoke sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const service: FollowUpSweepDeps | null = opts?.deps ?? (await getServerFollowUpService());
        if (!service) {
          // mt#4412: a provider that cannot serve follow-ups means the work
          // did not happen. Reported as a domain failure for the same reason
          // `runProdStateRefreshTick` reports a missing raw-SQL provider —
          // "cannot do the work" is not the same as "nothing to do", and only
          // the second is healthy.
          log.debug("cockpit: follow-up sweep: no SQL-capable DB, skipping tick");
          return { ok: false };
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
        // The sweep's OWN result: a tick that fired nothing because nothing
        // was due is healthy; a tick where a due follow-up failed to fire is
        // not. `errored` is the discriminator and it was already computed —
        // it just never left the tick (mt#4412).
        return { ok: errored.length === 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: follow-up sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
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
          // mt#4412: cannot do the work, so not a healthy no-op.
          log.debug("cockpit: presence sweep: no SQL-capable DB, skipping tick");
          return { ok: false };
        }
        const db = await getDb();
        if (!db) {
          log.debug("cockpit: presence sweep: database connection unavailable, skipping tick");
          return { ok: false };
        }

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
        // A tick that found no transitions is genuinely healthy here — unlike
        // the sweeps above, "nothing changed" is this sweep's normal result
        // rather than a sign it could not run, and the cannot-run cases are
        // already reported as failures above.
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation presence sweep failed", { message });
        return { ok: false };
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
    /** mt#4179 — why the skips happened; `skipped` alone cannot say. */
    skippedNoTurns?: number;
    skippedNoContent?: number;
    skippedNoSubject?: number;
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const deps = options?.deps ?? (await buildRealTitleSweepDeps());
        if (!deps) {
          // This comment previously read "Not an error — a non-SQL provider
          // simply has nothing to title", logged so a permanently-idle
          // sweeper stayed distinguishable from a working one with no backlog
          // (PR #2408 R1). mt#4412 changes the ANSWER without disputing the
          // reasoning: that distinction now has a field of its own, and it is
          // exactly what the field is for. A provider that cannot title
          // anything is inert, not idle — "nothing to title" would be
          // `candidates: 0` from a real run.
          log.debug("cockpit: conversation title sweep skipped (no SQL persistence)");
          return { ok: false };
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
            // mt#4179 — a full batch of skips is the head-of-line signature, and
            // `skipped` alone reads identically to a healthy quiet tick. The
            // breakdown says which kind of nothing happened.
            skippedNoTurns: result.skippedNoTurns ?? 0,
            skippedNoContent: result.skippedNoContent ?? 0,
            skippedNoSubject: result.skippedNoSubject ?? 0,
            errored: result.errored,
          });
        }
        // `errored > 0` was already named above as "the signal that titling is
        // failing while the sweeper itself looks healthy" — mt#4412 is what
        // finally routes that signal somewhere a reader sees it.
        return { ok: result.errored === 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation title sweep failed", { message });
        return { ok: false };
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
    tick: async (): Promise<SweepTickResult> => {
      try {
        const deps = options?.deps ?? (await buildRealSummarySweepDeps());
        if (!deps) {
          // mt#4412 — inert, not idle. See the title sweep above.
          log.debug("cockpit: conversation summary sweep skipped (no SQL persistence)");
          return { ok: false };
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
        // `transcriptsErrored > 0` is named above as the signal that
        // summarizing is failing while the sweeper looks healthy — "the shape
        // that let the original no-caller gap sit unnoticed". mt#4412 gives it
        // a reader.
        return { ok: result.transcriptsErrored === 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: conversation summary sweep failed", { message });
        return { ok: false };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Guard-events exhaust sweep (mt#4035, mt#3334 phase 3)
// ---------------------------------------------------------------------------

const GUARD_EVENTS_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const GUARD_EVENTS_SWEEP_TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Injectable for tests; production wiring resolves the real DB + fs deps. */
export interface GuardEventsSweepResult {
  streamsChecked: number;
  totalRead: number;
  totalInserted: number;
  totalErrors: number;
}

export interface GuardEventsSweepDeps {
  runSweep: () => Promise<GuardEventsSweepResult>;
}

export interface GuardEventsSweepOptions {
  intervalMs?: number;
  deps?: GuardEventsSweepDeps;
}

/**
 * Resolve the guard-events sweep cadence. An explicit
 * `MINSKY_GUARD_EVENTS_SWEEP_INTERVAL_MS` env override (positive-integer
 * milliseconds) wins; otherwise the default.
 */
export function resolveGuardEventsSweepIntervalMs(): number {
  const raw = process.env.MINSKY_GUARD_EVENTS_SWEEP_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    log.warn("cockpit: ignoring invalid MINSKY_GUARD_EVENTS_SWEEP_INTERVAL_MS", { raw });
  }
  return GUARD_EVENTS_SWEEP_INTERVAL_MS;
}

async function buildRealGuardEventsSweepDeps(): Promise<GuardEventsSweepDeps | null> {
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

  const runSweep = async (): Promise<GuardEventsSweepResult> => {
    const { buildGuardEventsIngestDeps } = await import(
      "@minsky/domain/guard-events/ingest-runtime"
    );
    const { runGuardEventsIngestSweep } = await import(
      "@minsky/domain/guard-events/ingest-service"
    );
    const deps = buildGuardEventsIngestDeps(db);
    const summary = await runGuardEventsIngestSweep(deps);
    for (const s of summary.perStream) {
      if (s.error) {
        log.warn("cockpit: guard-events sweep: stream failed", {
          stream: s.stream,
          error: s.error,
        });
      }
    }
    return {
      streamsChecked: summary.streamsChecked,
      totalRead: summary.totalRead,
      totalInserted: summary.totalInserted,
      totalErrors: summary.totalErrors,
    };
  };

  return { runSweep };
}

/**
 * Start the periodic guard/calibration exhaust sweep in this cockpit process
 * (mt#4035, mt#3334 phase 3).
 *
 * THE CORRECTNESS LAYER for this ingest — per ADR-017/mt#2313, the SessionEnd
 * hook (`.minsky/hooks/guard-events-ingest-on-session-end.ts`) is a latency
 * optimization only, since SessionEnd does not fire (or complete) on
 * `/exit`, `/clear`, or an async kill. This sweep runs on a fixed cadence
 * regardless of any SessionEnd event, so completeness does not depend on how
 * a conversation happened to end. Every stream's dedupe key makes a full
 * re-scan (a dropped/invalid HWM cursor) SAFE — the same property that makes
 * this sweep and the SessionEnd hook safe to run concurrently.
 *
 * Sweeper convention (mirrors startTranscriptSweepBackstop): `running`-flag
 * overlap guard + fail-open try/catch + boot tick + `setInterval`/`.unref()`
 * via `createIntervalSweeper`.
 *
 * @returns stop function (clears the interval).
 */
export function startGuardEventsSweepBackstop(options?: GuardEventsSweepOptions): () => void {
  const resolvedInterval = options?.intervalMs ?? resolveGuardEventsSweepIntervalMs();

  return createIntervalSweeper({
    name: "guard-events sweep backstop",
    intervalMs: resolvedInterval,
    tickTimeoutMs: GUARD_EVENTS_SWEEP_TICK_TIMEOUT_MS,
    tick: async (): Promise<SweepTickResult> => {
      try {
        const deps = options?.deps ?? (await buildRealGuardEventsSweepDeps());
        if (!deps) {
          // mt#4412 — cannot sweep, so not a healthy no-op.
          log.debug("cockpit: guard-events sweep: no SQL-capable DB, skipping tick");
          return { ok: false };
        }
        const result = await deps.runSweep();
        // SC2: a per-stream error is already logged inside runSweep above;
        // this is the per-run observable summary line (SC2's "per-run
        // observable" requirement). UNCONDITIONAL (mt#4035 R1) — a guarded
        // log here made "swept 40 streams, found nothing new" indistinguishable
        // from "this tick never ran at all" in the log stream. Every field
        // that answers "did the sweep run, and what did it see" belongs on
        // every tick, zero or not.
        log.info("cockpit: guard-events sweep complete", {
          streamsChecked: result.streamsChecked,
          totalRead: result.totalRead,
          totalInserted: result.totalInserted,
          totalErrors: result.totalErrors,
        });
        // Per-stream errors are logged inside `runSweep`; `totalErrors` is the
        // aggregate that decides whether this tick's WORK succeeded. Reading
        // it here is what stops a sweep erroring on every stream from
        // presenting as a healthy run (mt#4412).
        return { ok: result.totalErrors === 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: guard-events sweep: unexpected error in tick", { message });
        return { ok: false };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Interceptor-aggregates refresh (mt#4009)
// ---------------------------------------------------------------------------

/**
 * Cadence matched to the guard-events ingest sweep above: the aggregation
 * snapshot only moves when ingest lands new rows, so refreshing faster than
 * ingest would re-run the 2.7s-class catalog rollup for identical results.
 */
const INTERCEPTOR_AGGREGATES_INTERVAL_MS = 5 * 60 * 1000;
/** The rollup measured 2.73s cold; a wedged DB should not pin a tick forever. */
const INTERCEPTOR_AGGREGATES_TICK_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Start the periodic interceptor-aggregates refresh (mt#4009). Recomputes the
 * catalog-wide `guard_events` rollup + canary/health/calibration joins once at
 * boot, then every tick; the `interceptor-aggregates` widget's catalog path
 * only ever reads the resulting in-process snapshot (`interceptor-aggregates-cache.ts`)
 * — this sweeper is the sole place the full-corpus queries run.
 *
 * Fail-open: a failed pass logs inside the refresh and leaves the last-good
 * snapshot in place — never crashes the cockpit.
 *
 * @returns stop function (clears the interval).
 */
export function startInterceptorAggregatesSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "interceptor-aggregates",
    intervalMs: intervalMs ?? INTERCEPTOR_AGGREGATES_INTERVAL_MS,
    tickTimeoutMs: INTERCEPTOR_AGGREGATES_TICK_TIMEOUT_MS,
    // Both numbers are sized against THIS sweep's 5-minute cadence and the two
    // measured outages, not picked round (`decision-defaults §Thresholds`).
    //
    // afterFailures: 2 -> ~10 minutes of continuous failure before any tick is
    // skipped, which is past a transient pooler blip (seconds) and well inside
    // the 15-25 minute window both recorded outages actually lasted.
    //
    // maxSkippedTicks: 6 -> a 30-minute floor cadence, deliberately just past
    // the longest observed outage (25 min) so a database that recovered is
    // re-probed within roughly one cadence of recovering, never abandoned.
    domainFailureBackoff: { afterFailures: 2, maxSkippedTicks: 6 },
    tick: async () => {
      try {
        const { refreshInterceptorAggregates } = await import("./interceptor-aggregates-cache");
        // Report the refresh's OWN outcome, not merely "the tick did not
        // throw" (mt#4294). The fail-open try/catch below and the refresh's
        // internal source guards both convert a failure into a normal return,
        // so without this the scheduler counted a permanently-failing refresh
        // as a run of successful ticks — and `consecutiveDomainFailures`, the
        // counter a backoff would read, never moved off zero.
        return await refreshInterceptorAggregates();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: interceptor-aggregates sweep failed", { message });
        return { ok: false };
      }
    },
  });
}
