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
   * Number of embedding backfill runs completed successfully.
   * Incremented once per sweep tick where embeddings ran without throwing.
   */
  embedRuns: number;
  /** ISO timestamp of the last completed sweep, or null (no sweep yet). */
  lastSweepAt: string | null;
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
  private embedRuns = 0;
  private lastSweepAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;

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
   */
  recordSweepCompleted(sessionsProcessed: number, sessionsErrored: number): void {
    this.sweepsRun++;
    this.sessionsIngested += sessionsProcessed < 0 ? 0 : sessionsProcessed;
    this.sessionsErrored += sessionsErrored < 0 ? 0 : sessionsErrored;
    this.lastSweepAtMs = Date.now();
    if (sessionsErrored > 0) {
      this.lastErrorAtMs = Date.now();
    }
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
      embedRuns: this.embedRuns,
      lastSweepAt: this.lastSweepAtMs === null ? null : new Date(this.lastSweepAtMs).toISOString(),
      lastErrorAt: this.lastErrorAtMs === null ? null : new Date(this.lastErrorAtMs).toISOString(),
    };
  }
}
