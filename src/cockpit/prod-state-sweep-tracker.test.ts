/**
 * Tests for {@link ProdStateSweepTracker} (mt#3039 SC3 observability).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { ProdStateSweepTracker } from "./prod-state-sweep-tracker";

describe("ProdStateSweepTracker", () => {
  let tracker: ProdStateSweepTracker;

  beforeEach(() => {
    tracker = ProdStateSweepTracker.resetForTest();
  });

  test("starts zero-filled", () => {
    const s = tracker.getSummary();
    expect(s).toEqual({
      runsCount: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
    });
  });

  test("getInstance returns a process-lifetime singleton", () => {
    const a = ProdStateSweepTracker.getInstance();
    const b = ProdStateSweepTracker.getInstance();
    expect(a).toBe(b);
  });

  test("recordRun accumulates runsCount and stamps lastRunAt", () => {
    tracker.recordRun();
    tracker.recordRun();
    const s = tracker.getSummary();
    expect(s.runsCount).toBe(2);
    expect(s.lastRunAt).not.toBeNull();
    // ISO-8601 round-trips to the same instant.
    expect(new Date(s.lastRunAt as string).toISOString()).toBe(s.lastRunAt as string);
  });

  test("recordSuccess stamps lastSuccessAt and resets consecutiveFailures", () => {
    tracker.recordFailure();
    tracker.recordFailure();
    expect(tracker.getSummary().consecutiveFailures).toBe(2);

    tracker.recordSuccess();
    const s = tracker.getSummary();
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });

  test("recordFailure increments consecutiveFailures and stamps lastErrorAt without a raw message", () => {
    tracker.recordFailure();
    const s = tracker.getSummary();
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastErrorAt).not.toBeNull();
    // The raw error message is deliberately NOT exposed (redacted from /api/health) —
    // same redaction policy as TranscriptWatcherTracker/TranscriptSweepTracker.
    expect(s).not.toHaveProperty("lastError");
    expect(s).not.toHaveProperty("lastErrorMessage");
  });

  test("consecutiveFailures keeps incrementing across repeated failures — a persistent failure never terminates counting (mt#3039 SC1)", () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordRun();
      tracker.recordFailure();
    }
    const s = tracker.getSummary();
    expect(s.runsCount).toBe(5);
    expect(s.consecutiveFailures).toBe(5);
    expect(s.lastSuccessAt).toBeNull();
  });

  test("resetForTest yields a clean instance", () => {
    tracker.recordRun();
    tracker.recordFailure();
    const fresh = ProdStateSweepTracker.resetForTest();
    expect(fresh.getSummary().runsCount).toBe(0);
    expect(fresh.getSummary().consecutiveFailures).toBe(0);
  });
});
