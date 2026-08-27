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

/**
 * The embedding phase's current state (mt#4524).
 *
 * A discriminated mode rather than a second boolean, extending ADR-035 rule 4's
 * uniform status shape (`mode` / `reason` / `lastAttemptAt`) from an
 * INITIALIZER to a network-dependent periodic OPERATION. The rule does not bind
 * literally — the backfill is not an initializer — but its shape is exactly what
 * is needed here, and the sibling `transcriptWatcher` block (mt#4492) already
 * takes the same posture with `ingestsInFlight` / `oldestIngestInFlightAgeMs`.
 *
 * - `never-attempted` — no backfill has started in this process's lifetime.
 * - `in-flight` — an attempt is running and is within its expected bound.
 * - `in-flight-overdue` — an attempt is running and has exceeded the bound. Its
 *   own condition, deliberately NOT folded into either neighbour: a hang runs
 *   neither the success nor the catch path, so a counter written only at
 *   conclusion stays silent on it forever (mem#862).
 * - `succeeded` / `failed` — the LAST attempt concluded, with that outcome.
 */
export type TranscriptEmbedPhase =
  | "never-attempted"
  | "in-flight"
  | "in-flight-overdue"
  | "succeeded"
  | "failed";

/**
 * Fallback overdue bound used until the sweeper configures the real one
 * (mt#4524). Equal to the sweep's own default cadence, for the reason given on
 * {@link deriveEmbedOverdueBoundMs} — the live value is set from the sweeper's
 * ACTUAL resolved interval, which an env override can change.
 */
export const DEFAULT_EMBED_OVERDUE_BOUND_MS = 30 * 60 * 1000;

/**
 * Derive the bound past which an in-flight backfill is reported as overdue.
 *
 * **Not a measured typical — a CEILING derived from two declared budgets**, per
 * `decision-defaults.mdc §Thresholds`, whose CEILING case says the binding
 * constraint is the enclosing budget's declared MAXIMUM rather than observed
 * cadence.
 *
 * - The SWEEP INTERVAL is the operationally meaningful line: an embedding phase
 *   still running when the next tick is due means ticks are now being skipped
 *   (`createIntervalSweeper`'s `running` flag drops an overlapping tick), so the
 *   sweep has stopped keeping its cadence. That is the condition an operator
 *   wants named.
 * - The TICK TIMEOUT caps it. A bound at or above the tick timeout would be dead
 *   code: `createIntervalSweeper` abandons the tick first and the operator gets
 *   `abandonedTicks` on `/api/sweeps` instead of anything this field says.
 *
 * With the shipped defaults that is `min(30m, 60m)` = 30 minutes.
 */
export function deriveEmbedOverdueBoundMs(sweepIntervalMs: number, tickTimeoutMs: number): number {
  return Math.min(sweepIntervalMs, tickTimeoutMs);
}

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
  /**
   * Embedding backfill attempts that CONCLUDED without success (mt#4524).
   *
   * The counterpart to `embedRuns`, and the field that makes
   * `embedNeverSucceeded` mean what its name says. Together the two count only
   * CONCLUDED attempts, so neither moves while one is in flight — which is what
   * {@link TranscriptSweepSummary.embedPhase} is for.
   */
  embedFailures: number;
  /**
   * Which state the embedding phase is in right now (mt#4524).
   *
   * Derived at read time from the in-flight stamp and the last conclusion —
   * never stored, for the same reason `oldestIngestInFlightAgeMs` is derived on
   * the watcher: a state stamped at write time is wrong by however long it sat
   * between polls, and "is it stuck" is the whole question.
   */
  embedPhase: TranscriptEmbedPhase;
  /**
   * Age of the in-flight backfill attempt, or null when none is running.
   *
   * Prefer this over `embedPhase` alone when judging severity: in-flight is
   * NORMAL, a large age is not. Derived at read time and clamped at 0, matching
   * the watcher's `oldestIngestInFlightAgeMs` exactly.
   */
  embedInFlightAgeMs: number | null;
  /**
   * The bound `embedInFlightAgeMs` is compared against to reach
   * `in-flight-overdue`. Published rather than kept internal so a reader can
   * see WHY a given age was or was not called overdue, without reading source.
   * See {@link deriveEmbedOverdueBoundMs} for where the number comes from.
   */
  embedOverdueBoundMs: number;
  /**
   * ISO timestamp of the last backfill attempt STARTED, or null (never
   * attempted). ADR-035 rule 4's `lastAttemptAt`: without it, "stuck since boot"
   * and "still retrying against a real outage" are indistinguishable.
   */
  lastEmbedAttemptAt: string | null;
  /**
   * True when the embedding backfill has never succeeded in this process's
   * lifetime AND at least one attempt has CONCLUDED without success (mt#4489,
   * corrected mt#4524).
   *
   * **The `sweepsRun > 0 && embedRuns === 0` derivation this shipped with was
   * wrong**, and wrong for the whole duration of every normal first backfill.
   * `recordSweepCompleted` ends Phase 1 and `recordEmbedRunCompleted` fires only
   * after Phase 2's `await` returns, so between them the old expression read
   * TRUE while the system was working correctly — observed live on 2026-08-25
   * for the ~10 s before the daemon restarted, and again in the payload mt#4524's
   * spec records. A field that also fires during normal operation reinstates the
   * ambiguity it was built to remove (mem#719).
   *
   * Now `embedRuns === 0 && embedFailures > 0`: both are conclusion-counted, so
   * an attempt in flight moves neither and this stays false until something has
   * actually finished without succeeding. A backfill that HANGS never concludes
   * and so never sets this — deliberately. That case is `embedPhase:
   * "in-flight-overdue"`, because a counter written only at conclusion is
   * structurally blind to it (mem#862), and folding the two together is what
   * made the naive `embedAttempts > embedRuns` fix wrong.
   *
   * Scoped to the PROCESS, like every other field here: a restart resets it,
   * which is correct — the failure class it exposes (a lazy import resolving
   * against a cwd that no longer exists) is itself process-scoped.
   */
  embedNeverSucceeded: boolean;
}

