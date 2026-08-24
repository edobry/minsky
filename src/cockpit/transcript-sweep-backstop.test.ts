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
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
import type { TranscriptSweepDeps } from "./transcript-sweep-backstop";

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

    const stop = startTranscriptSweepBackstop({
      intervalMs: 60_000, // Don't tick again during the test.
      deps,
    });

    try {
      // Boot pass fires immediately (void tick()).
      await waitFor(() => tracker.getSummary().sweepsRun >= 1);

      expect(ingestCalls).toHaveLength(1);
      expect(embedCalls).toHaveLength(1);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.sessionsIngested).toBe(5);
      expect(summary.sessionsErrored).toBe(0);
      expect(summary.embedRuns).toBe(1);
      expect(summary.lastSweepAt).not.toBeNull();
      expect(summary.lastErrorAt).toBeNull();
    } finally {
      stop();
    }
  });

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

    const stop = startTranscriptSweepBackstop({ intervalMs: 20, deps });

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
    const stop = startTranscriptSweepBackstop({ intervalMs: 1, deps });

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

    const stop = startTranscriptSweepBackstop({ intervalMs: 60_000, deps });

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

    const stop = startTranscriptSweepBackstop({ intervalMs: 60_000, deps });

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

    const stop = startTranscriptSweepBackstop({ intervalMs: 60_000, deps });

    try {
      await waitFor(() => tracker.getSummary().sweepsRun >= 1, 500);

      const summary = tracker.getSummary();
      expect(summary.sweepsRun).toBe(1);
      expect(summary.sessionsIngested).toBe(10);
      expect(summary.sessionsErrored).toBe(3);
      // lastErrorAt is set when sessionsErrored > 0.
      expect(summary.lastErrorAt).not.toBeNull();
      // Embedding still ran.
      expect(summary.embedRuns).toBe(1);
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

    const stop = startTranscriptSweepBackstop({ intervalMs: 60_000, deps });

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

    const stop = startTranscriptSweepBackstop({ intervalMs: 60_000, deps });
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

    const stop = startTranscriptSweepBackstop({ intervalMs: 10, deps });

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

  test("embedNeverSucceeded is true once a sweep ran with no successful embed", () => {
    tracker.recordSweepCompleted(5, 0);
    const s = tracker.getSummary();
    expect(s.sweepsRun).toBe(1);
    expect(s.embedRuns).toBe(0);
    expect(s.embedNeverSucceeded).toBe(true);
  });

  test("embedNeverSucceeded goes false as soon as one embed run succeeds", () => {
    tracker.recordSweepCompleted(5, 0);
    expect(tracker.getSummary().embedNeverSucceeded).toBe(true);
    tracker.recordEmbedRunCompleted();
    expect(tracker.getSummary().embedNeverSucceeded).toBe(false);
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
