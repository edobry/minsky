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
  /**
   * Ingests started and not yet settled (mt#4492).
   *
   * `ingestsTriggered` counts STARTS — it is incremented before the ingest's
   * first await — so a started-and-never-finished ingest reads identically to a
   * quiet watcher on every other field here. That is not hypothetical: during a
   * pooler wedge on 2026-08-24 this object read `ingestsTriggered: 1` and an
   * EMPTY live-session list for four hours, which is exactly what an idle
   * watcher looks like.
   */
  ingestsInFlight: number;
  /**
   * Age of the OLDEST unsettled ingest, or null when none is in flight.
   *
   * Derived at read time rather than stored, so it cannot go stale between
   * polls. This is the field that discriminates "nothing to do" from "stuck":
   * a healthy watcher reads null or single-digit seconds, a wedged one climbs
   * without bound. Prefer it over `ingestsInFlight` alone — a non-zero COUNT is
   * normal, a large AGE is not.
   */
  oldestIngestInFlightAgeMs: number | null;
  /** Ingests abandoned at the wall-clock bound rather than completing (mt#4492). */
  ingestsAbandoned: number;
  /**
   * When the ingest path is in backoff, the ISO time it resumes; else null.
   *
   * Exposed rather than kept internal because a deliberately-paused watcher is
   * the same INERT-but-running shape this whole object exists to make legible —
   * pausing silently would reproduce the defect one layer up.
   */
  ingestPausedUntil: string | null;
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

/**
 * Recency window separating "the watcher knows this file exists" from "this
 * conversation is live right now" (mt#3857).
 *
 * The registry conflates the two by construction: `TranscriptWatcher.seedExisting()`
 * calls `recordSessionEvent()` for every PRE-EXISTING file at boot so the tailer can
 * seed byte offsets and skip re-streaming old history. That is correct for seeding
 * and wrong as a liveness signal — at boot, every conversation the watcher has ever
 * discovered carries a `lastEventAt` of "just now".
 *
 * This constant is the server-side home of a window that used to live only in the
 * browser (`useActiveConversationSessions.ts`), which filtered AFTER downloading the
 * whole registry. Applying it here is what keeps `/api/health` small: the endpoint is
 * polled every 5s by the tray supervisor (`cockpit-tray/src-tauri/src/supervisor.rs`)
 * and 3x/15s by the webview, so its size is multiplied by ~12 requests a minute for
 * the process lifetime.
 *
 * Window calibration is inherited unchanged from the frontend's original: long enough
 * to survive a multi-refetch gap or a slow tool call between turns, short enough to
 * exclude the boot scan. Revisit on reports of a live conversation losing its badge
 * mid-turn (window too short) or a stale one keeping it (too long).
 */
export const LIVE_SESSION_WINDOW_MS = 2 * 60 * 1000;

/** Shared row mapper, so the full-registry and live-subset views cannot drift apart. */
function toActiveSessionInfo(agentSessionId: string, s: ActiveSessionState): ActiveSessionInfo {
  return {
    agentSessionId,
    isSubagent: s.isSubagent,
    lastEventAt: s.lastEventAtMs === null ? null : new Date(s.lastEventAtMs).toISOString(),
    lastIngestAt: s.lastIngestAtMs === null ? null : new Date(s.lastIngestAtMs).toISOString(),
    lastTurnsIngested: s.lastTurnsIngested,
  };
}

