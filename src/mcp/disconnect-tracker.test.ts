/**
 * DisconnectTracker unit tests (mt#1645)
 *
 * Verifies:
 * - recordDisconnect / recordReconnect / recordTransportError emit correctly shaped events
 * - getSummary() computes count24h, byServer, byKind, escalation correctly
 * - Escalation thresholds fire at the right counts (>1 session, >3 daily)
 * - Persistence round-trips are skipped when persistPath is empty (in-memory test mode)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { DisconnectTracker, type McpDisconnectEvent } from "./disconnect-tracker";

/** Shared test description string to avoid lint warnings about duplicated magic strings. */
const SHAPE_TEST_LABEL = "emits event with correct shape";

/** Helper: return a copy of the event with its timestamp shifted `msAgo` ms into the past.
 * Used to simulate events that fell outside the 24h window. */
function shiftEventTimestamp(event: McpDisconnectEvent, msAgo: number): McpDisconnectEvent {
  const pastMs = new Date(event.timestamp).getTime() - msAgo;
  return {
    ...event,
    timestamp: new Date(pastMs).toISOString(),
  };
}

// Force-replace internal events array on the tracker for age-simulation tests.
function setTrackerEvents(tracker: DisconnectTracker, events: McpDisconnectEvent[]): void {
  (tracker as unknown as { events: McpDisconnectEvent[] }).events = [...events];
}

