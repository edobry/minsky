/**
 * Tests for {@link TranscriptWatcherTracker} (mt#2320 SC5 observability).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { TranscriptWatcherTracker } from "./transcript-watcher-tracker";

describe("TranscriptWatcherTracker", () => {
  let tracker: TranscriptWatcherTracker;

  beforeEach(() => {
    tracker = TranscriptWatcherTracker.resetForTest();
  });

  test("starts zero-filled", () => {
    const s = tracker.getSummary();
    expect(s).toEqual({
      running: false,
      filesWatched: 0,
      ingestsTriggered: 0,
      ingestsSucceeded: 0,
      ingestErrors: 0,
      turnsIngested: 0,
      lastIngestAt: null,
      lastErrorAt: null,
      lastError: null,
    });
  });

  test("getInstance returns a process-lifetime singleton", () => {
    const a = TranscriptWatcherTracker.getInstance();
    const b = TranscriptWatcherTracker.getInstance();
    expect(a).toBe(b);
  });

  test("records triggered/succeeded ingests and accumulates turns", () => {
    tracker.recordIngestTriggered();
    tracker.recordIngestSuccess(3);
    tracker.recordIngestTriggered();
    tracker.recordIngestSuccess(2);

    const s = tracker.getSummary();
    expect(s.ingestsTriggered).toBe(2);
    expect(s.ingestsSucceeded).toBe(2);
    expect(s.turnsIngested).toBe(5);
    const last = s.lastIngestAt;
    expect(last).not.toBeNull();
    // ISO-8601 round-trips to the same instant.
    expect(new Date(last as string).toISOString()).toBe(last as string);
  });

  test("records errors without dropping them (SC5)", () => {
    tracker.recordIngestError("DB unavailable");
    const s = tracker.getSummary();
    expect(s.ingestErrors).toBe(1);
    expect(s.lastError).toBe("DB unavailable");
    expect(s.lastErrorAt).not.toBeNull();
  });

  test("setRunning and setFilesWatched reflect in the summary; negatives clamp to 0", () => {
    tracker.setRunning(true);
    tracker.setFilesWatched(7);
    expect(tracker.getSummary().running).toBe(true);
    expect(tracker.getSummary().filesWatched).toBe(7);

    tracker.setFilesWatched(-5);
    expect(tracker.getSummary().filesWatched).toBe(0);

    tracker.recordIngestSuccess(-3);
    expect(tracker.getSummary().turnsIngested).toBe(0);
  });

  test("resetForTest yields a clean instance", () => {
    tracker.recordIngestTriggered();
    tracker.recordIngestSuccess(1);
    const fresh = TranscriptWatcherTracker.resetForTest();
    expect(fresh.getSummary().ingestsTriggered).toBe(0);
    expect(fresh.getSummary().turnsIngested).toBe(0);
  });
});
