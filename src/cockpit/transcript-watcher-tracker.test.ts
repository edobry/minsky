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

  describe("active-session registry (SC2)", () => {
    test("recordSessionEvent seeds the registry", () => {
      tracker.recordSessionEvent("sess-a", "/p/sess-a.jsonl", false);
      const list = tracker.getActiveSessions();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        agentSessionId: "sess-a",
        jsonlPath: "/p/sess-a.jsonl",
        isSubagent: false,
        lastIngestAt: null,
        lastTurnsIngested: 0,
      });
      expect(list[0]?.lastEventAt).not.toBeNull();
    });

    test("recordSessionIngest stamps freshness only for a known session", () => {
      tracker.recordSessionIngest("unknown", 5); // no-op — not registered
      expect(tracker.getActiveSessions()).toHaveLength(0);

      tracker.recordSessionEvent("sess-b", "/p/sess-b.jsonl", true);
      tracker.recordSessionIngest("sess-b", 4);
      const [entry] = tracker.getActiveSessions();
      expect(entry?.isSubagent).toBe(true);
      expect(entry?.lastIngestAt).not.toBeNull();
      expect(entry?.lastTurnsIngested).toBe(4);
    });

    test("recordSessionEvent preserves prior ingest stamp on refresh", () => {
      tracker.recordSessionEvent("sess-c", "/p/sess-c.jsonl", false);
      tracker.recordSessionIngest("sess-c", 2);
      tracker.recordSessionEvent("sess-c", "/p/sess-c.jsonl", false); // new event
      const [entry] = tracker.getActiveSessions();
      expect(entry?.lastIngestAt).not.toBeNull();
      expect(entry?.lastTurnsIngested).toBe(2);
    });

    test("removeSession drops the entry", () => {
      tracker.recordSessionEvent("sess-d", "/p/sess-d.jsonl", false);
      tracker.removeSession("sess-d");
      expect(tracker.getActiveSessions()).toHaveLength(0);
    });

    test("getActiveSessions sorts most-recently-active first", async () => {
      tracker.recordSessionEvent("older", "/p/older.jsonl", false);
      // Small delay so "newer" gets a strictly later millisecond timestamp.
      await new Promise((resolve) => setTimeout(resolve, 3));
      tracker.recordSessionEvent("newer", "/p/newer.jsonl", false);
      const ids = tracker.getActiveSessions().map((s) => s.agentSessionId);
      expect(ids).toEqual(["newer", "older"]);
    });

    test("resetForTest clears the registry", () => {
      tracker.recordSessionEvent("sess-e", "/p/sess-e.jsonl", false);
      const fresh = TranscriptWatcherTracker.resetForTest();
      expect(fresh.getActiveSessions()).toHaveLength(0);
    });
  });
});
