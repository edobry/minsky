/**
 * Unit tests for the cross-restart transcript-sweep tick journal (mt#4532).
 *
 * The module is split functional-core / imperative-shell precisely so these need
 * no real filesystem and no clock: the folds are pure, and the recorder takes an
 * injectable store plus an injectable `now`/`pid`.
 *
 * The behaviour under test is the one mt#4532 exists to create: a tick whose
 * process is replaced mid-flight must leave a record. Everything else here
 * (totals, the reach rate, the recent ring) is bookkeeping in service of it.
 *
 * @see src/cockpit/transcript-sweep-journal.ts — the unit under test
 * @see src/cockpit/transcript-sweep-backstop.ts — the tick that drives it
 */

import { describe, expect, test } from "bun:test";
import {
  createMemoryJournalStore,
  emptyJournal,
  foldPhase2Started,
  foldReconcile,
  foldTickEnded,
  foldTickStarted,
  isJournalShaped,
  JOURNAL_RECENT_LIMIT,
  summarizeJournal,
  TranscriptSweepJournalRecorder,
  type SweepJournalStore,
  type TranscriptSweepJournal,
} from "./transcript-sweep-journal";

const T0 = "2026-08-25T20:33:05.000Z";
const T1 = "2026-08-25T20:45:05.000Z";
const NEVER_ALIVE = (): boolean => false;
const ALWAYS_ALIVE = (): boolean => true;

/** A journal with one tick in flight, started by `pid`. */
function withInFlight(pid: number, phase: "ingest" | "embed" = "ingest"): TranscriptSweepJournal {
  const started = foldTickStarted(emptyJournal(), T0, pid);
  return phase === "embed" ? foldPhase2Started(started) : started;
}

describe("foldTickStarted", () => {
  test("records the in-flight tick and counts it", () => {
    const j = foldTickStarted(emptyJournal(), T0, 4242);

    expect(j.inFlight).toEqual({ startedAt: T0, pid: 4242, phase: "ingest" });
    expect(j.totals.started).toBe(1);
    expect(j.totals.reachedPhase2).toBe(0);
  });
});

describe("foldPhase2Started", () => {
  test("advances the phase and counts the tick as having reached Phase 2", () => {
    const j = foldPhase2Started(withInFlight(1));

    expect(j.inFlight?.phase).toBe("embed");
    expect(j.totals.reachedPhase2).toBe(1);
  });

  test("is a no-op with no tick in flight, rather than inventing one", () => {
    const j = foldPhase2Started(emptyJournal());

    expect(j).toEqual(emptyJournal());
  });
});

describe("foldTickEnded", () => {
  test("concludes the tick, clears in-flight, and counts the outcome", () => {
    const j = foldTickEnded(withInFlight(7), "aborted", T1);

    expect(j.inFlight).toBeNull();
    expect(j.totals.aborted).toBe(1);
    expect(j.recent).toEqual([
      { startedAt: T0, endedAt: T1, pid: 7, outcome: "aborted", reachedPhase2: false },
    ]);
  });

  test("a tick killed inside Phase 2 still records as having reached it", () => {
    const j = foldTickEnded(withInFlight(7, "embed"), "interrupted", T1);

    expect(j.recent[0]?.reachedPhase2).toBe(true);
    expect(j.totals.reachedPhase2).toBe(1);
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

    expect(interrupted).toEqual({ startedAt: T0, pid: 9, phase: "ingest" });
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
});

describe("summarizeJournal", () => {
  test("reports no rate before any tick has started, rather than a misleading zero", () => {
    expect(summarizeJournal(emptyJournal()).phase2ReachRate).toBeNull();
  });

  test("reports the share of ticks that reached Phase 2", () => {
    // Four ticks, one of which reached the backfill — the shape mt#4532 measured.
    let j = emptyJournal();
    for (let i = 0; i < 3; i++) {
      j = foldTickEnded(foldTickStarted(j, T0, i), "aborted", T1);
    }
    j = foldTickEnded(foldPhase2Started(foldTickStarted(j, T0, 4)), "completed", T1);

    const summary = summarizeJournal(j);
    expect(summary.totals.started).toBe(4);
    expect(summary.totals.reachedPhase2).toBe(1);
    expect(summary.phase2ReachRate).toBe(0.25);
    expect(summary.lastOutcome).toBe("completed");
    expect(summary.lastEndedAt).toBe(T1);
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
});

describe("TranscriptSweepJournalRecorder", () => {
  test("drives a full tick through the store", () => {
    const store = createMemoryJournalStore();
    const recorder = new TranscriptSweepJournalRecorder(store, () => new Date(T0), 555);

    recorder.tickStarted();
    recorder.phase2Started();
    recorder.tickEnded("completed");

    const j = store.read();
    expect(j.inFlight).toBeNull();
    expect(j.totals).toMatchObject({ started: 1, completed: 1, reachedPhase2: 1 });
    expect(j.recent[0]).toMatchObject({ pid: 555, outcome: "completed", reachedPhase2: true });
  });

  test("records an interrupted tick from a previous process at boot", () => {
    // The scenario: pid 100 started a tick and was replaced. pid 200 boots.
    const store = createMemoryJournalStore(withInFlight(100, "embed"));
    const recorder = new TranscriptSweepJournalRecorder(store, () => new Date(T1), 200);

    recorder.reconcileAtBoot(NEVER_ALIVE);

    const j = store.read();
    expect(j.inFlight).toBeNull();
    expect(j.totals.interrupted).toBe(1);
    expect(j.recent[0]).toMatchObject({ pid: 100, outcome: "interrupted", reachedPhase2: true });
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
    const recorder = new TranscriptSweepJournalRecorder(exploding, () => new Date(T0), 1);

    expect(() => recorder.tickStarted()).not.toThrow();
    expect(() => recorder.phase2Started()).not.toThrow();
    expect(() => recorder.tickEnded("completed")).not.toThrow();
    expect(() => recorder.reconcileAtBoot(NEVER_ALIVE)).not.toThrow();
  });
});
