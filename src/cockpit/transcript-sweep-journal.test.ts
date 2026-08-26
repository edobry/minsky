/**
 * Unit tests for the cross-restart sweep tick journal (mt#4532, mt#4601).
 *
 * The module is split functional-core / imperative-shell precisely so these need
 * no real filesystem and no clock: the folds are pure, and the recorder takes an
 * injectable store plus an injectable label/`now`/`pid`.
 *
 * The behaviour under test is the one mt#4532 exists to create: a tick whose
 * process is replaced mid-flight must leave a record. mt#4601 generalised the
 * vocabulary — the journal now serves TWO sweeps (ingest and embedding backfill),
 * so the phase discriminator is gone and the rate is a completion rate.
 *
 * @see src/cockpit/transcript-sweep-journal.ts — the unit under test
 * @see src/cockpit/transcript-sweep-backstop.ts — the ingest sweep that drives it
 * @see src/cockpit/transcript-backfill-sweep.ts — the backfill sweep, same shape
 */

import { describe, expect, test } from "bun:test";
import {
  BACKFILL_SWEEP_LABEL,
  createMemoryJournalStore,
  emptyJournal,
  foldReconcile,
  INGEST_SWEEP_LABEL,
  foldTickEnded,
  foldTickStarted,
  isJournalShaped,
  JOURNAL_RECENT_LIMIT,
  summarizeJournal,
  TranscriptSweepJournalRecorder,
  type InFlightTick,
  type SweepJournalStore,
  type TranscriptSweepJournal,
} from "./transcript-sweep-journal";

const T0 = "2026-08-25T20:33:05.000Z";
const T1 = "2026-08-25T20:45:05.000Z";
const NEVER_ALIVE = (): boolean => false;
const ALWAYS_ALIVE = (): boolean => true;

/** A journal with one tick in flight, started by `pid`. */
function withInFlight(pid: number): TranscriptSweepJournal {
  return foldTickStarted(emptyJournal(), T0, pid);
}

describe("foldTickStarted", () => {
  test("records the in-flight tick and counts it", () => {
    const j = foldTickStarted(emptyJournal(), T0, 4242);

    expect(j.inFlight).toEqual({ startedAt: T0, pid: 4242 });
    expect(j.totals.started).toBe(1);
    expect(j.totals.completed).toBe(0);
  });
});

describe("foldTickEnded", () => {
  test("concludes the tick, clears in-flight, and counts the outcome", () => {
    const j = foldTickEnded(withInFlight(7), "aborted", T1);

    expect(j.inFlight).toBeNull();
    expect(j.totals.aborted).toBe(1);
    expect(j.recent).toEqual([{ startedAt: T0, endedAt: T1, pid: 7, outcome: "aborted" }]);
  });

  test("drops a terminal record with nothing in flight rather than fabricating a start time", () => {
    const j = foldTickEnded(emptyJournal(), "completed", T1);

    expect(j.recent).toEqual([]);
    expect(j.totals.completed).toBe(0);
  });

  test("bounds the recent list while leaving the cumulative totals untruncated", () => {
    let j = emptyJournal();
    const overshoot = JOURNAL_RECENT_LIMIT + 5;
    for (let i = 0; i < overshoot; i++) {
      j = foldTickEnded(foldTickStarted(j, T0, i), "completed", T1);
    }

    expect(j.recent).toHaveLength(JOURNAL_RECENT_LIMIT);
    expect(j.totals.completed).toBe(overshoot);
    // The ring keeps the NEWEST, so the oldest pid is gone and the newest is last.
    expect(j.recent[j.recent.length - 1]?.pid).toBe(overshoot - 1);
  });
});

