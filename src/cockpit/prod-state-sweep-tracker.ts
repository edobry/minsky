/**
 * ProdStateSweepTracker — in-memory health counters for the cockpit-daemon
 * prod-state cache refresh sweep (mt#3039).
 *
 * Root-cause context (mt#3039): the sweep wrote its cache exactly once, at
 * boot, and never again across 6.4 hours of otherwise-healthy daemon uptime.
 * The failure was NOT a dead `setInterval` — `createIntervalSweeper`'s
 * per-tick timeout (mt#2625) and the sweep meta-watchdog (mt#2894) would have
 * force-restarted a genuinely dropped/wedged timer within ~2x the sweep's own
 * 10-minute cadence, far short of 6.4 hours — and there is no deliberate
 * "only write when the value changed" dedup logic anywhere in the write path
 * (`writeProdStateCache` -> `atomicWriteJSON` always rewrites the file
 * unconditionally, stamping a fresh `checkedAt` every call). The actual
 * mechanism: `refreshProdStateCache`'s early-return guards (`!sql` /
 * `!snapshot`) let a persistent domain-level read failure resolve WITHOUT
 * throwing. Because the enclosing sweep tick's own try/catch
 * (`startProdStateRefreshSweeper` in sweepers.ts) never sees a throw,
 * `createIntervalSweeper`'s OWN liveness bookkeeping records every such tick
 * as a full success — the interval keeps attempting right on cadence (which
 * is exactly why the meta-watchdog, which only tracks attempt timestamps,
 * never intervened), but the tick's domain effect (the cache write) silently
 * no-ops. This tracker closes that gap: it records the sweep's DOMAIN outcome
 * (did it actually write?), independent of whether the scheduling layer
 * considers the tick "successful".
 *
 * Mirrors the process-lifetime-singleton-with-counters shape of
 * `TranscriptSweepTracker` / `DispatchWatchdogSweepTracker` (mt#2320/mt#2321,
 * mt#2646) — same redaction policy: no raw error-message strings are stored
 * here (the log surface carries those via `log.warn` at each call site in
 * prod-state-cache.ts); only counts + ISO timestamps are exposed on the
 * unauthenticated `/api/health` surface.
 *
 * @see src/cockpit/transcript-sweep-tracker.ts — sibling tracker this mirrors
 * @see src/cockpit/prod-state-cache.ts — the producer this tracks
 * @see mt#3039 — this task
 */

/** Snapshot of the prod-state sweep's health counters, exposed on `/api/health`. */
export interface ProdStateSweepSummary {
  /** Total number of completed sweep-refresh attempts (tick ran to completion, success or failure). */
  runsCount: number;
  /** ISO timestamp of the last completed sweep-refresh attempt, or null (no tick has run yet). */
  lastRunAt: string | null;
  /** ISO timestamp of the last attempt that actually wrote the cache, or null. */
  lastSuccessAt: string | null;
  /**
   * ISO timestamp of the last failed attempt (no sql, unreadable ledger, or a
   * write failure), or null. NOTE: per redaction policy, the raw error
   * message is NOT stored here — the log surface carries it.
   */
  lastErrorAt: string | null;
  /** Consecutive failed attempts since the last success. Resets to 0 on any success. */
  consecutiveFailures: number;
}

export class ProdStateSweepTracker {
  private static _instance: ProdStateSweepTracker | null = null;

  private runsCount = 0;
  private lastRunAtMs: number | null = null;
  private lastSuccessAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;
  private consecutiveFailures = 0;

  /** Process-lifetime singleton (created on first access). */
  static getInstance(): ProdStateSweepTracker {
    if (!ProdStateSweepTracker._instance) {
      ProdStateSweepTracker._instance = new ProdStateSweepTracker();
    }
    return ProdStateSweepTracker._instance;
  }

  /** Reset the singleton for tests. */
  static resetForTest(): ProdStateSweepTracker {
    ProdStateSweepTracker._instance = new ProdStateSweepTracker();
    return ProdStateSweepTracker._instance;
  }

  /** Record that a refresh attempt ran (called once per `refreshProdStateCache` call). */
  recordRun(nowMs: number = Date.now()): void {
    this.runsCount++;
    this.lastRunAtMs = nowMs;
  }

  /** Record a refresh attempt that successfully wrote the cache. */
  recordSuccess(nowMs: number = Date.now()): void {
    this.lastSuccessAtMs = nowMs;
    this.consecutiveFailures = 0;
  }

  /**
   * Record a failed refresh attempt (no sql, unreadable ledger, or a write
   * failure). Only the timestamp is stored — no raw message (redaction
   * policy; the caller logs the raw message via `log.warn` before calling
   * this).
   */
  recordFailure(nowMs: number = Date.now()): void {
    this.lastErrorAtMs = nowMs;
    this.consecutiveFailures++;
  }

  /** Snapshot the current counters for the cockpit `/api/health` surface. */
  getSummary(): ProdStateSweepSummary {
    return {
      runsCount: this.runsCount,
      lastRunAt: this.lastRunAtMs === null ? null : new Date(this.lastRunAtMs).toISOString(),
      lastSuccessAt:
        this.lastSuccessAtMs === null ? null : new Date(this.lastSuccessAtMs).toISOString(),
      lastErrorAt: this.lastErrorAtMs === null ? null : new Date(this.lastErrorAtMs).toISOString(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
