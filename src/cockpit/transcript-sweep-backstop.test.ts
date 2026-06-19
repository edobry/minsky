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
 * @see src/cockpit/server.ts — startTranscriptSweepBackstop
 * @see src/cockpit/transcript-sweep-tracker.ts — TranscriptSweepTracker
 * @see mt#2321 — cockpit-daemon transcript sweep backstop
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startTranscriptSweepBackstop } from "./server";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
import type { TranscriptSweepDeps } from "./server";

// Helper: wait for an async condition to become true (polls at 5ms intervals).
async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
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
