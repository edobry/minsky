/**
 * TranscriptSweepTracker — in-memory health counters for the cockpit-daemon
 * transcript sweep backstop (mt#2321, SC3).
 *
 * The sweep runs periodic full-discovery ingest + optional embedding backfill;
 * this tracker makes its activity and failures observable instead of silently
 * swallowed. It is a process-lifetime singleton written by the sweep and read
 * by the cockpit server's `/api/health` endpoint — both run in the SAME cockpit
 * process, so an in-memory singleton is sufficient.
 *
 * Note (mt#2321): the sweep does NOT surface through `debug_systemInfo`. That
 * tool runs in the MCP-server process, a different process from the cockpit
 * daemon where the sweep lives; an in-memory singleton there would always read
 * zero. The same-process cockpit `/api/health` surface (plus the log surface)
 * is the correct observability channel. Cross-process exposure, if ever needed,
 * would require a shared store (DB/file) like DisconnectTracker.
 *
 * Redaction policy: raw error-message strings are deliberately NOT stored here.
 * `/api/health` is unauthenticated, and error strings can leak absolute paths
 * or internals (reviewer R1 on mt#2320). The log surface carries the full
 * message; only counts + ISO timestamps are public. Same policy as
 * TranscriptWatcherTracker.
 *
 * @see src/cockpit/transcript-watcher-tracker.ts — sibling tracker this mirrors
 * @see mt#2321 — cockpit-daemon transcript sweep backstop
 */

export interface TranscriptSweepSummary {
  /** Total number of completed sweep ticks. */
  sweepsRun: number;
  /** Total sessions ingested across all sweeps (sum of ingestAll.sessionsProcessed). */
  sessionsIngested: number;
  /**
   * Total sessions that reported an ingest error across all sweeps
   * (sum of ingestAll.sessionsErrored). Counts per-session failures, not per-sweep.
   */
  sessionsErrored: number;
  /**
   * Sessions SKIPPED on the LAST sweep because they are quarantined (mt#3278) —
   * they failed to ingest repeatedly and are no longer being attempted, so
   * their conversations have silently stopped being captured.
   *
   * A gauge, not a running total: unlike `sessionsErrored`, quarantine is a
   * standing condition rather than an event, so summing it across sweeps would
   * make one stuck session look like an ever-worsening problem. This reads
   * "how many sessions are given up on right now."
   */
  sessionsQuarantined: number;
  /**
   * Number of embedding backfill runs completed successfully.
   * Incremented once per sweep tick where embeddings ran without throwing.
   */
  embedRuns: number;
  /** ISO timestamp of the last completed sweep, or null (no sweep yet). */
  lastSweepAt: string | null;
  /**
   * Passes ABANDONED mid-flight because the database connection died (mt#4480).
   *
   * Disjoint from `sweepsRun`: an abandoned pass is not a sweep that happened.
   * Before this existed, a pass that ingested nothing because the pool was
   * recycled under it incremented `sweepsRun` and looked identical to a healthy
   * one — five such passes ran back to back on 2026-08-24 while this surface
   * reported `sweepsRun: 2` and nothing else amiss.
   */
  sweepsAborted: number;
  /** ISO timestamp of the last abandoned pass, or null. */
  lastAbortAt: string | null;
  /**
   * ISO timestamp of the last sweep that actually ingested something, or null.
   *
   * The load-bearing freshness signal, and the one field here that cannot be
   * satisfied by a mechanism that is merely RUNNING. `lastSweepAt` advances on
   * every tick including the ones that write nothing; this advances only when
   * the sweep did its job. A widening gap between the two is the standing
   * condition an operator wants, and it is visible without reading any log.
   */
  lastProductiveSweepAt: string | null;
  /**
   * ISO timestamp of the last sweep error (ingest OR embedding failure), or null.
   * NOTE: per redaction policy, the raw error message is NOT stored. Log surface carries it.
   */
  lastErrorAt: string | null;
}

export class TranscriptSweepTracker {
  private static _instance: TranscriptSweepTracker | null = null;

  private sweepsRun = 0;
  private sessionsIngested = 0;
  private sessionsErrored = 0;
  private sessionsQuarantined = 0;
  private embedRuns = 0;
  private lastSweepAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;
  private sweepsAborted = 0;
  private lastAbortAtMs: number | null = null;
  private lastProductiveSweepAtMs: number | null = null;

