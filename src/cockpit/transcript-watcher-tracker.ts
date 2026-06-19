/**
 * TranscriptWatcherTracker — in-memory health counters for the cockpit-daemon
 * transcript watcher (mt#2320, SC5).
 *
 * The watcher ingests appended transcript turns near-real-time; this tracker
 * makes its activity and failures observable instead of silently swallowed. It
 * is a process-lifetime singleton, written by the watcher and read by the
 * cockpit server's `/api/health` endpoint — both run in the SAME cockpit
 * process, so an in-memory singleton is sufficient.
 *
 * Note (mt#2320): the watcher does NOT surface through `debug_systemInfo`. That
 * tool runs in the MCP-server process, a different process from the cockpit
 * daemon where the watcher lives; an in-memory singleton there would always
 * read zero. The same-process cockpit `/api/health` surface (plus the log
 * surface) is the correct observability channel. Cross-process exposure, if
 * ever needed, would require a shared store (DB/file) like DisconnectTracker.
 *
 * @see src/mcp/disconnect-tracker.ts — singleton pattern this mirrors
 * @see mt#2320 — cockpit-daemon transcript watcher
 */

export interface TranscriptWatcherSummary {
  /** Whether the watcher is currently attached and watching. */
  running: boolean;
  /** Number of `.jsonl` files currently tracked by the watcher. */
  filesWatched: number;
  /** Total ingest attempts triggered by file-change events. */
  ingestsTriggered: number;
  /** Ingest attempts that completed without a surfaced error. */
  ingestsSucceeded: number;
  /** Ingest attempts that surfaced an error (counted, not dropped). */
  ingestErrors: number;
  /** Total new turn lines ingested across all successful attempts. */
  turnsIngested: number;
  /** ISO timestamp of the last successful ingest, or null. */
  lastIngestAt: string | null;
  /** ISO timestamp of the last ingest error, or null. */
  lastErrorAt: string | null;
  // NOTE: the raw last-error MESSAGE is deliberately NOT exposed here. /api/health
  // is unauthenticated, and error strings can leak absolute paths / internals
  // (reviewer R1). The message is still emitted to the log surface by the
  // watcher's log.warn at each call site; only the count + timestamp are public.
}

/**
 * Per-session ingestion-freshness entry for the active-session registry (SC2).
 * Seeded from the watcher's FS discovery and updated as files change/ingest.
 *
 * NOTE: the absolute `jsonlPath` is deliberately NOT exposed (reviewer R1 —
 * /api/health is unauthenticated; absolute paths are an info-disclosure risk).
 * `agentSessionId` (the JSONL filename stem) is the stable public identifier.
 */
export interface ActiveSessionInfo {
  agentSessionId: string;
  /** True for subagent transcripts under `<parent>/subagents/`. */
  isSubagent: boolean;
  /** ISO timestamp of the last filesystem event observed for this session. */
  lastEventAt: string | null;
  /** ISO timestamp of the last successful ingest of this session, or null. */
  lastIngestAt: string | null;
  /** New turn lines ingested on the last successful ingest of this session. */
  lastTurnsIngested: number;
}

interface ActiveSessionState {
  isSubagent: boolean;
  lastEventAtMs: number | null;
  lastIngestAtMs: number | null;
  lastTurnsIngested: number;
}

export class TranscriptWatcherTracker {
  private static _instance: TranscriptWatcherTracker | null = null;

  private running = false;
  private filesWatched = 0;
  private ingestsTriggered = 0;
  private ingestsSucceeded = 0;
  private ingestErrors = 0;
  private turnsIngested = 0;
  private lastIngestAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;

  /** Per-session ingestion-freshness registry (SC2), keyed by agentSessionId. */
  private readonly sessions = new Map<string, ActiveSessionState>();