describe("foldReconcile", () => {
  test("folds a tick whose process is gone as INTERRUPTED", () => {
    const { journal, interrupted } = foldReconcile(withInFlight(9), NEVER_ALIVE, T1);

    expect(interrupted).toEqual({ startedAt: T0, pid: 9 });
    expect(journal.inFlight).toBeNull();
    expect(journal.totals.interrupted).toBe(1);
    expect(journal.recent[0]?.outcome).toBe("interrupted");
  });

  test("leaves a LIVE foreign process's tick alone — it is owned, not orphaned", () => {
    const before = withInFlight(9);
    const { journal, interrupted } = foldReconcile(before, ALWAYS_ALIVE, T1);

    expect(interrupted).toBeNull();
    expect(journal).toEqual(before);
  });

  test("is a no-op when nothing was in flight", () => {
    const { journal, interrupted } = foldReconcile(emptyJournal(), NEVER_ALIVE, T1);

    expect(interrupted).toBeNull();
    expect(journal).toEqual(emptyJournal());
  });

  // PR #3357 R1: two fresh daemons can both run reconcile against the same
  // orphan. Whole-file atomic writes already make the reviewer's stated
  // arithmetic impossible, but the fold is made idempotent per orphan so a
  // single real event cannot be counted twice under ANY write order.
  test("never folds the same orphan twice, whatever the interleaving", () => {
    const orphan = withInFlight(9);
    const first = foldReconcile(orphan, NEVER_ALIVE, T1);
    expect(first.journal.totals.interrupted).toBe(1);

    // Daemon B read the PRE-image (its `inFlight` still set) but writes into a
    // journal where A's fold already landed.
    const raced: TranscriptSweepJournal = { ...first.journal, inFlight: orphan.inFlight };
    const second = foldReconcile(raced, NEVER_ALIVE, "2026-08-25T20:46:05.000Z");

    expect(second.interrupted).toBeNull();
    expect(second.journal.totals.interrupted).toBe(1);
    expect(second.journal.recent).toHaveLength(1);
    // The stale pointer is still cleared — otherwise it would be re-examined forever.
    expect(second.journal.inFlight).toBeNull();
  });

  test("a DIFFERENT orphan from the same pid is still folded", () => {
    // Identity is (startedAt, pid), not pid alone — a pid is reused across boots
    // on a long-lived machine, and collapsing on it would silently drop events.
    const first = foldReconcile(withInFlight(9), NEVER_ALIVE, T1);
    const laterTick: InFlightTick = { startedAt: "2026-08-25T21:33:05.000Z", pid: 9 };
    const raced: TranscriptSweepJournal = { ...first.journal, inFlight: laterTick };

    const second = foldReconcile(raced, NEVER_ALIVE, "2026-08-25T21:46:05.000Z");

    expect(second.interrupted).toEqual(laterTick);
    expect(second.journal.totals.interrupted).toBe(2);
  });
});

describe("summarizeJournal", () => {
  test("reports no rate before any tick has started, rather than a misleading zero", () => {
    expect(summarizeJournal(emptyJournal()).completionRate).toBeNull();
  });

  test("reports the share of ticks that completed", () => {
    // Four ticks, one of which finished — the shape mt#4532 measured live
    // (0 of 4 reached the backfill at all before the mt#4601 split).
    let j = emptyJournal();
    for (let i = 0; i < 3; i++) {
      j = foldTickEnded(foldTickStarted(j, T0, i), "aborted", T1);
    }
    j = foldTickEnded(foldTickStarted(j, T0, 4), "completed", T1);

    const summary = summarizeJournal(j);
    expect(summary.totals.started).toBe(4);
    expect(summary.totals.completed).toBe(1);
    expect(summary.completionRate).toBe(0.25);
    expect(summary.lastOutcome).toBe("completed");
    expect(summary.lastEndedAt).toBe(T1);
  });

  test("an all-interrupted journal reports a zero rate, not a null one", () => {
    // The distinction the health surface depends on: null means "nothing has run
    // yet", 0 means "things ran and none finished". Conflating them would make a
    // fully-starved sweep read as an idle one.
    const j = foldReconcile(withInFlight(9), NEVER_ALIVE, T1).journal;

    expect(summarizeJournal(j).completionRate).toBe(0);
  });
});