describe("DisconnectTracker", () => {
  let tracker: DisconnectTracker;

  beforeEach(() => {
    // In-memory mode: persistPath="" disables file I/O so tests don't touch the filesystem.
    tracker = DisconnectTracker.resetForTest("test-server", "");
  });

  // -------------------------------------------------------------------------
  // Event shape
  // -------------------------------------------------------------------------

  describe("recordDisconnect", () => {
    test(SHAPE_TEST_LABEL, () => {
      const before = new Date();
      const event = tracker.recordDisconnect("stdin_close");
      const after = new Date();

      expect(event.serverName).toBe("test-server");
      expect(event.kind).toBe("disconnect");
      expect(event.cause).toBe("stdin_close");
      expect(event.error).toBeUndefined();

      const ts = new Date(event.timestamp);
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });

    test("includes error message when provided", () => {
      const event = tracker.recordDisconnect("transport_error", "EPIPE broken pipe");
      expect(event.error).toBe("EPIPE broken pipe");
    });

    test("increments session disconnect count", () => {
      expect(tracker.getSessionDisconnectCount()).toBe(0);
      tracker.recordDisconnect("stdin_close");
      expect(tracker.getSessionDisconnectCount()).toBe(1);
      tracker.recordDisconnect("unknown");
      expect(tracker.getSessionDisconnectCount()).toBe(2);
    });
  });

  describe("recordReconnect", () => {
    test(SHAPE_TEST_LABEL, () => {
      const event = tracker.recordReconnect();

      expect(event.serverName).toBe("test-server");
      expect(event.kind).toBe("reconnect");
      expect(event.cause).toBe("unknown");
      expect(event.error).toBeUndefined();
    });

    test("does not increment session disconnect count", () => {
      tracker.recordReconnect();
      expect(tracker.getSessionDisconnectCount()).toBe(0);
    });
  });

  describe("recordTransportError", () => {
    test(SHAPE_TEST_LABEL, () => {
      const event = tracker.recordTransportError("ECONNRESET");

      expect(event.serverName).toBe("test-server");
      expect(event.kind).toBe("transport_error");
      expect(event.cause).toBe("transport_error");
      expect(event.error).toBe("ECONNRESET");
    });
  });

  // -------------------------------------------------------------------------
  // getSummary — cadence computation
  // -------------------------------------------------------------------------

  describe("getSummary", () => {
    test("returns zero counts when no events recorded", () => {
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(0);
      expect(summary.reconnects24h).toBe(0);
      expect(summary.byServer).toEqual({});
      expect(summary.byKind).toEqual({ disconnect: 0, reconnect: 0, transport_error: 0 });
      expect(summary.last).toBeNull();
      expect(summary.escalation).toBe("none");
    });

    test("counts disconnect and reconnect events in last 24h", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordReconnect();
      tracker.recordDisconnect("unknown");

      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(2);
      expect(summary.reconnects24h).toBe(1);
    });

    test("excludes events older than 24h from count24h", () => {
      tracker.recordDisconnect("stdin_close");
      // Manually backdate the first event beyond the 24h window
      const events = [...tracker.getEvents()];
      const firstEvent = events[0];
      if (!firstEvent) throw new Error("Expected at least one event in tracker");
      const oldEvent = shiftEventTimestamp(firstEvent, 25 * 60 * 60 * 1000); // 25h ago
      setTrackerEvents(tracker, [oldEvent]);

      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(0);
    });

    test("byServer groups all event kinds", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordReconnect();

      const summary = tracker.getSummary();
      expect(summary.byServer["test-server"]).toBe(2);
    });

    test("byKind counts each kind separately", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      tracker.recordReconnect();
      tracker.recordTransportError("err");

      const summary = tracker.getSummary();
      expect(summary.byKind.disconnect).toBe(2);
      expect(summary.byKind.reconnect).toBe(1);
      expect(summary.byKind.transport_error).toBe(1);
    });

    test("last reflects the most recently recorded event", () => {
      tracker.recordDisconnect("stdin_close");
      const reconnect = tracker.recordReconnect();

      const summary = tracker.getSummary();
      expect(summary.last).not.toBeNull();
      const lastEvent = summary.last;
      if (!lastEvent) throw new Error("Expected summary.last to be defined");
      expect(lastEvent.kind).toBe("reconnect");
      expect(lastEvent.timestamp).toBe(reconnect.timestamp);
    });

    // -----------------------------------------------------------------------
    // Escalation thresholds
    // -----------------------------------------------------------------------

    test("escalation is 'none' at exactly 1 session disconnect", () => {
      tracker.recordDisconnect("stdin_close");
      // sessionDisconnects = 1; threshold is > 1, so still "none"
      const summary = tracker.getSummary();
      expect(summary.escalation).toBe("none");
    });

    test("escalation is 'session' at 2 session disconnects", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      // sessionDisconnects = 2; > 1 threshold exceeded
      const summary = tracker.getSummary();
      expect(summary.escalation).toBe("session");
    });

    test("escalation is 'none' at exactly 3 disconnects in 24h", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      tracker.recordDisconnect("signal");
      // count24h = 3; daily threshold is > 3, so still "none" (session threshold > 1 fires first)
      // Reset session count to isolate daily-only check
      tracker.setSessionDisconnectCountForTest(1);
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(3);
      expect(summary.escalation).toBe("none");
    });

    test("escalation is 'daily' at 4 disconnects in 24h (when session count is not high)", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      tracker.recordDisconnect("signal");
      tracker.recordDisconnect("server_close");
      // count24h = 4; > 3 threshold exceeded
      // Reset session count to isolate daily-only threshold
      tracker.setSessionDisconnectCountForTest(1);
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(4);
      expect(summary.escalation).toBe("daily");
    });

    test("'daily' takes precedence over 'session' when both thresholds exceeded", () => {
      // 4 disconnects in 24h + session count > 1
      for (let i = 0; i < 4; i++) {
        tracker.recordDisconnect("stdin_close");
      }
      const summary = tracker.getSummary();
      // daily threshold (>3) checked first → "daily"
      expect(summary.escalation).toBe("daily");
    });
  });

  // -------------------------------------------------------------------------
  // Ring buffer cap
  // -------------------------------------------------------------------------

  test("caps stored events at MAX_EVENTS (500)", () => {
    // Record 510 events — only the last 500 should be retained
    for (let i = 0; i < 510; i++) {
      tracker.recordDisconnect("unknown");
    }
    expect(tracker.getEvents().length).toBeLessThanOrEqual(500);
  });

  // -------------------------------------------------------------------------
  // Singleton behaviour
  // -------------------------------------------------------------------------

  test("resetForTest returns a fresh instance", () => {
    tracker.recordDisconnect("stdin_close");
    const fresh = DisconnectTracker.resetForTest("other-server", "");
    expect(fresh.getSessionDisconnectCount()).toBe(0);
    expect(fresh.getEvents().length).toBe(0);
  });

  test("getInstance returns the same instance on repeated calls", () => {
    const a = DisconnectTracker.getInstance("test-server");
    const b = DisconnectTracker.getInstance("test-server");
    expect(a).toBe(b);
  });
});
