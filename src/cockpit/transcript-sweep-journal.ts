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

/** Journal filename for the INGEST sweep, under the Minsky state dir. */
export const TRANSCRIPT_SWEEP_JOURNAL_FILENAME = "transcript-sweep-journal.json";

/**
 * Journal filename for the EMBEDDING BACKFILL sweep (mt#4601).
 *
 * A second FILE rather than a second key inside the first: the store already
 * takes a path, so two independent sweeps get two independent journals with no
 * shape change and no migration of the file already in production. Each sweep's
 * counters then mean exactly one thing, which is the property the split exists
 * to create.
 */
export const TRANSCRIPT_BACKFILL_JOURNAL_FILENAME = "transcript-backfill-journal.json";

/** Absolute path to the ingest sweep's journal file. */
export function getTranscriptSweepJournalPath(): string {
  return path.join(getStateDir(), TRANSCRIPT_SWEEP_JOURNAL_FILENAME);
}

/** Absolute path to the embedding backfill's journal file. */
export function getTranscriptBackfillJournalPath(): string {
  return path.join(getStateDir(), TRANSCRIPT_BACKFILL_JOURNAL_FILENAME);
}

/**
 * The two sweep labels, shared so producer and tests cannot drift (mt#4601).
 *
 * Each appears in every log line its journal writes, and a recorder's label is
 * the only thing distinguishing "previous tick was INTERRUPTED" between the two
 * sweeps — so a typo in one call site would silently mis-attribute an incident
 * rather than fail anything.
 */
