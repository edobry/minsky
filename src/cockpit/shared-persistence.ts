/**
 * Shared PersistenceService singleton for cockpit (mt#2102).
 *
 * All cockpit widgets and server endpoints use this single instance instead of
 * creating their own. Avoids opening redundant postgres-js pools — each cockpit
 * process would otherwise hold its own pool of up to
 * DEFAULT_POSTGRES_MAX_CONNECTIONS sockets against the shared Supabase
 * transaction pooler (port 6543). That pooler's client ceiling is 200 on this
 * compute tier — measured 2026-08-05, `SHOW max_connections` = 60 → Nano/Micro,
 * whose documented "Connection Pooler Max Clients" is 200. (Memory 63fbc195 said
 * "thousands"; that was an agent-authored estimate, corrected by mt#3497 — a
 * measurement outranks it.) 200 is still far above session mode's 15, so this is
 * pool hygiene, not deadlock avoidance:
 * the prior "max 3 per instance = deadlock risk" framing predated the
 * 2026-04-24 session->transaction pooler migration and was retired by mt#2224.
 *
 * Init-coalescing: concurrent callers await the same initialization promise.
 * Failure-reset: if initialize() rejects, the promise is cleared so retries work.
 */
import type { PersistenceService } from "@minsky/domain/persistence/service";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { log } from "@minsky/shared/logger";

/**
 * Default deadline for the one-time PersistenceService init sequence
 * (createService() + initialize()). The deadline exists to catch an unbounded
 * HANG (e.g. an Octokit call with no timeout, mt#2245) — not to police a slow
 * but eventually-successful init. It is therefore set generously: observed
 * healthy init is ~1.7s (scripts/repro-mt2183.ts), while DB cold-start /
 * failover can legitimately take double-digit seconds, so 30s tolerates those
 * while still bounding an infinite hang. (Raised from the original 10s after
 * PR #1491 R1 flagged 10s as too aggressive for cold-start / failover windows.)
 *
 * Operator override: set MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS to a
 * positive integer (milliseconds); invalid / non-positive values fall back to
 * the default. Callers may also pass an explicit `initTimeoutMs` argument.
 * Mirrors the Promise.race init-timeout pattern at widgets/agents.ts:156-160.
 * (mt#2244)
 */
export const DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS = 30_000;

/** @internal Exported for unit testing the env-override parse rules. */
export function resolveDefaultInitTimeoutMs(): number {
  const raw = process.env.MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS;
}

export const PERSISTENCE_INIT_TIMEOUT_MS = resolveDefaultInitTimeoutMs();

/** Thrown when PersistenceService.initialize() exceeds the init deadline. */
export class PersistenceInitTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`PersistenceService.initialize() timed out after ${elapsedMs}ms`);
    this.name = "PersistenceInitTimeoutError";
  }
}

/**
 * Factory for the PersistenceService instance. Defaults to dynamically importing
 * and constructing the real service; overridable as a test seam so the
 * init-timeout/reset behaviour can be unit-tested without a live database — and
 * without `mock.module`, which persists across bun:test files and would poison
 * other suites (see adapters/shared/commands/observability.test.ts).
 */
export type PersistenceServiceFactory = () => Promise<PersistenceService>;

const defaultServiceFactory: PersistenceServiceFactory = async () => {
  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  return new PersistenceService();
};

/**
 * DB connection status for the cockpit daemon (gh#1761).
 *
 * - "unreachable": no successful connection has ever been established, OR the
 *   connection was never attempted (initial state before the first caller).
 * - "degraded": at least one init attempt was made but failed (circuit breaker,
 *   auth error, timeout, etc.). The daemon stays up and retries on backoff.
 * - "ok": the PersistenceService was successfully initialized and `_instance` is set.
 *
 * Exposed via `getDbStatus()` so the `/api/health` endpoint can report DB state
 * without probing the DB on every health poll.
 */
export type DbStatus = "ok" | "degraded" | "unreachable";

