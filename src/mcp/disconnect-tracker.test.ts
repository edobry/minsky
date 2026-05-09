/**
 * DisconnectTracker unit tests (mt#1645 + mt#1682)
 *
 * Verifies:
 * - record* methods emit correctly shaped events (including uptimeMs)
 * - getSummary() computes count24h, byServer, byKind, byCause, escalation correctly
 * - Escalation filter excludes server-initiated causes and short-lived probes
 * - Append-only JSONL persistence — events durably hit disk before return
 * - Format migration — legacy single-array JSON is loadable
 * - Process-lifecycle markers (process_start) are recorded with PID
 *
 * The persistence-roundtrip and persist-race suites intentionally use real
 * filesystem operations because they test the persistence layer's actual
 * on-disk behavior. An in-memory mock of `fs` would not catch the persist-
 * race-with-process-death bug that motivated the append-only switch
 * (mt#1682). The custom/no-real-fs-in-tests rule is disabled file-wide for
 * this reason.
 */
/* eslint-disable custom/no-real-fs-in-tests */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DisconnectTracker, type McpDisconnectEvent } from "./disconnect-tracker";

const SHAPE_TEST_LABEL = "emits event with correct shape";

function shiftEventTimestamp(event: McpDisconnectEvent, msAgo: number): McpDisconnectEvent {
  const pastMs = new Date(event.timestamp).getTime() - msAgo;
  return {
    ...event,
    timestamp: new Date(pastMs).toISOString(),
  };
}

function setTrackerEvents(tracker: DisconnectTracker, events: McpDisconnectEvent[]): void {
  (tracker as unknown as { events: McpDisconnectEvent[] }).events = [...events];
}

function makeTempPath(name: string): string {
  return path.join(os.tmpdir(), `disconnect-tracker-test-${process.pid}-${Date.now()}-${name}`);
}

