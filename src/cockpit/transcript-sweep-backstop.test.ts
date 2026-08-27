/**
 * Unit tests for the transcript sweep backstop core (mt#2321).
 *
 * Tests the sweep logic via injected deps (no real DB, no real filesystem, no
 * real embedding provider). The sweeper convention is:
 *   - tick calls ingestAll, then embeddings
 *   - overlapping ticks are skipped via the `running` flag
 *   - ingest failure: logs + records error, does NOT throw
 *   - embed failure: logs + records error, does NOT throw, does NOT prevent
 *     the ingest counters from being recorded (fail-open)
 *   - idempotency is delegated to ingestAll (HWM-gated) — just assert it's called
 *
 * @see src/cockpit/transcript-sweep-backstop.ts — the unit under test
 *   (mt#2615 moved it out of server.ts into sweepers.ts; mt#4480 moved it again,
 *   into the module this test file was already named after)
 * @see src/cockpit/transcript-sweep-tracker.ts — TranscriptSweepTracker
 * @see mt#2321 — cockpit-daemon transcript sweep backstop
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// mt#4489: scanning the real source tree IS the contract here (same rationale as
// epoch-cache-coverage.test.ts). Scoped to this import and the single read below
// rather than the whole file, because every other test here uses injected deps and
// should stay covered by the rule.
// eslint-disable-next-line custom/no-real-fs-in-tests
import * as fs from "fs";
import * as path from "path";
import { resolveSweepIntervalMs, startTranscriptSweepBackstop } from "./transcript-sweep-backstop";
import { deriveEmbedOverdueBoundMs, TranscriptSweepTracker } from "./transcript-sweep-tracker";
import type { TranscriptSweepDeps } from "./transcript-sweep-backstop";
import {
  createMemoryJournalStore,
  emptyJournal,
  foldTickStarted,
  INGEST_SWEEP_LABEL,
  summarizeJournal,
  TranscriptSweepJournalRecorder,
  type SweepJournalStore,
} from "./transcript-sweep-journal";

// Helper: wait for an async condition to become true (polls at 5ms intervals).
// The bound was 500ms and measured the MACHINE, not the code: every condition
// polled here completes in single-digit ms (the tests are dependency-injected,
// with no real I/O), so under contention the deadline expired 2-7ms short and
// the gate rejected commits that had nothing to do with this file. Raising it
// costs nothing on the pass path — waitFor returns as soon as the condition
// holds, so a larger bound only lengthens the FAILURE path (measured: the
// 40-file related-test selection ran 28.17s passing vs 28.3s failing).
//
// mt#3501 sub-shape A owns the class; this is its fix for this file, with the
// negative control that task's SC1 requires: the failure reproduced 3/3 on the
// unmodified tree, including once with all other changes stashed. Landed here
// because it was blocking mt#4159's commit and the gate has no override for a
// failing (as opposed to timing-out) related test — see scripts/run-related-tests.ts:232.
/**
 * A throwaway journal recorder backed by memory (mt#4532).
 *
 * `startTranscriptSweepBackstop` takes its recorder as a REQUIRED parameter
 * (ADR-026 rule 3 — no `?? createRealOne()` fallback), so every test supplies
 * one. Most tests here are not about the journal and just need it not to touch
 * the real state dir; the tests that ARE about it keep a handle on the store.
 */