let _dbStatus: DbStatus = "unreachable";

/**
 * Returns the last-known DB connection status. Read-only; does not trigger a
 * new init attempt. Safe to call from a health endpoint on every request.
 */
export function getDbStatus(): DbStatus {
  return _dbStatus;
}

/**
 * Mark the DB as degraded and reset the singleton so future callers retry.
 *
 * Called from the `unhandledRejection` handler in start-command.ts when a
 * postgres-js circuit-breaker error (`ECIRCUITBREAKER` / `EDBHANDLEREXITED`)
 * reaches the process-level handler. Resets `_instance` so the next
 * `getSharedPersistenceService()` call starts a fresh init sequence.
 *
 * Bumps the persistence epoch (mt#3638): a singleton reset is invisible to the
 * module-level caches in db-providers.ts / widgets/agents.ts unless the epoch
 * moves — without the bump they keep serving the torn-down provider forever,
 * which is the mt#2362 staleness this closes.
 *
 * @internal Not for use from application code other than the error handler.
 */
export function markDbDegraded(): void {
  _dbStatus = "degraded";
  _instance = null;
  _initPromise = null;
  _epoch++;
  log.warn("[shared-persistence] DB marked degraded; singleton reset for retry");
}

let _instance: PersistenceService | null = null;
let _initPromise: Promise<PersistenceService> | null = null;

/**
 * Hard deadline for one reachability probe (mt#3563).
 *
 * This bounds the PROBE, not the database. A healthy round-trip through the
 * pooler is single-digit milliseconds (mt#3092 measured the wedged widget's
 * query at 0.369 ms at the server), so the deadline only has to be long enough
 * that ordinary latency plus a moment of queueing is not misread as a wedge.
 * Five seconds is generous against that baseline while still marking a wedged
 * pool degraded well inside one tray poll.
 */
export const DB_REACHABILITY_PROBE_TIMEOUT_MS = 5_000;

/** Outcome of the last completed reachability probe, for `/api/health`. */
export interface DbCheck {
  /**
   * ISO timestamp of the last probe that actually FINISHED — resolved, rejected,
   * or hit its deadline — or null if none has.
   *
   * Deliberately NOT bumped when a poll merely observes that an earlier probe is
   * still outstanding (PR #2558 R1): nothing was determined on such a poll, and a
   * freshly-stamped `checkedAt` would read as a fresh measurement. Letting it go
   * stale is the more informative behaviour — a stale `checkedAt` alongside
   * `db: "degraded"` says "stuck since then", which is exactly what an operator
   * needs to see.
   */
  checkedAt: string | null;
  /** Round-trip of the last SUCCESSFUL probe in ms, or null if none has succeeded. */
  latencyMs: number | null;
}

/**
 * Minimum gap between probes while the last one SUCCEEDED (PR #2558 R1).
 *
 * The health route kicks a probe per request, and several pollers hit it (the
 * tray supervisor, the web header), so without a floor a busy daemon issues a
 * query per poll per client. The floor applies ONLY in the healthy state: once
 * degraded we probe on every poll, because the value of detecting recovery
 * promptly outweighs one extra query against a pool that is not doing anything
 * else anyway.
 */
export const DB_REACHABILITY_MIN_INTERVAL_MS = 2_000;

let _dbCheck: DbCheck = { checkedAt: null, latencyMs: null };

/** Monotonic ms of the last FINISHED probe; drives the healthy-state floor. */
let _lastProbeFinishedAtMs: number | null = null;

/**
 * A probe query we issued that has NOT come back yet.
 *
 * This is the wedge DETECTOR, not merely a concurrency guard. The failure mode
 * this task exists to report is a query promise that never settles: the
 * connection stays checked out of the pool forever and no error is ever thrown
 * (mt#2773 documents the postgres-js defect — 86 of 120 promises permanently
 * unsettled in its repro matrix; mt#3092 owns fixing it). So an outstanding
 * probe IS the evidence of a wedge.
 *
 * It also bounds the damage this module can do. Each abandoned probe holds one
 * pool slot for the life of the process, so while one is still in flight we
 * report degraded and deliberately do NOT issue another. At most one probe is
 * ever outstanding, no matter how often the health endpoint is polled.
 */
