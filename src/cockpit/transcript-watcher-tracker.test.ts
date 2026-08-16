/**
 * Tests for {@link TranscriptWatcherTracker} (mt#2320 SC5 observability).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { LIVE_SESSION_WINDOW_MS, TranscriptWatcherTracker } from "./transcript-watcher-tracker";

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
    tracker.recordIngestError();
    const s = tracker.getSummary();
    expect(s.ingestErrors).toBe(1);
    expect(s.lastErrorAt).not.toBeNull();
    // The raw error message is deliberately NOT exposed (redacted from /api/health).
    expect(s).not.toHaveProperty("lastError");
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
    test("recordSessionEvent seeds the registry (no absolute path exposed)", () => {
      tracker.recordSessionEvent("sess-a", false);
      const list = tracker.getActiveSessions();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        agentSessionId: "sess-a",
        isSubagent: false,
        lastIngestAt: null,
        lastTurnsIngested: 0,
      });
      expect(list[0]?.lastEventAt).not.toBeNull();
      // Absolute path is redacted from the public surface (reviewer R1).
      expect(list[0]).not.toHaveProperty("jsonlPath");
    });

    test("recordSessionIngest stamps freshness only for a known session", () => {
      tracker.recordSessionIngest("unknown", 5); // no-op — not registered
      expect(tracker.getActiveSessions()).toHaveLength(0);

      tracker.recordSessionEvent("sess-b", true);
      tracker.recordSessionIngest("sess-b", 4);
      const [entry] = tracker.getActiveSessions();
      expect(entry?.isSubagent).toBe(true);
      expect(entry?.lastIngestAt).not.toBeNull();
      expect(entry?.lastTurnsIngested).toBe(4);
    });

    test("recordSessionEvent preserves prior ingest stamp on refresh", () => {
      tracker.recordSessionEvent("sess-c", false);
      tracker.recordSessionIngest("sess-c", 2);
      tracker.recordSessionEvent("sess-c", false); // new event
      const [entry] = tracker.getActiveSessions();
      expect(entry?.lastIngestAt).not.toBeNull();
      expect(entry?.lastTurnsIngested).toBe(2);
    });

    test("removeSession drops the entry", () => {
      tracker.recordSessionEvent("sess-d", false);
      tracker.removeSession("sess-d");
      expect(tracker.getActiveSessions()).toHaveLength(0);
    });

    test("getActiveSessions sorts most-recently-active first", async () => {
      tracker.recordSessionEvent("older", false);
      // Small delay so "newer" gets a strictly later millisecond timestamp.
      await new Promise((resolve) => setTimeout(resolve, 3));
      tracker.recordSessionEvent("newer", false);
      const ids = tracker.getActiveSessions().map((s) => s.agentSessionId);
      expect(ids).toEqual(["newer", "older"]);
    });

    test("resetForTest clears the registry", () => {
      tracker.recordSessionEvent("sess-e", false);
      const fresh = TranscriptWatcherTracker.resetForTest();
      expect(fresh.getActiveSessions()).toHaveLength(0);
    });
  });

  describe("live-session window (mt#3857)", () => {
    // `getLiveSessions` takes an injectable clock, so these advance NOW rather than
    // back-dating entries or sleeping — `recordSessionEvent` always stamps Date.now().
    const now = () => Date.now();

    /**
     * The exact millisecond `recordSessionEvent` stamped, read back from the
     * registry (mt#4137).
     *
     * Any assertion that pins an entry to a window EDGE must anchor on this,
     * never on a second `now()` read: `recordSessionEvent` stamps its own
     * `Date.now()`, so a later read can be one or more milliseconds ahead, and
     * an edge computed from it lands outside the window. Such a test passes
     * only when two adjacent clock reads happen to return the same millisecond
     * — which they usually do on an idle machine and do not under load.
     *
     * `lastEventAt` is an ISO string at millisecond precision, so `Date.parse`
     * recovers the stamp exactly.
     */
    const stampOf = (agentSessionId: string): number => {
      const entry = tracker.getActiveSessions().find((s) => s.agentSessionId === agentSessionId);
      if (!entry?.lastEventAt) {
        throw new Error(`no event stamp recorded for "${agentSessionId}"`);
      }
      return Date.parse(entry.lastEventAt);
    };

    test("a session with a just-recorded event is live", () => {
      tracker.recordSessionEvent("fresh", false);
      expect(tracker.getLiveSessions(now()).map((s) => s.agentSessionId)).toEqual(["fresh"]);
    });

    test("a session goes stale once its last event falls outside the window", () => {
      tracker.recordSessionEvent("going-stale", false);
      const pastWindow = now() + LIVE_SESSION_WINDOW_MS + 1;
      expect(tracker.getLiveSessions(pastWindow)).toHaveLength(0);
    });

    test("an event exactly at the window boundary still counts as live", () => {
      tracker.recordSessionEvent("boundary", false);
      // Anchored on the recorded stamp, so this is EXACTLY the edge regardless of
      // how much time passes between recording and asserting (mt#4137).
      const atEdge = stampOf("boundary") + LIVE_SESSION_WINDOW_MS;
      expect(tracker.getLiveSessions(atEdge).map((s) => s.agentSessionId)).toEqual(["boundary"]);
    });

    test("one millisecond past the boundary is not live", () => {
      tracker.recordSessionEvent("just-past", false);
      const pastEdge = stampOf("just-past") + LIVE_SESSION_WINDOW_MS + 1;
      expect(tracker.getLiveSessions(pastEdge)).toHaveLength(0);
    });

    test("the live set is a subset — stale entries drop, fresh ones stay", () => {
      tracker.recordSessionEvent("stale-one", false);
      tracker.recordSessionEvent("still-live", false);
      // Anchor on the LATER of the two stamps (mt#4137). Computing `later` from a
      // clock read taken BEFORE "still-live" was recorded required that read and
      // the subsequent stamp to be the same millisecond — otherwise "still-live"
      // was still inside the window at `later` and the length-0 assertion failed.
      const latest = stampOf("still-live");
      const later = latest + LIVE_SESSION_WINDOW_MS + 1;
      const live = tracker.getLiveSessions(latest).map((s) => s.agentSessionId);
      expect(live).toContain("still-live");
      // Both are strictly outside at `later`: "stale-one" was stamped no later
      // than "still-live", so it is at least as far past the edge.
      expect(tracker.getLiveSessions(later)).toHaveLength(0);
    });

    // The regression this task exists for. TranscriptWatcher.seedExisting() calls
    // recordSessionEvent() for every pre-existing file at boot, so a large history
    // arrives all stamped "now" — which is exactly what made /api/health 209 KB.
    // The registry should still KNOW about all of them; only what health serializes
    // is bounded.
    test("a boot scan of many files leaves the live set empty once the window passes", () => {
      for (let i = 0; i < 1000; i++) {
        tracker.recordSessionEvent(`boot-seeded-${i}`, false);
      }
      expect(tracker.trackedSessionCount).toBe(1000);
      expect(tracker.getActiveSessions()).toHaveLength(1000);

      const pastWindow = now() + LIVE_SESSION_WINDOW_MS + 1;
      expect(tracker.getLiveSessions(pastWindow)).toHaveLength(0);
      // The count is what /api/health reports, and it is unaffected by the filter.
      expect(tracker.trackedSessionCount).toBe(1000);
    });

    test("a seeded-but-never-active session is tracked and NOT live", () => {
      tracker.recordSessionSeeded("seeded", false);
      expect(tracker.trackedSessionCount).toBe(1);
      expect(tracker.getActiveSessions()[0]?.lastEventAt).toBeNull();
      expect(tracker.getLiveSessions(now())).toHaveLength(0);
    });

    // The end-to-end shape of the boot scan: seedExisting() registers the whole
    // history at once. Before mt#3857 that stamped every entry as live, so the
    // window filter matched everything for its first two minutes and /api/health
    // stayed at ~210 KB across every daemon restart.
    test("a boot scan of many files yields zero live sessions immediately", () => {
      for (let i = 0; i < 1000; i++) {
        tracker.recordSessionSeeded(`boot-seeded-${i}`, false);
      }
      expect(tracker.trackedSessionCount).toBe(1000);
      expect(tracker.getLiveSessions(now())).toHaveLength(0);
    });

    test("a real event on a seeded session promotes it to live", () => {
      tracker.recordSessionSeeded("wakes-up", false);
      expect(tracker.getLiveSessions(now())).toHaveLength(0);
      tracker.recordSessionEvent("wakes-up", false);
      expect(tracker.getLiveSessions(now()).map((s) => s.agentSessionId)).toEqual(["wakes-up"]);
      expect(tracker.trackedSessionCount).toBe(1);
    });

    test("seeding does not clobber a session that already has an event", () => {
      tracker.recordSessionEvent("already-active", false);
      tracker.recordSessionIngest("already-active", 7);
      tracker.recordSessionSeeded("already-active", false);
      const [entry] = tracker.getActiveSessions();
      expect(entry?.lastEventAt).not.toBeNull();
      expect(entry?.lastTurnsIngested).toBe(7);
      expect(tracker.getLiveSessions(now())).toHaveLength(1);
    });
  });
});