/** Most-recently-active first; null `lastEventAt` sorts last (SC2 ordering). */
function byMostRecentlyActive(a: ActiveSessionInfo, b: ActiveSessionInfo): number {
  return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
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
  private ingestsAbandoned = 0;
  private ingestPausedUntilMs: number | null = null;

  /**
   * Unsettled ingests, keyed by `agentSessionId` → start time (mt#4492).
   *
   * Keyed by the SESSION id, never the absolute jsonl path: this map feeds the
   * unauthenticated `/api/health`, and the reviewer-R1 rule that keeps paths out
   * of `ActiveSessionInfo` applies with equal force to anything derived here.
   * Only a COUNT and an AGE are ever serialized, so no key escapes at all — the
   * keying just makes that structurally true rather than a convention.
   */
  private readonly inFlightIngests = new Map<string, number>();

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
   * Mark an ingest as started for `agentSessionId` (mt#4492).
   *
   * `nowMs` is injectable for the same reason {@link getLiveSessions}'s is —
   * the age this feeds is the assertion, and pinning the clock beats sleeping.
   */
  recordIngestStarted(agentSessionId: string, nowMs: number = Date.now()): void {
    this.inFlightIngests.set(agentSessionId, nowMs);
  }

  /**
   * Mark an ingest as settled — completed, failed, or abandoned at the bound.
   *
   * Deliberately indifferent to WHICH: the in-flight set answers "is something
   * stuck right now", and every one of those three outcomes means the answer is
   * no longer yes for this session. The outcome itself is recorded by the
   * `recordIngest*` counters.
   */
  recordIngestSettled(agentSessionId: string): void {
    this.inFlightIngests.delete(agentSessionId);
  }

  /** Record an ingest abandoned at its wall-clock bound (mt#4492). */
  recordIngestAbandoned(): void {
    this.ingestsAbandoned++;
  }

  /** Set (or clear, with null) the time the ingest path resumes after backoff. */
  setIngestPausedUntil(untilMs: number | null): void {
    this.ingestPausedUntilMs = untilMs;
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

  /**
   * Register a session discovered by the BOOT SCAN, without claiming it is live
   * (mt#3857). `lastEventAt` stays null: the watcher has learned the file exists,
   * which is not the same as having observed activity in it.
   *
   * This is the distinction `recordSessionEvent` cannot make — it stamps
   * `Date.now()` unconditionally, so calling it from `seedExisting()` marked every
   * conversation in the entire history as having just been active. That is what put
   * 1,380 entries in `/api/health`'s live list and made the window filter a no-op for
   * the first two minutes after every daemon restart.
   *
   * Byte-offset seeding is unaffected: that is `tailer.setOffset()`, a separate call
   * in `seedExisting()` that this does not touch.
   *
   * Existing entries are left alone — a real event that arrived before the scan
   * reached this file must not be downgraded to "seeded".
   */
  recordSessionSeeded(agentSessionId: string, isSubagent: boolean): void {
    if (this.sessions.has(agentSessionId)) return;
    this.sessions.set(agentSessionId, {
      isSubagent,
      lastEventAtMs: null,
      lastIngestAtMs: null,
      lastTurnsIngested: 0,
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
      .map(([agentSessionId, s]) => toActiveSessionInfo(agentSessionId, s))
      .sort(byMostRecentlyActive);
  }

  /**
   * The GENUINELY-live subset of the registry — entries whose `lastEventAt` falls
   * within `LIVE_SESSION_WINDOW_MS` of `nowMs` (mt#3857). This is what `/api/health`
   * serializes; `getActiveSessions()` above returns the FULL registry and is retained
   * for callers that want it (and for the tracker's own tests).
   *
   * Entries with a null `lastEventAt` are excluded: a session the registry has never
   * seen an event for cannot be live.
   *
   * `nowMs` is injectable so tests can pin the clock rather than sleeping.
   */
  getLiveSessions(nowMs: number = Date.now()): ActiveSessionInfo[] {
    // Select from the map, THEN sort — the live subset is normally a handful of
    // entries against a registry in the thousands, and this runs on every
    // /api/health poll. Going through getActiveSessions() would pay O(N log N)
    // on the whole registry to return O(1) of it.
    const live: ActiveSessionInfo[] = [];
    for (const [agentSessionId, s] of this.sessions) {
      if (s.lastEventAtMs === null) continue;
      if (nowMs - s.lastEventAtMs > LIVE_SESSION_WINDOW_MS) continue;
      live.push(toActiveSessionInfo(agentSessionId, s));
    }
    return live.sort(byMostRecentlyActive);
  }

  /**
   * Snapshot the current counters for the cockpit `/api/health` surface.
   *
   * `nowMs` is injectable so the derived in-flight age is assertable without a
   * real wait — same seam, same reason, as {@link getLiveSessions}.
   */
  getSummary(nowMs: number = Date.now()): TranscriptWatcherSummary {
    // Derived at read time, never stored: an age stamped at write time is wrong
    // by however long it sat between polls, and "how long has this been stuck"
    // is the entire question this field exists to answer.
    let oldestStartedAtMs: number | null = null;
    for (const startedAtMs of this.inFlightIngests.values()) {
      if (oldestStartedAtMs === null || startedAtMs < oldestStartedAtMs) {
        oldestStartedAtMs = startedAtMs;
      }
    }

    return {
      running: this.running,
      ingestsInFlight: this.inFlightIngests.size,
      // Clamped at 0 rather than allowed negative: an injected or skewed clock
      // reading before the start stamp is a measurement artifact, and a
      // negative age would read as a live defect.
      oldestIngestInFlightAgeMs:
        oldestStartedAtMs === null ? null : Math.max(0, nowMs - oldestStartedAtMs),
      ingestsAbandoned: this.ingestsAbandoned,
      ingestPausedUntil:
        this.ingestPausedUntilMs === null ? null : new Date(this.ingestPausedUntilMs).toISOString(),
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