describe("DisconnectTracker", () => {
  let tracker: DisconnectTracker;

  beforeEach(() => {
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
      expect(typeof event.uptimeMs).toBe("number");

      const ts = new Date(event.timestamp);
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });

    test("includes error message when provided", () => {
      const event = tracker.recordDisconnect("transport_error", "EPIPE broken pipe");
      expect(event.error).toBe("EPIPE broken pipe");
    });

    test("uptimeMs reflects time since process start", () => {
      tracker.setProcessStartTimeForTest(Date.now() - 10_000);
      const event = tracker.recordDisconnect("stdin_close");
      expect(event.uptimeMs).toBeGreaterThanOrEqual(10_000);
      expect(event.uptimeMs).toBeLessThan(11_000);
    });

    test("increments total session disconnect count", () => {
      expect(tracker.getSessionDisconnectCount()).toBe(0);
      tracker.recordDisconnect("stdin_close");
      expect(tracker.getSessionDisconnectCount()).toBe(1);
      tracker.recordDisconnect("unknown");
      expect(tracker.getSessionDisconnectCount()).toBe(2);
    });

    test("only escalation-eligible disconnects increment the eligible counter", () => {
      // Backdate start so any disconnect we record has uptimeMs > threshold.
      tracker.setProcessStartTimeForTest(Date.now() - 60_000);

      // server-initiated causes — never eligible
      tracker.recordDisconnect("staleness_exit");
      tracker.recordDisconnect("signal_sigterm");
      tracker.recordDisconnect("server_close");
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(0);

      // Harness-side cause with adequate uptime — eligible
      tracker.recordDisconnect("stdin_close");
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(1);
    });

    test("short-lived disconnects are not eligible even for harness causes", () => {
      // Don't backdate — uptime will be ~0ms, well below threshold.
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      expect(tracker.getSessionDisconnectCount()).toBe(2);
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(0);
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

    test("does not increment session disconnect counts", () => {
      tracker.recordReconnect();
      expect(tracker.getSessionDisconnectCount()).toBe(0);
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(0);
    });
  });

  describe("recordTransportError", () => {
    test(SHAPE_TEST_LABEL, () => {
      const event = tracker.recordTransportError("ECONNRESET");
      expect(event.serverName).toBe("test-server");
      expect(event.kind).toBe("transport_error");
      expect(event.cause).toBe("transport_error");
      expect(event.error).toBe("ECONNRESET");
      expect(typeof event.uptimeMs).toBe("number");
    });
  });

  describe("recordProcessStart", () => {
    test("records a process_start event with pid", () => {
      const event = tracker.recordProcessStart();
      expect(event.kind).toBe("process_start");
      expect(event.cause).toBe("process_start");
      expect(event.serverName).toBe("test-server");
      expect(event.pid).toBe(process.pid);
    });

    test("does not increment any disconnect counter", () => {
      tracker.recordProcessStart();
      expect(tracker.getSessionDisconnectCount()).toBe(0);
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(0);
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
      expect(summary.byKind).toEqual({
        process_start: 0,
        disconnect: 0,
        reconnect: 0,
        transport_error: 0,
      });
      expect(summary.byCause).toEqual({});
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
      const events = [...tracker.getEvents()];
      const firstEvent = events[0];
      if (!firstEvent) throw new Error("Expected at least one event in tracker");
      const oldEvent = shiftEventTimestamp(firstEvent, 25 * 60 * 60 * 1000);
      setTrackerEvents(tracker, [oldEvent]);

      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(0);
    });

    test("byServer groups all event kinds", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordReconnect();
      tracker.recordProcessStart();

      const summary = tracker.getSummary();
      expect(summary.byServer["test-server"]).toBe(3);
    });

    test("byKind counts each kind separately, including process_start", () => {
      tracker.recordProcessStart();
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      tracker.recordReconnect();
      tracker.recordTransportError("err");

      const summary = tracker.getSummary();
      expect(summary.byKind.process_start).toBe(1);
      expect(summary.byKind.disconnect).toBe(2);
      expect(summary.byKind.reconnect).toBe(1);
      expect(summary.byKind.transport_error).toBe(1);
    });

    test("byCause distribution surfaces the cause mix", () => {
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("staleness_exit");
      tracker.recordDisconnect("signal_sigterm");
      tracker.recordDisconnect("stdin_close");

      const summary = tracker.getSummary();
      expect(summary.byCause.stdin_close).toBe(2);
      expect(summary.byCause.staleness_exit).toBe(1);
      expect(summary.byCause.signal_sigterm).toBe(1);
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
    // Escalation thresholds — new semantics (mt#1682)
    // -----------------------------------------------------------------------

    test("escalation is 'none' when only short-lived disconnects accumulate", () => {
      // Five short-lived (uptime ~0) stdin_close — none eligible — no escalation
      for (let i = 0; i < 5; i++) tracker.recordDisconnect("stdin_close");
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(5);
      expect(summary.escalation).toBe("none");
    });

    test("escalation is 'none' when only server-initiated disconnects accumulate", () => {
      tracker.setProcessStartTimeForTest(Date.now() - 60_000); // long-lived process
      tracker.recordDisconnect("staleness_exit");
      tracker.recordDisconnect("signal_sigterm");
      tracker.recordDisconnect("server_close");
      tracker.recordDisconnect("idle_timeout");
      tracker.recordDisconnect("staleness_exit");
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(5);
      expect(summary.escalation).toBe("none");
    });

    test("escalation is 'session' at 2 eligible session disconnects", () => {
      tracker.setProcessStartTimeForTest(Date.now() - 60_000);
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      const summary = tracker.getSummary();
      expect(summary.escalation).toBe("session");
    });

    test("escalation is 'daily' at 4 eligible disconnects in 24h", () => {
      tracker.setProcessStartTimeForTest(Date.now() - 60_000);
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      tracker.recordDisconnect("stdin_close");
      tracker.recordDisconnect("unknown");
      // Reset session count so we isolate the daily branch
      tracker.setSessionDisconnectCountForTest(1, 1);
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(4);
      expect(summary.escalation).toBe("daily");
    });

    test("uptime filtering: only disconnects with uptime >= 5s count toward escalation", () => {
      // Record 5 disconnects at increasing uptimes by manipulating processStartTime
      const now = Date.now();
      const uptimes = [100, 200, 300, 6_000, 7_000];
      for (const u of uptimes) {
        tracker.setProcessStartTimeForTest(now - u);
        tracker.recordDisconnect("stdin_close");
      }
      // count24h is total — all 5
      const summary = tracker.getSummary();
      expect(summary.count24h).toBe(5);
      // eligible — only the 6000ms and 7000ms ones
      expect(tracker.getEligibleSessionDisconnectCount()).toBe(2);
      // 2 eligible > session-threshold (1), so escalation fires "session"
      expect(summary.escalation).toBe("session");
    });

    test("'daily' takes precedence over 'session' when both thresholds exceeded", () => {
      tracker.setProcessStartTimeForTest(Date.now() - 60_000);
      for (let i = 0; i < 4; i++) tracker.recordDisconnect("stdin_close");
      const summary = tracker.getSummary();
      expect(summary.escalation).toBe("daily");
    });
  });

  // -------------------------------------------------------------------------
  // Ring buffer cap
  // -------------------------------------------------------------------------

  test("caps stored events at MAX_EVENTS (500)", () => {
    for (let i = 0; i < 510; i++) tracker.recordDisconnect("unknown");
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

// ===========================================================================
// Persistence — append-only JSONL
// ===========================================================================

describe("DisconnectTracker persistence", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = makeTempPath("persist");
  });

  afterEach(() => {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  test("appends one JSON line per event", () => {
    const t = DisconnectTracker.resetForTest("srv", tmpPath);
    t.recordProcessStart();
    t.recordDisconnect("stdin_close");
    t.recordReconnect();

    const raw = fs.readFileSync(tmpPath, "utf-8") as string;
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(3);

    for (const line of lines) {
      // Each line must parse on its own — proves JSONL semantics, not a single array.
      const obj = JSON.parse(line);
      expect(typeof obj.kind).toBe("string");
      expect(typeof obj.serverName).toBe("string");
    }
  });

  test("loads JSONL events from disk on tracker construction", () => {
    // Write a JSONL file directly, then load via tracker.
    const events = [
      {
        timestamp: "2026-05-08T10:00:00.000Z",
        serverName: "srv",
        kind: "process_start",
        cause: "process_start",
        pid: 1234,
      },
      {
        timestamp: "2026-05-08T10:00:01.000Z",
        serverName: "srv",
        kind: "disconnect",
        cause: "stdin_close",
        uptimeMs: 1000,
      },
      {
        timestamp: "2026-05-08T10:00:02.000Z",
        serverName: "srv",
        kind: "reconnect",
        cause: "unknown",
      },
    ];
    fs.writeFileSync(tmpPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");

    const t = DisconnectTracker.resetForTest("srv", tmpPath);
    const loaded = t.getEvents();
    expect(loaded.length).toBe(3);
    expect(loaded[0]?.kind).toBe("process_start");
    expect(loaded[1]?.cause).toBe("stdin_close");
    expect(loaded[2]?.kind).toBe("reconnect");
  });

  test("loads legacy single-array JSON format (mt#1645 backward compat)", () => {
    // Write a legacy log file as `JSON.stringify(events, null, 2)` — the format
    // mt#1645 produced.
    const events = [
      {
        timestamp: "2026-05-07T10:00:00.000Z",
        serverName: "srv",
        kind: "reconnect",
        cause: "unknown",
      },
      {
        timestamp: "2026-05-07T10:00:01.000Z",
        serverName: "srv",
        kind: "disconnect",
        cause: "stdin_close",
      },
    ];
    fs.writeFileSync(tmpPath, JSON.stringify(events, null, 2), "utf-8");

    const t = DisconnectTracker.resetForTest("srv", tmpPath);
    const loaded = t.getEvents();
    expect(loaded.length).toBe(2);
    expect(loaded[0]?.kind).toBe("reconnect");
    expect(loaded[1]?.cause).toBe("stdin_close");
  });

  test("loads hybrid file: legacy array followed by appended JSONL lines", () => {
    // After upgrading from mt#1645 to mt#1682, the next process append-writes
    // JSONL after the legacy array. The loader must handle both halves.
    const legacyEvents = [
      {
        timestamp: "2026-05-07T10:00:00.000Z",
        serverName: "srv",
        kind: "reconnect",
        cause: "unknown",
      },
    ];
    const newEvents = [
      {
        timestamp: "2026-05-08T10:00:00.000Z",
        serverName: "srv",
        kind: "process_start",
        cause: "process_start",
        pid: 5678,
      },
      {
        timestamp: "2026-05-08T10:00:01.000Z",
        serverName: "srv",
        kind: "disconnect",
        cause: "stdin_close",
        uptimeMs: 1000,
      },
    ];
    const content = `${JSON.stringify(legacyEvents, null, 2)}\n${newEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
    fs.writeFileSync(tmpPath, content, "utf-8");

    const t = DisconnectTracker.resetForTest("srv", tmpPath);
    const loaded = t.getEvents();
    expect(loaded.length).toBe(3);
    expect(loaded[0]?.cause).toBe("unknown"); // from legacy
    expect(loaded[1]?.kind).toBe("process_start"); // first JSONL line
    expect(loaded[2]?.cause).toBe("stdin_close"); // second JSONL line
  });

  test("malformed JSONL lines are skipped without aborting the load", () => {
    const goodLine = JSON.stringify({
      timestamp: "2026-05-08T10:00:00.000Z",
      serverName: "srv",
      kind: "disconnect",
      cause: "stdin_close",
    });
    const badLine = "{ not json";
    fs.writeFileSync(tmpPath, `${goodLine}\n${badLine}\n${goodLine}\n`, "utf-8");

    const t = DisconnectTracker.resetForTest("srv", tmpPath);
    expect(t.getEvents().length).toBe(2);
  });
});

// ===========================================================================
// Persist-race: spawn child process, record event, exit immediately
// ===========================================================================

describe("DisconnectTracker persist-race", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = makeTempPath("race");
  });

  afterEach(() => {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  test("event is durably on disk after immediate process.exit", async () => {
    // Spawn a child that records a disconnect event, then synchronously
    // calls process.exit(0). On the legacy `writeFileSync(JSON.stringify(events))`
    // path, the write could race with stdio teardown if the process were
    // actually killed during the call — for the append-only path the write
    // returns before process.exit runs, so the event is durable.
    const trackerPath = path.resolve(__dirname, "disconnect-tracker.ts");
    const childScript = `
      const { DisconnectTracker } = await import(${JSON.stringify(trackerPath)});
      const t = new DisconnectTracker("race-server", ${JSON.stringify(tmpPath)});
      t.recordDisconnect("stdin_close", "race test");
      process.exit(0);
    `;

    const proc = Bun.spawn(["bun", "-e", childScript], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // Read the file — the child's recordDisconnect MUST have written before exit.
    expect(fs.existsSync(tmpPath)).toBe(true);
    const raw = fs.readFileSync(tmpPath, "utf-8") as string;
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const events = lines.map((l) => JSON.parse(l));
    const disconnect = events.find((e) => e.kind === "disconnect");
    expect(disconnect).toBeDefined();
    expect(disconnect.cause).toBe("stdin_close");
    expect(disconnect.error).toBe("race test");
  });
});