let _outstandingProbe: Promise<unknown> | null = null;

/**
 * Last-known reachability detail. Read-only; pairs with {@link getDbStatus}.
 */
export function getDbCheck(): DbCheck {
  return { ..._dbCheck };
}

/** The query the probe runs. Injectable so tests need no database. */
export type DbReachabilityProbe = () => Promise<unknown>;

const defaultReachabilityProbe: DbReachabilityProbe = async () => {
  const provider = (await getSharedProvider()) as SqlCapablePersistenceProvider;
  if (!provider.getRawSqlConnection) {
    throw new Error("persistence provider exposes no raw SQL connection");
  }
  const raw = await provider.getRawSqlConnection();
  if (!raw) {
    throw new Error("getRawSqlConnection returned null");
  }
  // Same assertion pattern as the pg_notify path in
  // packages/domain/src/ask/attention-windows/notify.ts — at runtime this is
  // the pooler-guarded instance; the declared union is not narrow enough to
  // call through directly.
  const sql = raw as import("postgres").Sql;
  // Two deliberate choices here, both from mt#2773:
  //
  // 1. The query is PARAMETERIZED. Zero-bind queries are the shape that wedges
  //    this transaction-mode pooler under concurrency — with a bind,
  //    postgres-js sends Parse+Describe+Flush first and self-paces. A probe for
  //    pool health must not be able to cause the condition it reports.
  // 2. It goes through `.unsafe()` rather than a tagged template, so it is
  //    subject to the pooler guard's in-flight cap like every other raw query
  //    instead of reaching the unguarded underlying instance.
  return sql.unsafe("select $1::int as reachable", [1]);
};

/**
 * Probe whether a query can currently get through, and update the reported
 * status (mt#3563).
 *
 * Runs through the SHARED pool on purpose — the same path every route uses.
 * A probe on a dedicated side-connection would have reported healthy through
 * both the 2026-08-01 and 2026-08-03 incidents, because the pooler was
 * accepting new connections fine in each; what was dead was this process's own
 * pool. Failure to get a slot within the deadline IS the degraded signal.
 *
 * Never throws and never blocks a caller beyond `timeoutMs`, so the health
 * route can fire it without being able to hang.
 */
