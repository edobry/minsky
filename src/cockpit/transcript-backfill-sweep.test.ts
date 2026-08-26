/**
 * Unit tests for the embedding-backfill sweep (mt#4601).
 *
 * Most of these MOVED here from `transcript-sweep-backstop.test.ts`, where they
 * exercised the backfill as "Phase 2" of the ingest tick. They assert the same
 * behaviours against the sweep that now owns them — the mt#4524 in-flight
 * reporting, the failure conclusion — plus the two properties the split itself
 * creates: the backfill runs when ingest is not involved at all, and its failure
 * no longer stamps the ingest sweep's error timestamp.
 *
 * @see src/cockpit/transcript-backfill-sweep.ts — the unit under test
 * @see src/cockpit/transcript-sweep-backstop.ts — the ingest sweep it left
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveBackfillIntervalMs,
  startTranscriptBackfillSweep,
  type TranscriptBackfillDeps,
} from "./transcript-backfill-sweep";
import { TranscriptSweepTracker } from "./transcript-sweep-tracker";
import {
  BACKFILL_SWEEP_LABEL,
  createMemoryJournalStore,
  TranscriptSweepJournalRecorder,
  type SweepJournalStore,
} from "./transcript-sweep-journal";

/** Poll until `condition` holds. Mirrors the sibling file's helper and bound. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is timing, not path creation
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path creation
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startTranscriptBackfillSweep (mt#4601)", () => {
  let tracker: TranscriptSweepTracker;

  beforeEach(() => {
    tracker = TranscriptSweepTracker.resetForTest();
  });

  afterEach(() => {
    TranscriptSweepTracker.resetForTest();
  });

  /** Start the sweep against an injected journal store, and hand both back. */
  function start(deps: TranscriptBackfillDeps): { store: SweepJournalStore; stop: () => void } {
    const store = createMemoryJournalStore();
    const stop = startTranscriptBackfillSweep(
      new TranscriptSweepJournalRecorder(store, BACKFILL_SWEEP_LABEL),
      { intervalMs: 60_000, resolveDeps: async () => deps, schemaReadiness: false }
    );
    return { store, stop };
  }

  test("runs the backfill on its boot tick, with no ingest involved", async () => {
    // The split's whole point: this sweep reaches the backfill without an ingest
    // pass having to complete first. Before mt#4601 the same work sat behind a
    // ~12-minute Phase 1 inside a process whose median life is 13.4 minutes.
    let embedCalls = 0;
    const { store, stop } = start({
      runEmbeddings: async () => {
        embedCalls++;
      },
      tracker,
    });

    try {
      await waitFor(() => store.read().totals.completed >= 1);

      expect(embedCalls).toBe(1);
      expect(tracker.getSummary().embedRuns).toBe(1);
      expect(store.read().recent[0]).toMatchObject({ outcome: "completed" });
    } finally {
      stop();
    }
  });

  // Moved from the backstop's tests (mt#4524). The tracker unit tests prove the
  // tracker CAN report in-flight; only this proves the TICK marks it, because it
  // samples from INSIDE the awaited backfill — the window in which the live
  // daemon reported a standing failure.
  test("the health summary reads in-flight DURING the backfill, not never-succeeded", async () => {
    let during: ReturnType<TranscriptSweepTracker["getSummary"]> | null = null;

    const { stop } = start({
      runEmbeddings: async () => {
        during = tracker.getSummary();
      },
      tracker,
    });

    try {
      await waitFor(() => tracker.getSummary().embedRuns >= 1);

      expect(during).not.toBeNull();
      const d = during as unknown as ReturnType<TranscriptSweepTracker["getSummary"]>;
      expect(d.embedRuns).toBe(0);
      expect(d.embedPhase).toBe("in-flight");
      expect(d.embedInFlightAgeMs).not.toBeNull();
      expect(d.embedNeverSucceeded).toBe(false);

      const after = tracker.getSummary();
      expect(after.embedPhase).toBe("succeeded");
      expect(after.embedInFlightAgeMs).toBeNull();
    } finally {
      stop();
    }
  });

  test("a failed backfill concludes as failed, and sets embedNeverSucceeded (mt#4524)", async () => {
    const { store, stop } = start({
      runEmbeddings: async () => {
        throw new Error("embedding provider unreachable");
      },
      tracker,
    });

    try {
      await waitFor(() => tracker.getSummary().embedFailures >= 1);

      const s = tracker.getSummary();
      expect(s.embedPhase).toBe("failed");
      expect(s.embedInFlightAgeMs).toBeNull();
      expect(s.embedRuns).toBe(0);
      expect(s.embedNeverSucceeded).toBe(true);
      expect(store.read().recent[0]).toMatchObject({ outcome: "failed" });
    } finally {
      stop();
    }
  });

  test("a failed backfill does NOT stamp the ingest sweep's error timestamp", async () => {
    // Behaviour CHANGE from the combined tick, and deliberate. The old Phase 2
    // called `recordSweepError()` on failure, which set a sweep-level
    // `lastErrorAt` that a reader attributes to ingest — the two-jobs-one-boolean
    // conflation mt#4412 objected to. Now the backfill reports only its own
    // counters, and the ingest sweep's error timestamp means ingest failed.
    const { stop } = start({
      runEmbeddings: async () => {
        throw new Error("embedding provider unreachable");
      },
      tracker,
    });

    try {
      await waitFor(() => tracker.getSummary().embedFailures >= 1);

      expect(tracker.getSummary().lastErrorAt).toBeNull();
    } finally {
      stop();
    }
  });

  test("a tick with no SQL-capable provider is recorded as skipped, not completed", async () => {
    const store = createMemoryJournalStore();
    const stop = startTranscriptBackfillSweep(
      new TranscriptSweepJournalRecorder(store, BACKFILL_SWEEP_LABEL),
      { intervalMs: 60_000, resolveDeps: async () => null, schemaReadiness: false }
    );

    try {
      await waitFor(() => store.read().totals.skipped >= 1);

      expect(store.read().totals.completed).toBe(0);
      expect(store.read().recent[0]).toMatchObject({ outcome: "skipped" });
    } finally {
      stop();
    }
  });

  test("a resolver that throws is recorded as failed rather than escaping the tick", async () => {
    const store = createMemoryJournalStore();
    const stop = startTranscriptBackfillSweep(
      new TranscriptSweepJournalRecorder(store, BACKFILL_SWEEP_LABEL),
      {
        intervalMs: 60_000,
        resolveDeps: async () => {
          throw new Error("PersistenceService.initialize() timed out after 68168ms");
        },
        schemaReadiness: false,
      }
    );

    try {
      await waitFor(() => store.read().totals.failed >= 1);

      expect(store.read().inFlight).toBeNull();
    } finally {
      stop();
    }
  });
});

describe("resolveBackfillIntervalMs", () => {
  const ENV = "MINSKY_TRANSCRIPT_BACKFILL_INTERVAL_MS";
  const DEFAULT_MS = 10 * 60 * 1000;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  test("defaults to 10 minutes — its own cadence, not the ingest sweep's 30", () => {
    expect(resolveBackfillIntervalMs()).toBe(DEFAULT_MS);
  });

  test("uses a valid positive-integer env override", () => {
    process.env[ENV] = "60000";
    expect(resolveBackfillIntervalMs()).toBe(60000);
  });

  test("falls back to the default on invalid env values", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      process.env[ENV] = bad;
      expect(resolveBackfillIntervalMs()).toBe(DEFAULT_MS);
    }
  });
});