function memoryJournal(): TranscriptSweepJournalRecorder {
  return new TranscriptSweepJournalRecorder(createMemoryJournalStore());
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is used for timing, not path creation; the rule's regex fires on the call pattern but there is no filesystem interaction here
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path creation
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startTranscriptSweepBackstop (mt#2321)", () => {
  let tracker: TranscriptSweepTracker;

  beforeEach(() => {
    tracker = TranscriptSweepTracker.resetForTest();
  });

  afterEach(() => {
    // Reset singleton after each test.
    TranscriptSweepTracker.resetForTest();
  });

  // ── happy path ─────────────────────────────────────────────────────────────

  test("tick calls ingestAll then embeddings and records observability", async () => {
    const ingestCalls: number[] = [];
    const embedCalls: number[] = [];

    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        ingestCalls.push(Date.now());
        return { sessionsProcessed: 5, sessionsErrored: 0 };
      },
      runEmbeddings: async () => {
        embedCalls.push(Date.now());
      },
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), {
      intervalMs: 60_000, // Don't tick again during the test.
      deps,
    });

    try {
      // Boot pass fires immediately (void tick()).
      await waitFor(() => tracker.getSummary().sweepsRun >= 1);

      expect(ingestCalls).toHaveLength(1);
      // mt#4601: this sweep no longer embeds. The backfill's own tests live in
      // `transcript-backfill-sweep.test.ts`.
      expect(embedCalls).toHaveLength(0);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.sessionsIngested).toBe(5);
      expect(summary.sessionsErrored).toBe(0);
      expect(summary.embedRuns).toBe(0);
      expect(summary.lastSweepAt).not.toBeNull();
      expect(summary.lastErrorAt).toBeNull();
    } finally {
      stop();
    }
  });

  // mt#4524's two backfill assertions — the in-flight reporting and the failure
  // conclusion — MOVED to `transcript-backfill-sweep.test.ts` with mt#4601, along
  // with the behaviour they cover. They are not deleted: the same properties are
  // asserted against the sweep that now owns the backfill, plus two the split
  // creates (it runs with no ingest involved; its failure no longer stamps this
  // sweep's `lastErrorAt`).

  test("ingest is called on each tick (idempotency delegated to ingestAll)", async () => {
    // Assert: ingest runner is called at least twice when the interval fires.
    let ingestCount = 0;

    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        ingestCount++;
        return { sessionsProcessed: 1, sessionsErrored: 0 };
      },
      runEmbeddings: async () => {},
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 20, deps });

    try {
      await waitFor(() => ingestCount >= 2, 2000);
      expect(ingestCount).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  // ── overlapping-tick guard ─────────────────────────────────────────────────

  test("overlapping ticks are skipped (running flag)", async () => {
    let ingestCount = 0;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        ingestCount++;
        // Block indefinitely until gate resolves — simulates a slow tick.
        await gate;
        return { sessionsProcessed: 1, sessionsErrored: 0 };
      },
      runEmbeddings: async () => {},
      tracker,
    };

    // Interval of 1ms so a second tick fires immediately.
    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 1, deps });

    try {
      // Wait until at least one ingest call is in flight.
      await waitFor(() => ingestCount >= 1, 500);

      // Give the interval enough time to fire several more ticks while the
      // first is still blocked. Ingest count must remain 1.
      await new Promise((r) => setTimeout(r, 50));
      expect(ingestCount).toBe(1);
    } finally {
      resolveGate(); // Unblock so cleanup doesn't hang.
      stop();
    }
  });

  // ── fail-open: ingest error ────────────────────────────────────────────────

  test("ingest error: records observability and does not throw", async () => {
    let embedCalled = false;

    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        throw new Error("DB gone");
      },
      runEmbeddings: async () => {
        embedCalled = true;
      },
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 60_000, deps });

    try {
      // Wait for the tick to finish (sweepsRun stays 0 when ingest throws —
      // we abort before recording a completed sweep).
      await waitFor(() => tracker.getSummary().lastErrorAt !== null, 500);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(0); // Ingest threw → no completed sweep.
      expect(summary.lastErrorAt).not.toBeNull();
      // Embeddings are NOT called when ingest throws (abort before phase 2).
      expect(embedCalled).toBe(false);
    } finally {
      stop();
    }
  });

  // ── fail-open: embed error ─────────────────────────────────────────────────

  test("embed error: records observability but does NOT prevent ingest counters from being recorded", async () => {
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({ sessionsProcessed: 3, sessionsErrored: 1 }),
      runEmbeddings: async () => {
        throw new Error("embedding provider unavailable");
      },
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 60_000, deps });

    try {
      // Ingest succeeds → recordSweepCompleted fires → sweepsRun becomes 1.
      await waitFor(() => tracker.getSummary().sweepsRun >= 1, 500);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.sessionsIngested).toBe(3);
      expect(summary.sessionsErrored).toBe(1);
      // Embed failed → embedRuns stays 0.
      expect(summary.embedRuns).toBe(0);
      // Error recorded from the embedding failure.
      expect(summary.lastErrorAt).not.toBeNull();
    } finally {
      stop();
    }
  });

  // ── per-session ingest errors are counted but sweep still completes ────────

  test("per-session ingest errors increment sessionsErrored without failing the sweep", async () => {
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({ sessionsProcessed: 10, sessionsErrored: 3 }),
      runEmbeddings: async () => {},
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 60_000, deps });

    try {
      await waitFor(() => tracker.getSummary().sweepsRun >= 1, 500);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.sessionsIngested).toBe(10);
      expect(summary.sessionsErrored).toBe(3);
      // lastErrorAt is set when sessionsErrored > 0.
      expect(summary.lastErrorAt).not.toBeNull();
      // mt#4601: embedding is a separate sweep now, so this tick does not run it.
      expect(summary.embedRuns).toBe(0);
    } finally {
      stop();
    }
  });

  // ── mt#4480: an abandoned pass is not a sweep ──────────────────────────────

  test("an aborted ingest is recorded as an abort, never as a completed sweep", async () => {
    // The whole point. In production, five passes in a row returned
    // `sessionsProcessed: 1502, sessionsErrored: 1502, totalIngested: 0` after
    // the pool was recycled under them — and each one incremented `sweepsRun`
    // and added 1,502 to `sessionsIngested`, so the health surface read like a
    // busy, healthy sweep while nothing at all was being ingested.
    let embedRan = false;
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({
        sessionsProcessed: 12,
        sessionsErrored: 12,
        totalIngested: 0,
        aborted: {
          afterSessionsProcessed: 12,
          consecutiveInfraFailures: 10,
          failureKind: "connection-lost",
        },
      }),
      runEmbeddings: async () => {
        embedRan = true;
      },
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 60_000, deps });

    try {
      // Default 5 s deadline, not the 500 ms its neighbours pass: mt#3501
      // records that five tests in this file poll ms-scale conditions against
      // a 500 ms wall-clock deadline and fail under load. No reason to enlarge
      // that population while it is still open.
      await waitFor(() => tracker.getSummary().sweepsAborted >= 1);

      const summary = tracker.getSummary();
      expect(summary.sweepsAborted).toBe(1);
      expect(summary.lastAbortAt).not.toBeNull();
      // Not counted as a sweep, and its sessions are not counted as swept.
      expect(summary.sweepsRun).toBe(0);
      expect(summary.sessionsIngested).toBe(0);
      expect(summary.lastSweepAt).toBeNull();
      // An abandoned pass IS a sweep-level error.
      expect(summary.lastErrorAt).not.toBeNull();
      // Phase 2 needs the same dead connection, so it must not have been tried.
      expect(embedRan).toBe(false);
      expect(summary.embedRuns).toBe(0);
    } finally {
      stop();
    }
  });

  test("lastProductiveSweepAt advances only when the sweep actually ingested something", async () => {
    // `lastSweepAt` says the mechanism RAN; this says it did its job. The gap
    // between them is the freshness signal — a sweep that runs every 30
    // minutes and ingests nothing looks identical to a healthy one on every
    // other field here.
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({
        sessionsProcessed: 5,
        sessionsErrored: 0,
        totalIngested: 0,
      }),
      runEmbeddings: async () => {},
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 60_000, deps });
    try {
      // Default deadline — see the mt#3501 note on the sibling test above.
      await waitFor(() => tracker.getSummary().sweepsRun >= 1);
      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.lastSweepAt).not.toBeNull();
      expect(summary.lastProductiveSweepAt).toBeNull();
    } finally {
      stop();
    }

    tracker.recordSweepCompleted(5, 0, 0, 3);
    expect(tracker.getSummary().lastProductiveSweepAt).not.toBeNull();
  });

  // ── stop function ─────────────────────────────────────────────────────────

  test("stop() clears the interval (no further ticks after stop)", async () => {
    let ingestCount = 0;

    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        ingestCount++;
        return { sessionsProcessed: 1, sessionsErrored: 0 };
      },
      runEmbeddings: async () => {},
      tracker,
    };

    const stop = startTranscriptSweepBackstop(memoryJournal(), { intervalMs: 10, deps });

    // Wait for the boot pass to complete.
    await waitFor(() => ingestCount >= 1, 500);
    const countAtStop = ingestCount;
    stop();

    // Wait a bit and confirm ingest count didn't grow further.
    await new Promise((r) => setTimeout(r, 100));
    // Allow at most one extra tick that was in-flight when stop() fired.
    expect(ingestCount).toBeLessThanOrEqual(countAtStop + 1);
  });
});