export async function refreshDbReachability(
  probe: DbReachabilityProbe = defaultReachabilityProbe,
  timeoutMs: number = DB_REACHABILITY_PROBE_TIMEOUT_MS,
  minIntervalMs: number = DB_REACHABILITY_MIN_INTERVAL_MS
): Promise<DbStatus> {
  if (_outstandingProbe) {
    // A probe we already issued has still not come back. Don't issue another,
    // and do NOT touch `checkedAt` — nothing finished on this poll, so claiming
    // a fresh measurement would misreport (PR #2558 R1). The value going stale
    // while the status reads degraded is the signal, not a gap.
    _dbStatus = _instance ? "degraded" : "unreachable";
    // mt#3638: this branch IS the never-settle wedge signature — count it
    // toward the recycle trigger, or the wedge whose probe never completes
    // could never accumulate evidence against itself.
    noteDegradedObservation();
    return _dbStatus;
  }

  // Healthy-state probe floor. Skipped entirely when degraded so recovery is
  // noticed on the very next poll.
  if (
    _dbStatus === "ok" &&
    _lastProbeFinishedAtMs !== null &&
    Date.now() - _lastProbeFinishedAtMs < minIntervalMs
  ) {
    return _dbStatus;
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let issued: Promise<unknown>;
  try {
    issued = probe();
  } catch (err) {
    // A probe that threw synchronously never got as far as a connection. That
    // still DETERMINED reachability (we know we could not reach it), so unlike
    // the outstanding-probe branch above it does stamp `checkedAt`.
    _dbStatus = _instance ? "degraded" : "unreachable";
    _dbCheck = { ..._dbCheck, checkedAt: new Date().toISOString() };
    _lastProbeFinishedAtMs = Date.now();
    noteDegradedObservation();
    log.warn("[shared-persistence] DB reachability probe failed to start", {
      message: err instanceof Error ? err.message : String(err),
    });
    return _dbStatus;
  }

  _outstandingProbe = issued;
  // Release the slot whenever it eventually settles — even long after the
  // deadline — so a pool that recovers becomes probeable again with no
  // restart. Both arms are attached here so a late rejection can never
  // surface as an unhandled rejection (which markDbDegraded would then act on).
  let raceSettled = false;
  const release = (): void => {
    if (_outstandingProbe === issued) _outstandingProbe = null;
  };
  void issued.then(release, (err: unknown) => {
    release();
    // A rejection arriving AFTER the deadline has no awaiting caller — the race
    // below already settled — so without this arm its cause is discarded
    // silently (PR #2558 R1). That cause is the most diagnostic signal available
    // about WHY the pool stopped answering, which is the open question mt#3092
    // carries. Logged only in the post-deadline case; a pre-deadline rejection
    // is already reported by the catch block, and logging both would double up.
    if (!raceSettled) return;
    log.warn("[shared-persistence] DB reachability probe rejected after its deadline", {
      message: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error && err.cause !== undefined ? String(err.cause) : undefined,
    });
  });

  try {
    await Promise.race([
      issued,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DB reachability probe exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    _dbStatus = "ok";
    _dbCheck = { checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
    noteProbeSuccess();
  } catch (err) {
    _dbStatus = _instance ? "degraded" : "unreachable";
    _dbCheck = { ..._dbCheck, checkedAt: new Date().toISOString() };
    noteDegradedObservation();
    log.warn("[shared-persistence] DB unreachable from this daemon", {
      message: err instanceof Error ? err.message : String(err),
      status: _dbStatus,
    });
  } finally {
    if (timer) clearTimeout(timer);
    // This poll DID finish a probe (resolved, rejected, or hit the deadline), so
    // it is the reference point for both `checkedAt` and the healthy-state floor.
    raceSettled = true;
    _lastProbeFinishedAtMs = Date.now();
  }
  return _dbStatus;
}

// ---------------------------------------------------------------------------
// Wedge-triggered pool recycle (mt#3638)
//
// The probe above DETECTS a wedged pool; nothing acted on the detection — the
// 2026-08-03 21:12Z occurrence ran 40+ minutes at `db: "degraded"` (501
// consecutive degraded health polls, every DB route hung) until a process
// restart, WITH the mt#3592 socket inactivity bound live in the daemon. This
// section is the recovery half: sustained degradation tears down the shared
// service, resets the singleton, and bumps the epoch so every cached consumer
// re-resolves against the fresh pool. Deliberately mechanism-agnostic — it is
// the in-process equivalent of the restart that has fixed all four observed
// occurrences, so it recovers wedges whose mechanism is not yet diagnosed.
// ---------------------------------------------------------------------------

/**
 * How long the probe must report degraded, continuously, before a recycle.
 *
 * A DURATION rather than a completed-probe count, deliberately: in the
 * never-settle wedge (mt#3092 / porsager-postgres#1089) the first hung probe
 * stays outstanding forever, so no further probes COMPLETE — a count of
 * completed failures would never advance while the wedge it exists to catch is
 * in progress. Three probe deadlines' worth of continuous degradation is the
 * same evidence three failed probes would have been.
 */
export const RECYCLE_AFTER_DEGRADED_MS = 3 * DB_REACHABILITY_PROBE_TIMEOUT_MS;

/**
 * Floor between recycles. Grounded in the pool's own idle_timeout scale (60 s,
 * postgres-provider.ts): a recycle's reconnect cost is the same class as the
 * idle policy's natural churn, so recycling no faster than idle turnover adds
 * no new pressure against the pooler when the DB is genuinely down.
 */
export const RECYCLE_MIN_INTERVAL_MS = 60_000;

/**
 * How long to WAIT on the torn-down service's close() before abandoning it.
 * The pool being closed is wedged by definition, so close() frequently hangs;
 * the recycle itself never waits on it (teardown is fire-and-forget) — this
 * only bounds how long the abandoned close is tracked before being logged as
 * abandoned. Mirrors the mt#2248 orphan-close pattern in
 * getSharedPersistenceService.
 */
export const RECYCLE_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Monotonic generation counter for the shared PersistenceService (mt#3638).
 *
 * Every consumer that caches anything derived from the shared provider — the
 * db-providers.ts getters, widgets/agents.ts factories — records the epoch it
 * cached at and re-resolves when it moves. Bumped by every singleton reset:
 * recycleSharedPersistence() and markDbDegraded().
 */
let _epoch = 0;

/** Current persistence generation. Cheap; safe to call on every cache read. */
export function getPersistenceEpoch(): number {
  return _epoch;
}

/** Recycle telemetry for /api/health (`dbRecycle`), sibling of getDbCheck. */
export interface DbRecycle {
  /** ISO timestamp of the most recent recycle, or null if none this process. */
  lastRecycleAt: string | null;
  /** Recycles since process start. A rising count is the recurrence signal. */
  recycleCount: number;
}

let _recycleLastAtMs: number | null = null;
let _recycleCount = 0;

/** Read-only recycle telemetry; pairs with {@link getDbStatus}. */
export function getDbRecycle(): DbRecycle {
  return {
    lastRecycleAt: _recycleLastAtMs === null ? null : new Date(_recycleLastAtMs).toISOString(),
    recycleCount: _recycleCount,
  };
}

/** Monotonic ms of the first degraded observation in the CURRENT degraded run. */
let _degradedRunSinceMs: number | null = null;

// Live thresholds; only tests may lower them (via __setRecycleThresholdsForTests).
let _recycleAfterDegradedMs = RECYCLE_AFTER_DEGRADED_MS;
let _recycleMinIntervalMs = RECYCLE_MIN_INTERVAL_MS;

/**
 * Guard for the test-only surfaces below (PR #2586 R1): `bun test` sets
 * NODE_ENV to "test", so any other environment reaching one of these is
 * production misuse — throw instead of silently mutating live recycle state.
 * Mirrors `assertTestEnvironment` in db-providers.ts.
 */
function assertTestEnvironment(api: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${api} is test-only (NODE_ENV must be "test"; got ${JSON.stringify(process.env.NODE_ENV)})`
    );
  }
}

/**
 * @internal Test-only: shrink the recycle thresholds so the trigger path can be
 * exercised in milliseconds. Restored by __resetSharedPersistenceForTests.
 */
export function __setRecycleThresholdsForTests(
  afterDegradedMs: number,
  minIntervalMs: number
): void {
  assertTestEnvironment("__setRecycleThresholdsForTests");
  _recycleAfterDegradedMs = afterDegradedMs;
  _recycleMinIntervalMs = minIntervalMs;
}

/**
 * Pure recycle-trigger decision, extracted so the threshold logic is
 * unit-testable without timers or a live pool.
 */
export function shouldRecycleNow(input: {
  nowMs: number;
  degradedSinceMs: number | null;
  lastRecycleAtMs: number | null;
  /** Is there anything to tear down (an instance or an in-flight init)? */
  hasService: boolean;
  afterDegradedMs?: number;
  minIntervalMs?: number;
}): boolean {
  const after = input.afterDegradedMs ?? RECYCLE_AFTER_DEGRADED_MS;
  const minInterval = input.minIntervalMs ?? RECYCLE_MIN_INTERVAL_MS;
  if (!input.hasService) return false;
  if (input.degradedSinceMs === null) return false;
  if (input.nowMs - input.degradedSinceMs < after) return false;
  if (input.lastRecycleAtMs !== null && input.nowMs - input.lastRecycleAtMs < minInterval) {
    return false;
  }
  return true;
}

/** Probe success: close the degraded run so the duration clock starts fresh. */
function noteProbeSuccess(): void {
  _degradedRunSinceMs = null;
}

/**
 * Degraded observation from the reachability path. Starts/continues the
 * degraded-duration clock and fires the recycle when the trigger holds.
 */
function noteDegradedObservation(): void {
  const nowMs = Date.now();
  if (_degradedRunSinceMs === null) _degradedRunSinceMs = nowMs;
  const eligible = shouldRecycleNow({
    nowMs,
    degradedSinceMs: _degradedRunSinceMs,
    lastRecycleAtMs: _recycleLastAtMs,
    // When both are null there is no pool to recycle — init itself is failing
    // (DB genuinely down) and the next caller already retries from scratch, so
    // a recycle would be a no-op that still burned the rate-limit window.
    hasService: _instance !== null || _initPromise !== null,
    afterDegradedMs: _recycleAfterDegradedMs,
    minIntervalMs: _recycleMinIntervalMs,
  });
  if (!eligible) return;
  recycleSharedPersistence(
    `db degraded continuously for ${Math.round((nowMs - _degradedRunSinceMs) / 1000)}s`
  );
}

/**
 * Tear down the shared PersistenceService and reset the singleton so the next
 * caller builds a fresh pool (mt#3638).
 *
 * Synchronous by design: the state reset (epoch bump, singleton clear,
 * outstanding-probe release) must not be delayed by a close() that — on a
 * wedged pool — may never settle. The old service's close runs fire-and-forget
 * with a logged deadline.
 *
 * Exported for tests and for deliberate operator-driven invocation; routine
 * triggering goes through the reachability path above.
 */
export function recycleSharedPersistence(cause: string): void {
  const oldInstance = _instance;
  const oldInit = _initPromise;
  _epoch++;
  _instance = null;
  _initPromise = null;
  _dbStatus = "degraded";
  // The outstanding probe (if any) is a query against the pool being torn
  // down; holding the slot would block all future probes forever, since the
  // wedged query never settles. Releasing it lets the NEXT health poll probe
  // the fresh pool. The old probe's own release closure compares identity
  // (`_outstandingProbe === issued`) so its late settle cannot clobber this.
  _outstandingProbe = null;
  _recycleLastAtMs = Date.now();
  _recycleCount++;
  log.warn("[shared-persistence] recycling shared persistence pool", {
    cause,
    epoch: _epoch,
    recycleCount: _recycleCount,
  });
  if (oldInstance) {
    closeAbandonedService(oldInstance);
  } else if (oldInit) {
    // An in-flight init at recycle time: close whatever it eventually
    // produces, exactly like the mt#2248 orphan path. A rejection means the
    // provider self-cleaned; nothing to close.
    void oldInit.then(
      (svc) => closeAbandonedService(svc),
      () => {}
    );
  }
}

/** Fire-and-forget close of a recycled service, bounded by a logging deadline. */
function closeAbandonedService(svc: PersistenceService): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`close() still pending after ${RECYCLE_CLOSE_TIMEOUT_MS}ms`)),
      RECYCLE_CLOSE_TIMEOUT_MS
    );
    timer.unref?.();
  });
  void Promise.race([Promise.resolve(svc.close?.()), deadline])
    .then(() => log.debug("[shared-persistence] recycled pool closed cleanly"))
    .catch((err: unknown) =>
      log.warn("[shared-persistence] abandoned close of recycled pool", {
        message: err instanceof Error ? err.message : String(err),
      })
    )
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Default retry interval for `startDbRetryBackoff()` (gh#1761).
 * Conservative: 30 s avoids hammering a down Supavisor circuit breaker.
 */
export const DEFAULT_DB_RETRY_INTERVAL_MS = 30_000;

/**
 * Returns the shared PersistenceService, initializing it once and coalescing
 * concurrent callers onto a single init promise.
 *
 * Hang recovery and its limit (mt#2244): the init sequence races against
 * `initTimeoutMs`. On timeout the cached promise is cleared so the NEXT caller
 * starts a fresh attempt instead of joining one that will never settle. The
 * timed-out attempt, however, keeps running in the background and CANNOT be
 * cancelled — `PersistenceService.initialize()` / `provider.initialize()` take
 * no AbortSignal today. A new instance is created per attempt (reusing the
 * instance would re-wedge on its own internal init-promise, which a hang leaves
 * permanently pending), so a hung attempt that later completes would otherwise
 * leak a provider connection pool. mt#2248 closes that gap: on timeout we attach
 * a best-effort `close()` teardown to the orphaned init promise, so if it
 * resolves after the deadline the orphaned service is torn down (its provider
 * pool released). Threading an AbortSignal through the provider was rejected —
 * the porsager/postgres driver accepts no AbortSignal (it exposes only
 * `.cancel()` on an executed query), and `connect_timeout` already bounds the
 * connection phase; the cockpit-local teardown is driver-agnostic and covers a
 * hang wherever it occurs (connect / SELECT 1 / migrations). The overlap is
 * bounded: callers within a window coalesce, so at most one ACTIVE attempt runs
 * at a time, plus at most one (now self-closing) orphan per timeout event.
 */
export async function getSharedPersistenceService(
  initTimeoutMs: number = PERSISTENCE_INIT_TIMEOUT_MS,
  createService: PersistenceServiceFactory = defaultServiceFactory
): Promise<PersistenceService> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const startedAt = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new PersistenceInitTimeoutError(Date.now() - startedAt)),
        initTimeoutMs
      );
    });
    // The WHOLE sequence — factory + initialize() — is inside the race so a hang
    // in EITHER createService() (dynamic import / constructor) or initialize()
    // trips the deadline (PR #1491 R1).
    const init = (async () => {
      const svc = await createService();
      await svc.initialize();
      return svc;
    })();
    try {
      const svc = await Promise.race([init, timeout]);
      _instance = svc;
      _dbStatus = "ok"; // gh#1761: mark DB healthy on successful init
      return svc;
    } catch (err) {
      // Clear the cached promise so the NEXT caller retries with fresh state,
      // whether init rejected OR timed out. Without the timeout+reset a hang
      // would wedge every subsequent caller forever (mt#2244).
      _initPromise = null;
      _dbStatus = "degraded"; // gh#1761: mark DB degraded on any init failure
      if (err instanceof PersistenceInitTimeoutError) {
        log.warn(
          `[shared-persistence] PersistenceService init timed out after ` +
            `${err.elapsedMs}ms — cleared cached init promise so the next caller retries`
        );
        // The orphaned init keeps running in the background. If it LATER resolves,
        // close the service so its provider connection pool doesn't leak (mt#2248)
        // — the cockpit gave up on it and nothing else holds a reference. This is
        // best-effort and must not mask the timeout rejection thrown below.
        void init
          .then((svc) =>
            // close() failures are logged at debug (observability) but not rethrown.
            Promise.resolve(svc?.close?.()).catch((closeErr) =>
              log.debug(
                `[shared-persistence] orphan close() after init-timeout failed: ${String(closeErr)}`
              )
            )
          )
          .catch(() => {
            // init itself rejected after the deadline — the provider self-cleans
            // its pool on failure, so there's nothing to close and nothing to report.
          });
      }
      throw err;
    } finally {
      // Always clear the timer so a settled init doesn't leave a dangling
      // handle holding the event loop open.
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  })();

  return _initPromise;
}

export async function getSharedProvider(): Promise<PersistenceProvider> {
  const svc = await getSharedPersistenceService();
  return svc.getProvider();
}

/**
 * Start a background DB retry loop that keeps attempting `getSharedPersistenceService()`
 * on a fixed interval until the connection is restored (gh#1761).
 *
 * Intended use cases:
 * 1. Called from the `unhandledRejection` handler in start-command.ts after a
 *    circuit-breaker error marks the DB degraded — it drives the reconnect so
 *    the daemon eventually recovers without operator intervention.
 * 2. Optionally called at startup to warm the DB connection proactively.
 *
 * The loop stops automatically when `getSharedPersistenceService()` returns
 * successfully (`_dbStatus === "ok"`), or when the returned stop function is called.
 *
 * @param intervalMs  Gap between retry attempts (default: DEFAULT_DB_RETRY_INTERVAL_MS).
 * @param createService  Injectable factory for testing (mirrors getSharedPersistenceService's seam).
 * @returns  A stop function that cancels any pending retry.
 */
export function startDbRetryBackoff(
  intervalMs: number = DEFAULT_DB_RETRY_INTERVAL_MS,
  createService: PersistenceServiceFactory = defaultServiceFactory
): () => void {
  let stopped = false;
  let retryHandle: ReturnType<typeof setTimeout> | undefined;

  const attempt = async (): Promise<void> => {
    if (stopped || _dbStatus === "ok") return;
    try {
      await getSharedPersistenceService(PERSISTENCE_INIT_TIMEOUT_MS, createService);
      // Success — _dbStatus is now "ok" (set inside getSharedPersistenceService).
      log.info("[shared-persistence] DB reconnected successfully via retry backoff");
      // gh#1761: cancel any pending retry timer and stop the loop; a stale
      // setTimeout callback scheduled before this success resolved must not
      // trigger another (unnecessary) attempt.
      if (retryHandle !== undefined) {
        clearTimeout(retryHandle);
        retryHandle = undefined;
      }
      stopped = true;
    } catch (err) {
      // Still down — schedule next attempt.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[shared-persistence] DB retry failed (${msg}); next attempt in ${intervalMs}ms`);
      if (!stopped) {
        retryHandle = setTimeout(() => void attempt(), intervalMs);
      }
    }
  };

  // Start the first attempt immediately (so degraded state is detected fast).
  void attempt();

  return () => {
    stopped = true;
    if (retryHandle !== undefined) clearTimeout(retryHandle);
  };
}

/**
 * Reset the cached singleton + init promise so each test starts from a clean
 * slate. Exported because the singleton state is module-level and bun shares
 * module state across test files in one process (the same hazard noted in
 * adapters/shared/commands/observability.test.ts).
 *
 * @internal Test-only. The `__`-prefix + this annotation mark it as not part of
 * the supported surface; production code must never call it (it would corrupt
 * the live singleton).
 */
export function __resetSharedPersistenceForTests(): void {
  assertTestEnvironment("__resetSharedPersistenceForTests");
  _instance = null;
  _initPromise = null;
  _dbStatus = "unreachable"; // gh#1761: reset status so degraded-path tests start clean
  // mt#3563: the reachability probe's state is module-level too, so a test that
  // left a probe outstanding would otherwise make the next test report degraded.
  _dbCheck = { checkedAt: null, latencyMs: null };
  _outstandingProbe = null;
  _lastProbeFinishedAtMs = null;
  // mt#3638: recycle state is module-level too — a test that triggered a
  // recycle would otherwise leave the next test rate-limited or a bumped epoch.
  _epoch = 0;
  _degradedRunSinceMs = null;
  _recycleLastAtMs = null;
  _recycleCount = 0;
  _recycleAfterDegradedMs = RECYCLE_AFTER_DEGRADED_MS;
  _recycleMinIntervalMs = RECYCLE_MIN_INTERVAL_MS;
}