export const INGEST_SWEEP_LABEL = "transcript sweep";
export const BACKFILL_SWEEP_LABEL = "embedding backfill";

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
 * How a tick ENDED. Five outcomes, and the distinction between them is the
 * finding rather than bookkeeping:
 *
 * - `completed` — the tick's work ran to conclusion.
 * - `aborted` — the pass was abandoned mid-flight because the DB connection died
 *   (mt#4480). Ingest-specific in practice; the backfill has no such marker.
 * - `failed` — the tick threw (an ingest throw, a failing backfill, or a
 *   `PersistenceService.initialize()` timeout).
 * - `skipped` — the tick declined to run: schema behind (mt#3297) or no
 *   SQL-capable provider. Deliberate and correct, and still not work done.
 * - `interrupted` — no terminal record was ever written, because the process was
 *   replaced. Reconstructed at boot, never written by the tick itself.
 *
 * **`embed-failed` and the `phase` discriminator were RETIRED by mt#4601**, which
 * split the embedding backfill into its own sweep. They existed to say WHERE
 * inside a two-phase tick something happened; once each sweep has exactly one
 * job, the sweep's own journal answers that and a phase field would be a
 * constant. A failing backfill is now plainly `failed` in the backfill's journal.
 */
export type SweepTickOutcome = "completed" | "aborted" | "failed" | "skipped" | "interrupted";

/** A tick currently in flight, as recorded at its START. */
export interface InFlightTick {
  startedAt: string;
  pid: number;
}

/** A concluded tick. */
export interface ConcludedTick {
  startedAt: string;
  endedAt: string;
  pid: number;
  outcome: SweepTickOutcome;
}

/** Cumulative counts, never truncated. */
export interface SweepTickTotals {
  started: number;
  completed: number;
  aborted: number;
  failed: number;
  skipped: number;
  interrupted: number;
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
      aborted: 0,
      failed: 0,
      skipped: 0,
      interrupted: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure folds — the functional core (no IO, no clock, no pid)
// ---------------------------------------------------------------------------

/** Which totals key an outcome increments. */
const OUTCOME_TOTALS_KEY: Record<SweepTickOutcome, keyof SweepTickTotals> = {
  completed: "completed",
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
    inFlight: { startedAt, pid },
    totals: { ...journal.totals, started: journal.totals.started + 1 },
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
 * Two guards, for two different concurrency hazards under two daemons (mt#4243).
 *
 * **Liveness** — a live foreign pid still OWNS its tick, so its record is left
 * alone rather than stolen and mis-recorded as interrupted. A pid belonging to
 * THIS process cannot appear: reconcile runs before this process starts a tick.
 *
 * **Identity (PR #3357 R1)** — an orphan already concluded in `recent` is never
 * folded a second time. Reconcile is a read-modify-write with no lock, and the
 * reviewer asked what happens when two fresh daemons run it against the same
 * orphan. Note the specific mechanism raised — each incrementing `interrupted`,
 * so it lands at 2 — does NOT occur: `atomicWriteJSON` replaces the whole file,
 * so two folds from the same pre-image compute the same journal and the second
 * write overwrites the first with an identical value. Any strict interleaving
 * ends at 1: read/read/write/write yields the second writer's copy of the same
 * result, and read/write/read/write has the second reader seeing `inFlight:
 * null` and doing nothing.
 *
 * The guard is here anyway, because the SHAPE of the concern is right even where
 * that arithmetic is not. Whole-file replacement makes the outcome depend on the
 * write order rather than on the data, and this fold is the one place a single
 * real-world event could be recorded twice — so making it idempotent per orphan
 * costs one comparison and removes a class rather than an instance. What it does
 * NOT fix is the general lost update between concurrent writers (documented in
 * mt#4532's `## Outcome` §SC4); that needs arbitration this file cannot provide.
 */
export function foldReconcile(
  journal: TranscriptSweepJournal,
  isAlive: (pid: number) => boolean,
  reconciledAt: string
): { journal: TranscriptSweepJournal; interrupted: InFlightTick | null } {
  const inFlight = journal.inFlight;
  if (inFlight === null) return { journal, interrupted: null };
  if (isAlive(inFlight.pid)) return { journal, interrupted: null };
  if (isAlreadyConcluded(journal, inFlight)) {
    // Clear the stale pointer, but do not count the event again.
    return { journal: { ...journal, inFlight: null }, interrupted: null };
  }
  return {
    journal: foldTickEnded(journal, "interrupted", reconciledAt),
    interrupted: inFlight,
  };
}

/**
 * Has this exact orphan already been concluded as `interrupted`?
 *
 * Identity is `(startedAt, pid)` — the pair a tick is stamped with at START and
 * carries into `recent` when it concludes. `recent` is bounded, so an entry can
 * age out; that is irrelevant here, since a competing reconcile happens within
 * the same boot window and the entry is necessarily the newest one.
 */
function isAlreadyConcluded(journal: TranscriptSweepJournal, orphan: InFlightTick): boolean {
  return journal.recent.some(
    (t) => t.outcome === "interrupted" && t.pid === orphan.pid && t.startedAt === orphan.startedAt
  );
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
/**
 * Rebuild `totals` from the CURRENT key set, discarding any others (PR #3370 R1).
 *
 * A journal written by a pre-mt#4601 build carries `reachedPhase2` and
 * `embedFailed`. `isJournalShaped` accepts it — nothing was added, only removed —
 * so without this those keys would ride along in the file forever, and every
 * `/api/health` payload would carry retired fields beside the live ones. Reading
 * through this makes the first write after an upgrade drop them.
 *
 * Deliberately additive-safe: a key the current build expects but the file lacks
 * takes the `emptyJournal()` zero rather than `undefined`, so a FORWARD migration
 * (a totals key added later) reads a stale file without producing NaN downstream.
 */
export function normalizeJournal(journal: TranscriptSweepJournal): TranscriptSweepJournal {
  const base = emptyJournal().totals;
  const totals = { ...base };
  for (const key of Object.keys(base) as (keyof SweepTickTotals)[]) {
    const v = journal.totals[key];
    if (typeof v === "number") totals[key] = v;
  }
  return { inFlight: journal.inFlight, recent: journal.recent, totals };
}

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
        if (isJournalShaped(parsed)) return normalizeJournal(parsed);
        log.warn("cockpit: transcript sweep journal: unreadable shape, starting fresh", {
          filePath,
        });
        return emptyJournal();
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
  /**
   * @param label names WHICH sweep this journal belongs to, and appears in every
   *   log line it writes (mt#4601). Two sweeps now keep journals of the same
   *   shape, so an unlabelled "previous tick was INTERRUPTED" would not say
   *   whether ingest or the backfill was the one replaced — which is the single
   *   question the line exists to answer.
   */
  constructor(
    private readonly store: SweepJournalStore,
    private readonly label: string = "transcript sweep",
    private readonly now: () => Date = () => new Date(),
    private readonly pid: number = process.pid
  ) {}

  /** Fold `fn` over the stored journal and persist the result. Never throws. */
  private mutate(fn: (j: TranscriptSweepJournal) => TranscriptSweepJournal, op: string): void {
    try {
      this.store.write(fn(this.store.read()));
    } catch (err) {
      log.warn(`cockpit: ${this.label} journal: write failed (non-fatal)`, {
        op,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  tickStarted(): void {
    this.mutate((j) => foldTickStarted(j, this.now().toISOString(), this.pid), "tickStarted");
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
      log.error(`cockpit: ${this.label}: previous tick was INTERRUPTED — process replaced`, {
        startedAt: interrupted.startedAt,
        pid: interrupted.pid,
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

/** The cross-restart block projected under `/api/health`. */
export interface SweepJournalSummary {
  totals: SweepTickTotals;
  /** `completed / started`, rounded to 3 decimals — null before any tick started. */
  completionRate: number | null;
  /** The tick running right now, or null. Present ONLY while one is in flight. */
  inFlight: InFlightTick | null;
  lastOutcome: SweepTickOutcome | null;
  lastEndedAt: string | null;
}

/**
 * Project the journal for `/api/health`.
 *
 * **`completionRate` REPLACES mt#4532's `phase2ReachRate` (mt#4601).** That field
 * asked how often a two-phase tick reached its second phase, which stopped being
 * a question the moment the backfill became its own sweep. It was also the wrong
 * OUTCOME metric even before the split: mt#4601's planning pass measured the real
 * backlog at 919 turns with nine prior days fully drained, so a low reach rate
 * was real and was not costing the completeness it appeared to. Each sweep now
 * reports how often its OWN ticks finish, which is a question each can answer
 * about itself.
 *
 * Deliberately a rate over LIFETIME ticks rather than a window: a window short
 * enough to be "current" is also short enough to contain zero ticks on a daemon
 * that keeps restarting — which reads as no-opinion exactly when the news is
 * worst. Read it beside the actual backlog, never instead of it.
 */
export function summarizeJournal(journal: TranscriptSweepJournal): SweepJournalSummary {
  const last = journal.recent[journal.recent.length - 1] ?? null;
  const { started, completed } = journal.totals;
  return {
    totals: journal.totals,
    completionRate: started === 0 ? null : Math.round((completed / started) * 1000) / 1000,
    inFlight: journal.inFlight,
    lastOutcome: last === null ? null : last.outcome,
    lastEndedAt: last === null ? null : last.endedAt,
  };
}

/**
 * Memo for the default (file-backed) read path, keyed on the file's identity.
 *
 * `/api/health` is polled by the tray every 5 s and by three webview query keys
 * every 15 s, so this read is on a hot path (PR #3357 R1 non-blocking). A `stat`
 * is materially cheaper than a read plus a `JSON.parse`, and keying on
 * `(mtimeMs, size)` rather than on a TTL means the cache is never stale by
 * construction — including when the writer is ANOTHER daemon, which a TTL would
 * have papered over for its whole window.
 *
 * Deliberately not invalidated by the writer: the recorder and the health route
 * do not share an object, and a signal between them would be a second mechanism
 * to keep correct. The file's own metadata already says everything needed.
 *
 * **Not unit-tested, and deliberately not made testable.** The memo exists only
 * on the default file-backed path, so exercising it needs a real filesystem
 * (`custom/no-real-fs-in-tests`), and the injectable-stat seam that would avoid
 * that is more machinery than the three-line comparison it would cover. It is
 * exercised end-to-end instead: `health-contract.test.ts` boots the real server
 * and fetches `/api/health`, which goes through this path. An explicitly-passed
 * store bypasses the memo entirely, which is what every other test uses.
 */
const cachedFileSummaries = new Map<string, { key: string; summary: SweepJournalSummary }>();

/**
 * Read-and-summarize for the health route. Never throws; degrades to an empty
 * journal.
 *
 * Keyed by PATH (mt#4601) — two sweeps keep two journals, and a single-slot memo
 * would thrash between them on every poll, serving each request the other's
 * freshly-computed miss. An explicitly-passed store bypasses the memo entirely:
 * it is a different source, and caching across stores would make one test's
 * journal visible to the next.
 */
export function readJournalSummary(
  store?: SweepJournalStore,
  filePath: string = getTranscriptSweepJournalPath()
): SweepJournalSummary {
  try {
    if (store !== undefined) return summarizeJournal(store.read());

    let key: string;
    try {
      const st = fs.statSync(filePath);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      // Missing file is the first-boot case; a stat failure means we cannot
      // establish identity, so fall through to an uncached read rather than
      // serving a memo we cannot vouch for.
      key = "";
    }

    const cached = cachedFileSummaries.get(filePath);
    if (key !== "" && cached?.key === key) return cached.summary;

    const summary = summarizeJournal(createFileJournalStore(filePath).read());
    if (key !== "") cachedFileSummaries.set(filePath, { key, summary });
    return summary;
  } catch (err) {
    log.warn("cockpit: transcript sweep journal: summary read failed", {
      filePath,
      message: err instanceof Error ? err.message : String(err),
    });
    return summarizeJournal(emptyJournal());
  }
}