export class TranscriptSweepTracker {
  private static _instance: TranscriptSweepTracker | null = null;

  private sweepsRun = 0;
  private sessionsIngested = 0;
  private sessionsErrored = 0;
  private sessionsQuarantined = 0;
  private embedRuns = 0;
  private embedFailures = 0;
  /**
   * When the in-flight backfill attempt started, or null when none is running
   * (mt#4524).
   *
   * A single nullable stamp rather than the watcher's Map, because sweep ticks
   * cannot overlap: `createIntervalSweeper` skips a tick while one is already
   * running, and Phase 2 runs once per tick. The watcher needs a Map because its
   * ingests genuinely do overlap.
   */
  private embedStartedAtMs: number | null = null;
  private lastEmbedAttemptAtMs: number | null = null;
  /**
   * How the LAST attempt concluded, or null if none has. Tracked explicitly
   * rather than inferred from `embedRuns > 0` / `embedFailures > 0`, which
   * cannot order them: once a process has one of each, those counters alone
   * cannot say which came last.
   */
  private lastEmbedOutcome: "succeeded" | "failed" | null = null;
  private embedOverdueBoundMs: number = DEFAULT_EMBED_OVERDUE_BOUND_MS;
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
   * Configure the bound past which an in-flight backfill reads as overdue
   * (mt#4524). Called once by the sweeper from its own resolved interval; see
   * {@link deriveEmbedOverdueBoundMs}. Until then the fallback applies, so this
   * is never undefined.
   *
   * Non-positive values are ignored rather than stored: a zero or negative bound
   * would make every attempt overdue the instant it started, which is the
   * always-firing failure this task exists to remove.
   */
  setEmbedOverdueBoundMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) {
      this.embedOverdueBoundMs = ms;
    }
  }

  /**
   * Record that an embedding backfill attempt has STARTED (mt#4524).
   *
   * Called immediately BEFORE the awaited call, which is the whole point: this
   * is the boundary that can fail, and a counter written only after it returns
   * cannot report on an attempt that is running or one that never returns
   * (mem#862). `nowMs` is injectable so the derived age is assertable without a
   * real wait — same seam, same reason, as the watcher's `recordIngestStarted`.
   */
  recordEmbedRunStarted(nowMs: number = Date.now()): void {
    this.embedStartedAtMs = nowMs;
    this.lastEmbedAttemptAtMs = nowMs;
  }

  /**
   * Record a successful embedding backfill run.
   * Called after PerTurnEmbeddingPipeline.run() or equivalent completes without throwing.
   */
  recordEmbedRunCompleted(): void {
    this.embedRuns++;
    this.embedStartedAtMs = null;
    this.lastEmbedOutcome = "succeeded";
  }

  /**
   * Record an embedding backfill attempt that CONCLUDED by throwing (mt#4524).
   *
   * Distinct from {@link recordSweepError}, which the same catch block also
   * calls: that one records a sweep-level error timestamp shared with the ingest
   * phase, and cannot say the EMBEDDING phase is the part that failed. Clearing
   * the in-flight stamp here is what moves `embedPhase` out of `in-flight`.
   */
  recordEmbedRunFailed(): void {
    this.embedFailures++;
    this.embedStartedAtMs = null;
    this.lastEmbedOutcome = "failed";
  }

  /**
   * Record a sweep-level error (ingest threw, or embed threw).
   * Only the count + timestamp are stored (redaction policy — no raw message).
   * The caller logs the raw message at warn/error before calling this.
   */
  recordSweepError(): void {
    this.lastErrorAtMs = Date.now();
  }

  /**
   * Snapshot the current counters for the cockpit `/api/health` surface.
   *
   * `nowMs` is injectable so the derived in-flight age and the overdue
   * transition are assertable without a real wait — same seam, same reason, as
   * `TranscriptWatcherTracker.getSummary`.
   */
  getSummary(nowMs: number = Date.now()): TranscriptSweepSummary {
    // Derived at read time, never stored: an age stamped at write time is wrong
    // by however long it sat between polls, and "how long has this been running"
    // is the entire question these fields exist to answer.
    const embedInFlightAgeMs =
      this.embedStartedAtMs === null ? null : Math.max(0, nowMs - this.embedStartedAtMs);

    let embedPhase: TranscriptEmbedPhase;
    if (embedInFlightAgeMs !== null) {
      embedPhase =
        embedInFlightAgeMs > this.embedOverdueBoundMs ? "in-flight-overdue" : "in-flight";
    } else if (this.lastEmbedOutcome === null) {
      embedPhase = "never-attempted";
    } else {
      embedPhase = this.lastEmbedOutcome;
    }

    return {
      embedFailures: this.embedFailures,
      embedPhase,
      embedInFlightAgeMs,
      embedOverdueBoundMs: this.embedOverdueBoundMs,
      lastEmbedAttemptAt:
        this.lastEmbedAttemptAtMs === null
          ? null
          : new Date(this.lastEmbedAttemptAtMs).toISOString(),
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
      embedNeverSucceeded: this.embedRuns === 0 && this.embedFailures > 0,
    };
  }
}