  /** Process-lifetime singleton (created on first access). */
  static getInstance(): TranscriptWatcherTracker {
    if (!TranscriptWatcherTracker._instance) {
      TranscriptWatcherTracker._instance = new TranscriptWatcherTracker();
    }
    return TranscriptWatcherTracker._instance;
  }

  /** Reset the singleton for tests. */
  static resetForTest(): TranscriptWatcherTracker {
    TranscriptWatcherTracker._instance = new TranscriptWatcherTracker();
    return TranscriptWatcherTracker._instance;
  }

  /** Mark the watcher attached/detached. */
  setRunning(running: boolean): void {
    this.running = running;
  }

  /** Record the current count of watched files (set from the watcher's registry). */
  setFilesWatched(count: number): void {
    this.filesWatched = count < 0 ? 0 : count;
  }

  /** Increment the triggered-ingest counter (called before each ingest attempt). */
  recordIngestTriggered(): void {
    this.ingestsTriggered++;
  }

  /** Record a successful ingest of `turns` new turn lines. */
  recordIngestSuccess(turns: number): void {
    this.ingestsSucceeded++;
    this.turnsIngested += turns < 0 ? 0 : turns;
    this.lastIngestAtMs = Date.now();
  }

  /**
   * Record an ingest error (surfaced, not dropped — SC5). Only the count +
   * timestamp are retained; the raw message is logged by the caller, not stored
   * here (it must not reach the unauthenticated /api/health surface — reviewer R1).
   */
  recordIngestError(): void {
    this.ingestErrors++;
    this.lastErrorAtMs = Date.now();
  }

  /**
   * Register/refresh a session from a filesystem event (SC2). Seeds the
   * registry on FS discovery and stamps `lastEventAt`.
   */
  recordSessionEvent(agentSessionId: string, isSubagent: boolean): void {
    const existing = this.sessions.get(agentSessionId);
    this.sessions.set(agentSessionId, {
      isSubagent,
      lastEventAtMs: Date.now(),
      lastIngestAtMs: existing?.lastIngestAtMs ?? null,
      lastTurnsIngested: existing?.lastTurnsIngested ?? 0,
    });
  }

  /** Stamp a session's last successful ingest (SC2). */
  recordSessionIngest(agentSessionId: string, turns: number): void {
    const existing = this.sessions.get(agentSessionId);
    if (!existing) return;
    existing.lastIngestAtMs = Date.now();
    existing.lastTurnsIngested = turns < 0 ? 0 : turns;
  }

  /** Drop a session from the registry (e.g. on file unlink). */
  removeSession(agentSessionId: string): void {
    this.sessions.delete(agentSessionId);
  }

  /** Number of sessions currently in the registry. */
  get trackedSessionCount(): number {
    return this.sessions.size;
  }

  /** Active-session registry snapshot, most-recently-active first (SC2). */
  getActiveSessions(): ActiveSessionInfo[] {
    return Array.from(this.sessions.entries())
      .map(([agentSessionId, s]) => ({
        agentSessionId,
        isSubagent: s.isSubagent,
        lastEventAt: s.lastEventAtMs === null ? null : new Date(s.lastEventAtMs).toISOString(),
        lastIngestAt: s.lastIngestAtMs === null ? null : new Date(s.lastIngestAtMs).toISOString(),
        lastTurnsIngested: s.lastTurnsIngested,
      }))
      .sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
  }

  /** Snapshot the current counters for the cockpit `/api/health` surface. */
  getSummary(): TranscriptWatcherSummary {
    return {
      running: this.running,
      filesWatched: this.filesWatched,
      ingestsTriggered: this.ingestsTriggered,
      ingestsSucceeded: this.ingestsSucceeded,
      ingestErrors: this.ingestErrors,
      turnsIngested: this.turnsIngested,
      lastIngestAt:
        this.lastIngestAtMs === null ? null : new Date(this.lastIngestAtMs).toISOString(),
      lastErrorAt: this.lastErrorAtMs === null ? null : new Date(this.lastErrorAtMs).toISOString(),
    };
  }
}