// ── mt#4489: dependencies must resolve at LOAD, not at first tick ────────────

describe("transcript-sweep-backstop module resolution (mt#4489)", () => {
  // Why this is a SOURCE assertion rather than a behavioural one, stated plainly
  // so the next reader can judge it: the defect is that a bare `@minsky/*`
  // specifier resolves against a module tree that may be DELETED by the time a
  // deferred import runs. Reproducing that behaviourally means starting a daemon
  // from a throwaway repo tree and deleting it mid-flight — real, but far too
  // heavy for a unit test. What this asserts instead is the invariant that makes
  // the failure impossible: nothing in this module defers a bare-specifier
  // import past load.
  //
  // What it does NOT prove: that the module actually loads, or that the sweep
  // works. Those are covered by the injected-deps tests below and by the live
  // verification in the PR body. It proves only that the regression cannot
  // silently return — which is exactly what a grep-shaped invariant is good for,
  // and it fails against the pre-fix file.
  //
  // THIS IS A STOPGAP, and it is bounded (PR #3296 R1, non-blocking). A
  // lint rule is the right tier for a source-shaped invariant, and the reason
  // there isn't one is mt#4523: `.minsky/rules/no-dynamic-imports.mdc` claims
  // `eslint.config.js` enforces this mechanically, and it does not — that option
  // belongs to the test-scoped `custom/no-real-fs-in-tests`, and no
  // `no-dynamic-imports` rule exists in `eslint-rules/`. **Delete this describe
  // block when mt#4523 ships a real rule covering this file.** Escalation
  // threshold: if a second module needs the same hand-written guard before
  // mt#4523 lands, that is the signal the rule is overdue — raise it rather than
  // copying this block a third time.
  // Buffer + `toString()` rather than an encoding argument: this checker
  // resolves `readFileSync`'s encoding overload to `string | Buffer`, so
  // `.match` below would not typecheck, and its `Buffer.toString` accepts no
  // arguments. The default decoding is utf8, which is what this file is.
  const SELF = path.join(import.meta.dir, "transcript-sweep-backstop.ts");
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see the import above
  const SOURCE = fs.readFileSync(SELF).toString();

  test("no bare-specifier dynamic imports remain in this module", () => {
    // Matches `await import("@minsky/...")` across line breaks, which is how
    // the five removed calls were formatted after prettier wrapped them.
    const deferredBareImports = SOURCE.match(/await\s+import\(\s*["']@minsky\//g) ?? [];
    expect(deferredBareImports).toEqual([]);
  });

  test("the modules the sweep needs are imported statically", () => {
    for (const specifier of [
      "@minsky/domain/transcripts/claude-code-transcript-source",
      "@minsky/domain/transcripts/agent-transcript-ingest-service",
      "@minsky/domain/ai/embedding-service-factory",
      "@minsky/domain/transcripts/per-turn-embedding-pipeline",
    ]) {
      // A top-level `import ... from "<specifier>"`, not an `await import(...)`.
      expect(SOURCE).toContain(`from "${specifier}"`);
    }
  });
});

// ── TranscriptSweepTracker unit tests ────────────────────────────────────────

describe("TranscriptSweepTracker (mt#2321)", () => {
  let tracker: TranscriptSweepTracker;

  beforeEach(() => {
    tracker = TranscriptSweepTracker.resetForTest();
  });

  afterEach(() => {
    TranscriptSweepTracker.resetForTest();
  });

  test("initial state: zero counters and null timestamps", () => {
    const s = tracker.getSummary();
    expect(s.sweepsRun).toBe(0);
    expect(s.sessionsIngested).toBe(0);
    expect(s.sessionsErrored).toBe(0);
    expect(s.embedRuns).toBe(0);
    expect(s.lastSweepAt).toBeNull();
    expect(s.lastErrorAt).toBeNull();
  });

  test("recordSweepCompleted accumulates counters and sets lastSweepAt", () => {
    tracker.recordSweepCompleted(10, 2);
    tracker.recordSweepCompleted(5, 0);

    const s = tracker.getSummary();
    expect(s.sweepsRun).toBe(2);
    expect(s.sessionsIngested).toBe(15);
    expect(s.sessionsErrored).toBe(2);
    expect(s.lastSweepAt).not.toBeNull();
  });

  test("recordSweepCompleted with errors also sets lastErrorAt", () => {
    tracker.recordSweepCompleted(5, 1);
    const s = tracker.getSummary();
    expect(s.lastErrorAt).not.toBeNull();
  });

  test("recordSweepCompleted with zero errors does NOT set lastErrorAt", () => {
    tracker.recordSweepCompleted(5, 0);
    const s = tracker.getSummary();
    expect(s.lastErrorAt).toBeNull();
  });

  test("recordEmbedRunCompleted increments embedRuns", () => {
    tracker.recordEmbedRunCompleted();
    tracker.recordEmbedRunCompleted();
    expect(tracker.getSummary().embedRuns).toBe(2);
  });

  // mt#4489 — the whole value of this field is that it SEPARATES two states the
  // raw counters render identically, so the three cases are asserted together.
  // A test that only checked the true case would pass against a hardcoded
  // `embedNeverSucceeded: true`.
  test("embedNeverSucceeded is false before any sweep has run", () => {
    // embedRuns is 0 here, but nothing is owed yet — the daemon has not swept.
    // This is the case that made a bare `embedRuns: 0` unreadable.
    expect(tracker.getSummary().embedNeverSucceeded).toBe(false);
  });

  // mt#4524 — these two cases previously asserted `embedNeverSucceeded: true`
  // after nothing more than `recordSweepCompleted`. That WAS the defect: the old
  // `sweepsRun > 0 && embedRuns === 0` derivation fires the moment Phase 1 ends,
  // for the whole duration of a Phase 2 that is working correctly. The tests
  // encoded the bug as the invariant, which is why every gate stayed green.
  test("a completed sweep alone does NOT make embedNeverSucceeded true (mt#4524)", () => {
    tracker.recordSweepCompleted(5, 0);
    const s = tracker.getSummary();
    expect(s.sweepsRun).toBe(1);
    expect(s.embedRuns).toBe(0);
    // Nothing has been ATTEMPTED yet, so nothing has failed.
    expect(s.embedNeverSucceeded).toBe(false);
    expect(s.embedPhase).toBe("never-attempted");
  });

  test("embedNeverSucceeded goes false as soon as one embed run succeeds", () => {
    tracker.recordSweepCompleted(5, 0);
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunFailed();
    expect(tracker.getSummary().embedNeverSucceeded).toBe(true);
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunCompleted();
    expect(tracker.getSummary().embedNeverSucceeded).toBe(false);
  });

  // ── mt#4524: the four phase states, plus the overdue condition ─────────────
  // SC1/SC4. Asserted together rather than one per case: the field's whole
  // purpose is to SEPARATE states the raw counters render identically, so a
  // suite that checked one state in isolation would pass against a constant.

  test("embedPhase is never-attempted before any attempt starts", () => {
    const s = tracker.getSummary();
    expect(s.embedPhase).toBe("never-attempted");
    expect(s.embedInFlightAgeMs).toBeNull();
    expect(s.lastEmbedAttemptAt).toBeNull();
    expect(s.embedNeverSucceeded).toBe(false);
  });

  test("embedPhase is in-flight while an attempt runs, and reports its age", () => {
    const t0 = 1_000_000;
    tracker.recordSweepCompleted(1494, 0);
    tracker.recordEmbedRunStarted(t0);

    const s = tracker.getSummary(t0 + 90_000);
    expect(s.embedPhase).toBe("in-flight");
    expect(s.embedInFlightAgeMs).toBe(90_000);
    expect(s.lastEmbedAttemptAt).not.toBeNull();
    // The defect window, now correct: an attempt in flight is not a failure.
    expect(s.embedNeverSucceeded).toBe(false);
    expect(s.embedRuns).toBe(0);
    expect(s.embedFailures).toBe(0);
  });

  test("embedPhase becomes in-flight-overdue past the bound, and not before", () => {
    const t0 = 1_000_000;
    tracker.setEmbedOverdueBoundMs(60_000);
    tracker.recordEmbedRunStarted(t0);

    // Exactly at the bound is still in-flight — the comparison is strict.
    expect(tracker.getSummary(t0 + 60_000).embedPhase).toBe("in-flight");
    expect(tracker.getSummary(t0 + 60_001).embedPhase).toBe("in-flight-overdue");
    // Overdue is its OWN state: it must not be folded into never-succeeded,
    // because a hang concludes nothing (mem#862).
    expect(tracker.getSummary(t0 + 600_000).embedNeverSucceeded).toBe(false);
  });

  test("embedPhase is succeeded after a concluded successful attempt", () => {
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunCompleted();

    const s = tracker.getSummary();
    expect(s.embedPhase).toBe("succeeded");
    expect(s.embedInFlightAgeMs).toBeNull();
    expect(s.embedRuns).toBe(1);
    expect(s.embedNeverSucceeded).toBe(false);
  });

  test("embedPhase is failed, and embedNeverSucceeded true, after a concluded failure", () => {
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunFailed();

    const s = tracker.getSummary();
    expect(s.embedPhase).toBe("failed");
    expect(s.embedInFlightAgeMs).toBeNull();
    expect(s.embedFailures).toBe(1);
    expect(s.embedRuns).toBe(0);
    expect(s.embedNeverSucceeded).toBe(true);
  });

  // SC4 names the in-flight→concluded transition in BOTH directions explicitly.
  test("the in-flight→concluded transition is observable in both directions", () => {
    const t0 = 2_000_000;

    tracker.recordEmbedRunStarted(t0);
    expect(tracker.getSummary(t0 + 1_000).embedPhase).toBe("in-flight");
    tracker.recordEmbedRunCompleted();
    expect(tracker.getSummary(t0 + 2_000).embedPhase).toBe("succeeded");

    tracker.recordEmbedRunStarted(t0 + 3_000);
    expect(tracker.getSummary(t0 + 4_000).embedPhase).toBe("in-flight");
    tracker.recordEmbedRunFailed();
    expect(tracker.getSummary(t0 + 5_000).embedPhase).toBe("failed");
  });

  test("embedPhase reports the LAST outcome, not whichever counter is non-zero", () => {
    // Once a process has one of each, `embedRuns > 0` and `embedFailures > 0`
    // are both true and cannot order themselves — which is why the tracker
    // stores the last outcome rather than inferring it.
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunCompleted();
    tracker.recordEmbedRunStarted();
    tracker.recordEmbedRunFailed();

    const s = tracker.getSummary();
    expect(s.embedRuns).toBe(1);
    expect(s.embedFailures).toBe(1);
    expect(s.embedPhase).toBe("failed");
    // A backfill HAS succeeded in this process, so this stays false even though
    // the most recent attempt failed.
    expect(s.embedNeverSucceeded).toBe(false);
  });

  test("setEmbedOverdueBoundMs ignores non-positive and non-finite values", () => {
    const before = tracker.getSummary().embedOverdueBoundMs;
    tracker.setEmbedOverdueBoundMs(0);
    tracker.setEmbedOverdueBoundMs(-1);
    tracker.setEmbedOverdueBoundMs(Number.NaN);
    // A zero bound would report every attempt overdue the instant it started.
    expect(tracker.getSummary().embedOverdueBoundMs).toBe(before);
  });

  test("deriveEmbedOverdueBoundMs takes the sweep interval, capped by the tick timeout", () => {
    // The interval is the operationally meaningful line (ticks start being
    // skipped past it); the tick timeout caps it so the bound is never dead code.
    expect(deriveEmbedOverdueBoundMs(30 * 60 * 1000, 60 * 60 * 1000)).toBe(30 * 60 * 1000);
    expect(deriveEmbedOverdueBoundMs(2 * 60 * 60 * 1000, 60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });

  test("recordSweepError sets lastErrorAt without changing sweep counters", () => {
    tracker.recordSweepError();
    const s = tracker.getSummary();
    expect(s.sweepsRun).toBe(0);
    expect(s.sessionsIngested).toBe(0);
    expect(s.lastErrorAt).not.toBeNull();
  });

  test("getSummary returns ISO timestamp strings for non-null timestamps", () => {
    tracker.recordSweepCompleted(1, 0);
    const s = tracker.getSummary();
    // lastSweepAt must be a parseable ISO string.
    // Use nullish coalesce to avoid non-null assertion (no-non-null-assertion).
    expect(() => new Date(s.lastSweepAt ?? "").toISOString()).not.toThrow();
    expect(s.lastSweepAt).not.toBeNull();
  });

  test("negative input values are floored to 0", () => {
    tracker.recordSweepCompleted(-1, -5);
    const s = tracker.getSummary();
    expect(s.sessionsIngested).toBe(0);
    expect(s.sessionsErrored).toBe(0);
  });

  test("resetForTest returns a fresh tracker independent of the singleton", () => {
    const t1 = TranscriptSweepTracker.resetForTest();
    t1.recordSweepCompleted(3, 0);
    expect(t1.getSummary().sweepsRun).toBe(1);

    const t2 = TranscriptSweepTracker.resetForTest();
    expect(t2.getSummary().sweepsRun).toBe(0);
  });
});

describe("resolveSweepIntervalMs (SC1 — externally configurable cadence)", () => {
  // Use a variable key so the static no-unregistered-minsky-env-var lint rule
  // (which matches literal process.env.MINSKY_* access) does not fire in tests.
  const ENV = "MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS";
  const DEFAULT_MS = 30 * 60 * 1000;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  test("defaults to 30 minutes when the env override is unset", () => {
    expect(resolveSweepIntervalMs()).toBe(DEFAULT_MS);
  });

  test("uses a valid positive-integer env override", () => {
    process.env[ENV] = "60000";
    expect(resolveSweepIntervalMs()).toBe(60000);
  });

  test("falls back to the default on invalid env values", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      process.env[ENV] = bad;
      expect(resolveSweepIntervalMs()).toBe(DEFAULT_MS);
    }
  });
});

// ── mt#4532: the tick's outcome reaches the cross-restart journal ────────────
//
// The journal's own folds are unit-tested in transcript-sweep-journal.test.ts.
// What is tested HERE is the WIRING: that each of the tick's exit paths reports
// the outcome it actually took. That distinction matters — the journal is the
// only surface that survives a restart, so a tick whose exit path forgets to
// call it is indistinguishable from a tick that was never scheduled, which is
// the exact ambiguity mt#4532 exists to remove.

describe("transcript sweep journal wiring (mt#4532)", () => {
  let tracker: TranscriptSweepTracker;

  beforeEach(() => {
    tracker = TranscriptSweepTracker.resetForTest();
  });

  afterEach(() => {
    TranscriptSweepTracker.resetForTest();
  });

  /** Start the sweep against an injected journal store, and hand both back. */
  function startWithJournal(deps: TranscriptSweepDeps): {
    store: SweepJournalStore;
    stop: () => void;
  } {
    const store = createMemoryJournalStore();
    const stop = startTranscriptSweepBackstop(
      new TranscriptSweepJournalRecorder(store, INGEST_SWEEP_LABEL),
      { intervalMs: 60_000, deps }
    );
    return { store, stop };
  }

  test("a tick that completes both phases is recorded as completed, having reached Phase 2", async () => {
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({ sessionsProcessed: 3, sessionsErrored: 0, totalIngested: 3 }),
      runEmbeddings: async () => {},
      tracker,
    };
    const { store, stop } = startWithJournal(deps);

    try {
      await waitFor(() => store.read().totals.completed >= 1);

      const j = store.read();
      expect(j.inFlight).toBeNull();
      expect(j.totals).toMatchObject({ started: 1, completed: 1 });
      expect(j.recent[0]).toMatchObject({ outcome: "completed" });
    } finally {
      stop();
    }
  });

  test("an aborted ingest is recorded as aborted", async () => {
    // The mt#4480 abort path returns early. Since mt#4601 that no longer skips a
    // backfill — the backfill has its own sweep — but the ingest tick's own
    // outcome must still be `aborted` rather than `completed`, which is what
    // keeps a zero-ingest pass from reading as work done.
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({
        sessionsProcessed: 12,
        sessionsErrored: 12,
        totalIngested: 0,
        aborted: {
          afterSessionsProcessed: 12,
          consecutiveInfraFailures: 10,
          failureKind: "connection-lost",
        },
      }),
      runEmbeddings: async () => {},
      tracker,
    };
    const { store, stop } = startWithJournal(deps);

    try {
      await waitFor(() => store.read().totals.aborted >= 1);

      const j = store.read();
      expect(j.totals).toMatchObject({ started: 1, aborted: 1, completed: 0 });
      expect(j.recent[0]).toMatchObject({ outcome: "aborted" });
      expect(summarizeJournal(j).completionRate).toBe(0);
    } finally {
      stop();
    }
  });

  test("the ingest sweep no longer runs the embedding backfill at all (mt#4601)", async () => {
    // The split, asserted directly. Before mt#4601 a throwing `runEmbeddings`
    // produced an `embed-failed` tick here; now this sweep never calls it, so a
    // deliberately-exploding backfill cannot affect the ingest tick's outcome.
    let embedCalls = 0;
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({ sessionsProcessed: 1, sessionsErrored: 0, totalIngested: 1 }),
      runEmbeddings: async () => {
        embedCalls++;
        throw new Error("this sweep must not call me");
      },
      tracker,
    };
    const { store, stop } = startWithJournal(deps);

    try {
      await waitFor(() => store.read().totals.completed >= 1);

      expect(embedCalls).toBe(0);
      expect(store.read().recent[0]).toMatchObject({ outcome: "completed" });
      // The tracker's embed counters stay untouched by THIS sweep.
      expect(tracker.getSummary().embedRuns).toBe(0);
      expect(tracker.getSummary().embedFailures).toBe(0);
    } finally {
      stop();
    }
  });

  test("an ingest that throws is recorded as failed", async () => {
    const deps: TranscriptSweepDeps = {
      runIngest: async () => {
        throw new Error("PersistenceService.initialize() timed out after 68168ms");
      },
      runEmbeddings: async () => {},
      tracker,
    };
    const { store, stop } = startWithJournal(deps);

    try {
      await waitFor(() => store.read().totals.failed >= 1);

      const j = store.read();
      expect(j.totals).toMatchObject({ started: 1, failed: 1, completed: 0 });
      expect(j.inFlight).toBeNull();
    } finally {
      stop();
    }
  });

  test("a tick left in flight by a dead process is folded as interrupted at boot", async () => {
    // The restart case, end to end: a journal left carrying an in-flight tick
    // from a process that is gone, then a fresh sweep boots and reconciles it.
    // 4_194_303 is one past Linux's default pid_max and is the same
    // never-assigned pid `port-recovery.test.ts` uses to exercise
    // `isProcessAlive`'s false branch.
    const orphaned = foldTickStarted(emptyJournal(), "2026-08-25T20:33:05.000Z", 4_194_303);
    const store = createMemoryJournalStore(orphaned);
    const deps: TranscriptSweepDeps = {
      runIngest: async () => ({ sessionsProcessed: 0, sessionsErrored: 0, totalIngested: 0 }),
      runEmbeddings: async () => {},
      tracker,
    };

    const stop = startTranscriptSweepBackstop(
      new TranscriptSweepJournalRecorder(store, INGEST_SWEEP_LABEL),
      { intervalMs: 60_000, deps }
    );

    try {
      await waitFor(() => store.read().totals.interrupted >= 1);

      const j = store.read();
      expect(j.totals.interrupted).toBe(1);
      expect(j.recent.some((t) => t.outcome === "interrupted" && t.pid === 4_194_303)).toBe(true);
    } finally {
      stop();
    }
  });
});
