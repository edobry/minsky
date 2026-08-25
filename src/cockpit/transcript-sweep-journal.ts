/**
 * Cross-restart tick journal for the transcript sweep backstop (mt#4532).
 *
 * Every counter on {@link TranscriptSweepTracker} is PROCESS-scoped, and the
 * cockpit daemon is restarted by the tray on every merge touching
 * `src/cockpit/**` or `packages/**` (mem#1227). Measured 2026-08-25: 23 daemon
 * boots in one working day, a median 13.4 minutes apart, against a 30-minute
 * sweep cadence whose Phase 1 alone takes ~12 minutes. So a tick that is
 * replaced mid-flight leaves NO trace: the counters reset, and the post-restart
 * payload is byte-identical to a daemon that never swept at all.
 *
 * This module is the record that survives the process. It is deliberately NOT
 * in Postgres, which is the repo default for state (`decision-defaults.mdc
 * §Datastores`) — the deviation is the point rather than an oversight. Two of
 * the three outcomes this journal exists to record (`aborted`, `skipped`) occur
 * precisely BECAUSE the database is unreachable, so a Postgres-backed journal
 * would fail to record exactly the events it was built for. A local state file
 * is the same choice `dispatch-watchdog.ts` and `ask-state-cache.ts` already
 * make for cross-restart cockpit state, via the same `getStateDir()` +
 * `atomicWriteJSON` pair.
 *
 * Split from `transcript-sweep-tracker.ts` rather than added to it: that file is
 * at 416 lines against a 400-line `max-lines` warn, and mixing lifetime counters
 * into a tracker whose whole contract is "this process" is the confusion mt#4524
 * spent a task removing.
 *
 * @see src/cockpit/transcript-sweep-backstop.ts — the tick that writes this
 * @see docs/architecture/cockpit.md — the `/api/health` payload this projects into
 */

import path from "path";
import fs from "fs";
import { log } from "@minsky/shared/logger";
import { getStateDir, atomicWriteJSON } from "./lifecycle";

/** Journal filename under the Minsky state dir. */
export const TRANSCRIPT_SWEEP_JOURNAL_FILENAME = "transcript-sweep-journal.json";

/** Absolute path to the transcript-sweep journal file. */
export function getTranscriptSweepJournalPath(): string {
  return path.join(getStateDir(), TRANSCRIPT_SWEEP_JOURNAL_FILENAME);
}

/**
 * How many concluded ticks to retain for eyeballing.
 *
 * Grounded per `decision-defaults.mdc §Thresholds` rather than picked round: at
 * the 30-minute cadence 20 entries is ~10 hours of ticks, which covers a working
 * day's active window (the 2026-08-25 measurement ran 16:19Z–21:45Z) without the
 * file growing without bound. The cumulative answer SC1 asks for lives in
 * {@link TranscriptSweepJournal.totals}, which is not truncated — this list is
 * for reading, not for arithmetic.
 */
export const JOURNAL_RECENT_LIMIT = 20;

/**
 * Which phase a tick had reached when it was recorded.
 *
 * `ingest` is Phase 1; `embed` is Phase 2, the embedding backfill. The whole
 * subject of mt#4532 is how rarely a tick reaches `embed` at all, so this is the
 * discriminator every consumer reads.
 */
export type SweepTickPhase = "ingest" | "embed";

/**
 * How a tick ENDED. Five outcomes, and the distinction between them is the
 * finding rather than bookkeeping:
 *
 * - `completed` — both phases ran to conclusion.
 * - `embed-failed` — Phase 1 completed, Phase 2 was attempted and threw.
 * - `aborted` — Phase 1 abandoned mid-pass because the DB connection died
 *   (mt#4480). Phase 2 is never reached: it needs the same dead connection.
 * - `failed` — the tick errored before Phase 1 concluded (an ingest throw, or a
 *   `PersistenceService.initialize()` timeout).
 * - `skipped` — the tick declined to run: schema behind (mt#3297) or no
 *   SQL-capable provider. Deliberate and correct, and still not work done.
 * - `interrupted` — no terminal record was ever written, because the process was
 *   replaced. Reconstructed at boot, never written by the tick itself.
 */