  /** Process-lifetime singleton (created on first access). */
  static getInstance(): TranscriptSweepTracker {
    if (!TranscriptSweepTracker._instance) {
      TranscriptSweepTracker._instance = new TranscriptSweepTracker();
    }
    return TranscriptSweepTracker._instance;
  }

  /** Reset the singleton for tests. */
  static resetForTest(): TranscriptSweepTracker {
    TranscriptSweepTracker._instance = new TranscriptSweepTracker();
    return TranscriptSweepTracker._instance;
  }

  /**
   * Record a completed sweep tick.
   *
   * @param sessionsProcessed - From ingestAll().sessionsProcessed
   * @param sessionsErrored   - From ingestAll().sessionsErrored (surfaced, not dropped)
   * @param sessionsQuarantined - From ingestAll().sessionsQuarantined (mt#3278).
   *   Optional so the existing two-arg call shape keeps working; omitted means
   *   "this sweep reported none", which resets the gauge as it should.
   * @param totalIngested - From ingestAll().totalIngested (mt#4480). Optional
   *   for the same back-compat reason. Only a POSITIVE value advances
   *   `lastProductiveSweepAt`; omitting it therefore reads as "this caller does
   *   not report productivity", which correctly leaves the field alone rather
   *   than asserting the sweep was unproductive.
   */
  recordSweepCompleted(
    sessionsProcessed: number,
    sessionsErrored: number,
    sessionsQuarantined = 0,
    totalIngested?: number
  ): void {
    this.sweepsRun++;
    this.sessionsIngested += sessionsProcessed < 0 ? 0 : sessionsProcessed;
    this.sessionsErrored += sessionsErrored < 0 ? 0 : sessionsErrored;
    // Gauge, not an accumulator — see the field's doc comment.
    this.sessionsQuarantined = sessionsQuarantined < 0 ? 0 : sessionsQuarantined;
    this.lastSweepAtMs = Date.now();
    if (typeof totalIngested === "number" && totalIngested > 0) {
      this.lastProductiveSweepAtMs = Date.now();
    }
    if (sessionsErrored > 0) {
      this.lastErrorAtMs = Date.now();
    }
  }

  /**
   * Record a pass ABANDONED mid-flight because the connection died (mt#4480).
   *
   * Deliberately does NOT increment `sweepsRun`, and does NOT add to the
   * per-session totals: the sessions it got through were not swept, they were
   * failed at, and folding them into `sessionsIngested` is what made a
   * zero-ingest pass read as 1,502 sessions' worth of work. Sets `lastErrorAt`
   * because an abandoned pass IS a sweep-level error.
   */
  recordSweepAborted(): void {
    this.sweepsAborted++;
    this.lastAbortAtMs = Date.now();
    this.lastErrorAtMs = Date.now();
  }

  /**
   * Record a successful embedding backfill run.
   * Called after PerTurnEmbeddingPipeline.run() or equivalent completes without throwing.
   */
  recordEmbedRunCompleted(): void {
    this.embedRuns++;
  }

  /**
   * Record a sweep-level error (ingest threw, or embed threw).
   * Only the count + timestamp are stored (redaction policy — no raw message).
   * The caller logs the raw message at warn/error before calling this.
   */
  recordSweepError(): void {
    this.lastErrorAtMs = Date.now();
  }

  /** Snapshot the current counters for the cockpit `/api/health` surface. */
  getSummary(): TranscriptSweepSummary {
    return {
      sweepsRun: this.sweepsRun,
      sessionsIngested: this.sessionsIngested,
      sessionsErrored: this.sessionsErrored,
      sessionsQuarantined: this.sessionsQuarantined,
      embedRuns: this.embedRuns,
      lastSweepAt: this.lastSweepAtMs === null ? null : new Date(this.lastSweepAtMs).toISOString(),
      sweepsAborted: this.sweepsAborted,
      lastAbortAt: this.lastAbortAtMs === null ? null : new Date(this.lastAbortAtMs).toISOString(),
      lastProductiveSweepAt:
        this.lastProductiveSweepAtMs === null
          ? null
          : new Date(this.lastProductiveSweepAtMs).toISOString(),
      lastErrorAt: this.lastErrorAtMs === null ? null : new Date(this.lastErrorAtMs).toISOString(),
    };
  }
}