describe("isJournalShaped", () => {
  test("accepts a well-formed journal", () => {
    expect(isJournalShaped(emptyJournal())).toBe(true);
  });

  test.each([
    ["a non-object", 42],
    ["null", null],
    ["an object with no totals", { inFlight: null, recent: [] }],
    ["totals missing a counter", { inFlight: null, recent: [], totals: { started: 1 } }],
    [
      "a non-numeric counter",
      { inFlight: null, recent: [], totals: { ...emptyJournal().totals, started: "1" } },
    ],
    ["recent not an array", { inFlight: null, recent: {}, totals: emptyJournal().totals }],
  ])("rejects %s", (_label, value) => {
    expect(isJournalShaped(value)).toBe(false);
  });

  test("rejects mt#4532's pre-split shape, so a stale file is discarded not merged", () => {
    // The shipped journal carried `reachedPhase2` and `embedFailed`. mt#4601
    // removed both. A file written by the old build is missing the new totals
    // key set only if a key was ADDED — none was — so this asserts the guard's
    // actual behaviour rather than a hoped-for one: the old shape still passes,
    // and the extra keys are inert. Recorded because it is the surprising answer.
    const preSplit = {
      inFlight: null,
      recent: [],
      totals: { ...emptyJournal().totals, reachedPhase2: 3, embedFailed: 1 },
    };

    expect(isJournalShaped(preSplit)).toBe(true);
  });
});

describe("TranscriptSweepJournalRecorder", () => {
  test("drives a full tick through the store", () => {
    const store = createMemoryJournalStore();
    const recorder = new TranscriptSweepJournalRecorder(
      store,
      INGEST_SWEEP_LABEL,
      () => new Date(T0),
      555
    );

    recorder.tickStarted();
    recorder.tickEnded("completed");

    const j = store.read();
    expect(j.inFlight).toBeNull();
    expect(j.totals).toMatchObject({ started: 1, completed: 1 });
    expect(j.recent[0]).toMatchObject({ pid: 555, outcome: "completed" });
  });

  test("records an interrupted tick from a previous process at boot", () => {
    // The scenario: pid 100 started a tick and was replaced. pid 200 boots.
    const store = createMemoryJournalStore(withInFlight(100));
    const recorder = new TranscriptSweepJournalRecorder(
      store,
      BACKFILL_SWEEP_LABEL,
      () => new Date(T1),
      200
    );

    recorder.reconcileAtBoot(NEVER_ALIVE);

    const j = store.read();
    expect(j.inFlight).toBeNull();
    expect(j.totals.interrupted).toBe(1);
    expect(j.recent[0]).toMatchObject({ pid: 100, outcome: "interrupted" });
  });

  test("a store that throws never propagates — the journal must not break the sweep", () => {
    const exploding: SweepJournalStore = {
      read: () => {
        throw new Error("state dir is read-only");
      },
      write: () => {
        throw new Error("state dir is read-only");
      },
    };
    const recorder = new TranscriptSweepJournalRecorder(
      exploding,
      INGEST_SWEEP_LABEL,
      () => new Date(T0),
      1
    );

    expect(() => recorder.tickStarted()).not.toThrow();
    expect(() => recorder.tickEnded("completed")).not.toThrow();
    expect(() => recorder.reconcileAtBoot(NEVER_ALIVE)).not.toThrow();
  });

  test("two recorders over two stores keep independent journals", () => {
    // mt#4601's whole storage decision in one assertion: the ingest sweep and
    // the backfill get separate files, so one sweep's starvation cannot be read
    // off the other's counters.
    const ingestStore = createMemoryJournalStore();
    const backfillStore = createMemoryJournalStore();
    const ingest = new TranscriptSweepJournalRecorder(
      ingestStore,
      INGEST_SWEEP_LABEL,
      () => new Date(T0),
      1
    );
    const backfill = new TranscriptSweepJournalRecorder(
      backfillStore,
      BACKFILL_SWEEP_LABEL,
      () => new Date(T0),
      1
    );

    ingest.tickStarted();
    ingest.tickEnded("aborted");
    backfill.tickStarted();
    backfill.tickEnded("completed");

    expect(summarizeJournal(ingestStore.read()).completionRate).toBe(0);
    expect(summarizeJournal(backfillStore.read()).completionRate).toBe(1);
  });
});