export type SweepTickOutcome =
  | "completed"
  | "embed-failed"
  | "aborted"
  | "failed"
  | "skipped"
  | "interrupted";

/** A tick currently in flight, as recorded at its START. */
export interface InFlightTick {
  startedAt: string;
  pid: number;
  phase: SweepTickPhase;
}

/** A concluded tick. */
export interface ConcludedTick {
  startedAt: string;
  endedAt: string;
  pid: number;
  outcome: SweepTickOutcome;
  /** Whether Phase 2 was entered at all — SC1's numerator. */
  reachedPhase2: boolean;
}

/** Cumulative counts, never truncated. */
export interface SweepTickTotals {
  started: number;
  completed: number;
  embedFailed: number;
  aborted: number;
  failed: number;
  skipped: number;
  interrupted: number;
  /** Ticks that entered Phase 2, whether or not it then succeeded. */
  reachedPhase2: number;
}

/** The on-disk journal. */
export interface TranscriptSweepJournal {
  inFlight: InFlightTick | null;
  recent: ConcludedTick[];
  totals: SweepTickTotals;
}

/** A journal with nothing recorded — the shape a fresh install reads. */
export function emptyJournal(): TranscriptSweepJournal {
  return {
    inFlight: null,
    recent: [],
    totals: {
      started: 0,
      completed: 0,
      embedFailed: 0,
      aborted: 0,
      failed: 0,
      skipped: 0,
      interrupted: 0,
      reachedPhase2: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure folds — the functional core (no IO, no clock, no pid)
// ---------------------------------------------------------------------------

/** Which totals key an outcome increments. */
const OUTCOME_TOTALS_KEY: Record<SweepTickOutcome, keyof SweepTickTotals> = {
  completed: "completed",
  "embed-failed": "embedFailed",
  aborted: "aborted",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

/** Record a tick START. Any prior `inFlight` is preserved by the caller's reconcile pass. */
export function foldTickStarted(
  journal: TranscriptSweepJournal,
  startedAt: string,
  pid: number
): TranscriptSweepJournal {
  return {
    ...journal,
    inFlight: { startedAt, pid, phase: "ingest" },
    totals: { ...journal.totals, started: journal.totals.started + 1 },
  };
}

/**
 * Record that the tick entered Phase 2.
 *
 * Marks the attempt at its START, not at its conclusion — the same correction
 * mt#4524 made to `embedPhase` for the same reason: over ~1,500 sessions Phase 2
 * is minutes long, and a record written only at the end cannot distinguish
 * "running" from "never got there" for that whole window. `reachedPhase2` is
 * incremented HERE, so a tick killed inside Phase 2 still counts as having
 * reached it.
 */
export function foldPhase2Started(journal: TranscriptSweepJournal): TranscriptSweepJournal {
  if (journal.inFlight === null) return journal;
  return {
    ...journal,
    inFlight: { ...journal.inFlight, phase: "embed" },
    totals: { ...journal.totals, reachedPhase2: journal.totals.reachedPhase2 + 1 },
  };
}

/**
 * Conclude the in-flight tick.
 *
 * A terminal record with no `inFlight` is dropped rather than invented: it means
 * the journal was cleared or written by another process between start and end,
 * and fabricating a start time would put a wrong number into the one surface
 * that is supposed to be trustworthy across restarts.
 */
export function foldTickEnded(
  journal: TranscriptSweepJournal,
  outcome: SweepTickOutcome,
  endedAt: string
): TranscriptSweepJournal {
  const inFlight = journal.inFlight;
  if (inFlight === null) return journal;
  const concluded: ConcludedTick = {
    startedAt: inFlight.startedAt,
    endedAt,
    pid: inFlight.pid,
    outcome,
    reachedPhase2: inFlight.phase === "embed",
  };
  const key = OUTCOME_TOTALS_KEY[outcome];
  return {
    inFlight: null,
    recent: [...journal.recent, concluded].slice(-JOURNAL_RECENT_LIMIT),
    totals: { ...journal.totals, [key]: journal.totals[key] + 1 },
  };
}

/**
 * Boot-time reconcile: an `inFlight` record whose process is gone was INTERRUPTED.
 *
 * The liveness check is what keeps this correct under two concurrent daemons
 * (mt#4243): a live foreign pid owns its tick, so the record is left alone
 * rather than stolen and mis-recorded as interrupted. A pid belonging to THIS
 * process cannot appear here — reconcile runs before this process starts a tick.
 */
export function foldReconcile(
  journal: TranscriptSweepJournal,
  isAlive: (pid: number) => boolean,
  reconciledAt: string
): { journal: TranscriptSweepJournal; interrupted: InFlightTick | null } {
  const inFlight = journal.inFlight;
  if (inFlight === null) return { journal, interrupted: null };
  if (isAlive(inFlight.pid)) return { journal, interrupted: null };
  return {
    journal: foldTickEnded(journal, "interrupted", reconciledAt),
    interrupted: inFlight,
  };
}

// ---------------------------------------------------------------------------
// Store — the imperative shell
// ---------------------------------------------------------------------------

/** Read/write seam so tests need no real filesystem (`custom/no-real-fs-in-tests`). */
export interface SweepJournalStore {
  read(): TranscriptSweepJournal;
  write(journal: TranscriptSweepJournal): void;
}

/**
 * Every field present and of the right type — a partial file is discarded, not merged.
 *
 * Exported so it can be tested directly: it is the one piece of the file store
 * that carries logic, and reaching it through `createFileJournalStore` would
 * need a real filesystem (`custom/no-real-fs-in-tests`).
 */
export function isJournalShaped(value: unknown): value is TranscriptSweepJournal {
  if (typeof value !== "object" || value === null) return false;
  const j = value as Partial<TranscriptSweepJournal>;
  if (!Array.isArray(j.recent)) return false;
  if (typeof j.totals !== "object" || j.totals === null) return false;
  const empty = emptyJournal().totals;
  for (const key of Object.keys(empty) as (keyof SweepTickTotals)[]) {
    if (typeof (j.totals as SweepTickTotals)[key] !== "number") return false;
  }
  return j.inFlight === null || typeof j.inFlight === "object";
}

/** The real file-backed store. */
export function createFileJournalStore(
  filePath = getTranscriptSweepJournalPath()
): SweepJournalStore {
  return {
    read(): TranscriptSweepJournal {
      try {
        // `String(...)` around the read follows `ask-state-cache.ts`'s documented
        // convention: the root tsconfig's fs typings widen every readFileSync
        // return to `string | Buffer` regardless of the encoding argument.
        const parsed: unknown = JSON.parse(String(fs.readFileSync(filePath, "utf-8")));
        if (!isJournalShaped(parsed)) {
          log.warn("cockpit: transcript sweep journal: unreadable shape, starting fresh", {
            filePath,
          });
          return emptyJournal();
        }
        return parsed;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // A missing file is the normal first-boot case, not a fault.
        if (e.code !== "ENOENT") {
          log.warn("cockpit: transcript sweep journal: read failed, starting fresh", {
            filePath,
            message: e.message,
          });
        }
        return emptyJournal();
      }
    },
    write(journal: TranscriptSweepJournal): void {
      atomicWriteJSON(filePath, journal);
    },
  };
}

/**
 * An in-process store holding the journal in memory.
 *
 * For tests (`custom/no-real-fs-in-tests`), and for any caller that wants the
 * journal's behaviour without its durability. `startTranscriptSweepBackstop`
 * takes its recorder as a REQUIRED parameter rather than defaulting to one, so
 * a test that wants this store passes it explicitly — ADR-026 rule 3 bans the
 * `opts?.x ?? create...()` shape precisely because a forgotten injection would
 * otherwise silently reach the real state dir.
 */
export function createMemoryJournalStore(
  initial: TranscriptSweepJournal = emptyJournal()
): SweepJournalStore {
  let state = initial;
  return {
    read: () => state,
    write: (journal) => {
      state = journal;
    },
  };
}

// ---------------------------------------------------------------------------
// Recorder — what the sweep tick actually calls
// ---------------------------------------------------------------------------

/**
 * The journal's write-side, wired to a store.
 *
 * Every method is FAIL-OPEN and swallows its own errors with a log: a journal
 * that cannot be written must never take down the sweep it is observing. That is
 * the one place `custom/no-silent-catch` would object and the reason is stated
 * rather than assumed — an observability side-channel breaking the work it
 * observes inverts the point of it.
 */
export class TranscriptSweepJournalRecorder {
  constructor(
    private readonly store: SweepJournalStore,
    private readonly now: () => Date = () => new Date(),
    private readonly pid: number = process.pid
  ) {}

  /** Fold `fn` over the stored journal and persist the result. Never throws. */
  private mutate(fn: (j: TranscriptSweepJournal) => TranscriptSweepJournal, op: string): void {
    try {
      this.store.write(fn(this.store.read()));
    } catch (err) {
      log.warn("cockpit: transcript sweep journal: write failed (non-fatal)", {
        op,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  tickStarted(): void {
    this.mutate((j) => foldTickStarted(j, this.now().toISOString(), this.pid), "tickStarted");
  }

  phase2Started(): void {
    this.mutate(foldPhase2Started, "phase2Started");
  }

  tickEnded(outcome: SweepTickOutcome): void {
    this.mutate((j) => foldTickEnded(j, outcome, this.now().toISOString()), "tickEnded");
  }

  /**
   * Fold any orphaned in-flight tick from a dead process into the totals.
   *
   * Logs at ERROR when one is found: this is the event the whole module exists
   * to make visible, and it is exactly the thing that previously left no trace.
   */
  reconcileAtBoot(isAlive: (pid: number) => boolean): void {
    try {
      const { journal, interrupted } = foldReconcile(
        this.store.read(),
        isAlive,
        this.now().toISOString()
      );
      if (interrupted === null) return;
      this.store.write(journal);
      log.error("cockpit: transcript sweep: previous tick was INTERRUPTED — process replaced", {
        startedAt: interrupted.startedAt,
        pid: interrupted.pid,
        phase: interrupted.phase,
        reachedPhase2: interrupted.phase === "embed",
      });
    } catch (err) {
      log.warn("cockpit: transcript sweep journal: boot reconcile failed (non-fatal)", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Health projection
// ---------------------------------------------------------------------------

/** The cross-restart block projected under `/api/health`'s `transcriptSweep`. */
export interface SweepJournalSummary {
  totals: SweepTickTotals;
  /** `reachedPhase2 / started`, rounded to 3 decimals — null before any tick started. */
  phase2ReachRate: number | null;
  /** The tick running right now, or null. Present ONLY while one is in flight. */
  inFlight: InFlightTick | null;
  lastOutcome: SweepTickOutcome | null;
  lastEndedAt: string | null;
}

/**
 * Project the journal for `/api/health`.
 *
 * `phase2ReachRate` is SC1's answer in one number, and it is deliberately a rate
 * over LIFETIME ticks rather than over a window: the failure this task exists to
 * surface is that the rate is low, and a window short enough to be "current" is
 * also short enough to contain zero ticks on a daemon that keeps restarting —
 * which reads as no-opinion exactly when the news is worst.
 */
export function summarizeJournal(journal: TranscriptSweepJournal): SweepJournalSummary {
  const last = journal.recent[journal.recent.length - 1] ?? null;
  const { started, reachedPhase2 } = journal.totals;
  return {
    totals: journal.totals,
    phase2ReachRate: started === 0 ? null : Math.round((reachedPhase2 / started) * 1000) / 1000,
    inFlight: journal.inFlight,
    lastOutcome: last === null ? null : last.outcome,
    lastEndedAt: last === null ? null : last.endedAt,
  };
}

/** Read-and-summarize for the health route. Never throws; degrades to an empty journal. */
export function readJournalSummary(
  store: SweepJournalStore = createFileJournalStore()
): SweepJournalSummary {
  try {
    return summarizeJournal(store.read());
  } catch (err) {
    log.warn("cockpit: transcript sweep journal: summary read failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return summarizeJournal(emptyJournal());
  }
}
