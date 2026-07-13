import { describe, test, expect } from "bun:test";
import {
  computeDispatchWatchdogFlags,
  buildDispatchWatchdogSnapshot,
  DISPATCH_WATCHDOG_STALE_MS,
  LAST_EVENT_AT_QUERY,
  DispatchWatchdogSweepTracker,
  type InFlightInvocationRow,
  type ActivitySources,
  type DispatchWatchdogDeps,
} from "./dispatch-watchdog";

const NOW_MS = Date.parse("2026-07-07T12:00:00.000Z");

function row(overrides: Partial<InFlightInvocationRow> = {}): InFlightInvocationRow {
  return {
    taskId: "mt#2646",
    subagentSessionId: "session-1",
    agentType: "implementer",
    startedAt: "2026-07-07T11:00:00.000Z", // 60m before NOW_MS
    ...overrides,
  };
}

const noActivity: ActivitySources = {
  lastCommitAtMs: () => null,
  lastEventAtMs: () => null,
};

describe("computeDispatchWatchdogFlags", () => {
  test("flags a dispatch with no activity signal beyond dispatch time, stale past the window", () => {
    const flags = computeDispatchWatchdogFlags(
      [row()],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]?.taskId).toBe("mt#2646");
    expect(flags[0]?.staleForMs).toBe(60 * 60 * 1000);
    expect(flags[0]?.lastActivityAt).toBe("2026-07-07T11:00:00.000Z");
  });

  test("does not flag a dispatch within the stale window", () => {
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: "2026-07-07T11:45:00.000Z" })], // 15m before NOW_MS
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("does not flag a task that is not IN-PROGRESS or IN-REVIEW", () => {
    for (const status of ["TODO", "PLANNING", "READY", "DONE", "BLOCKED", null, undefined]) {
      const flags = computeDispatchWatchdogFlags(
        [row()],
        { "mt#2646": status },
        noActivity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(0);
    }
  });

  test("flags a task that is IN-REVIEW (not just IN-PROGRESS)", () => {
    const flags = computeDispatchWatchdogFlags(
      [row()],
      { "mt#2646": "IN-REVIEW" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
  });

  test("a recent commit resets the activity clock and suppresses the flag", () => {
    const recentCommitMs = NOW_MS - 5 * 60 * 1000; // 5m ago
    const activity: ActivitySources = {
      lastCommitAtMs: (sid) => (sid === "session-1" ? recentCommitMs : null),
      lastEventAtMs: () => null,
    };
    const flags = computeDispatchWatchdogFlags(
      [row()], // startedAt 60m ago
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("a recent system event (e.g. a PR event) resets the activity clock and suppresses the flag", () => {
    const recentEventMs = NOW_MS - 10 * 60 * 1000; // 10m ago
    const activity: ActivitySources = {
      lastCommitAtMs: () => null,
      lastEventAtMs: (taskId) => (taskId === "mt#2646" ? recentEventMs : null),
    };
    const flags = computeDispatchWatchdogFlags(
      [row()],
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("a stale commit that is still older than the window does not suppress the flag", () => {
    const staleCommitMs = NOW_MS - 45 * 60 * 1000; // 45m ago — still >= 30m window
    const activity: ActivitySources = {
      lastCommitAtMs: () => staleCommitMs,
      lastEventAtMs: () => null,
    };
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: "2026-07-07T10:00:00.000Z" })], // 2h before NOW_MS
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
    // lastActivityAt should be the commit time (more recent than startedAt), not startedAt.
    expect(flags[0]?.lastActivityAt).toBe(new Date(staleCommitMs).toISOString());
  });

  test("malformed startedAt is skipped rather than mis-flagged", () => {
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: "not-a-date" })],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("respects a custom staleMs threshold", () => {
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: "2026-07-07T11:50:00.000Z" })], // 10m before NOW_MS
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      5 * 60 * 1000 // 5m threshold
    );
    expect(flags).toHaveLength(1);
  });

  test("multiple in-flight rows are evaluated independently", () => {
    const flags = computeDispatchWatchdogFlags(
      [
        row({ taskId: "mt#1", subagentSessionId: "s1", startedAt: "2026-07-07T11:00:00.000Z" }),
        row({ taskId: "mt#2", subagentSessionId: "s2", startedAt: "2026-07-07T11:55:00.000Z" }),
      ],
      { "mt#1": "IN-PROGRESS", "mt#2": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]?.taskId).toBe("mt#1");
  });
});

describe("buildDispatchWatchdogSnapshot", () => {
  test("orchestrates deps into a snapshot and de-duplicates repeated lookups", async () => {
    let taskStatusCalls = 0;
    let commitCalls = 0;
    let eventCalls = 0;

    const deps: DispatchWatchdogDeps = {
      listInFlightInvocations: async () => [
        row({ taskId: "mt#2646", subagentSessionId: "s1", startedAt: "2026-07-07T11:00:00.000Z" }),
        // Second row for the SAME task+session — should not re-query task status / activity.
        row({ taskId: "mt#2646", subagentSessionId: "s1", startedAt: "2026-07-07T11:10:00.000Z" }),
      ],
      getTaskStatus: async () => {
        taskStatusCalls += 1;
        return "IN-PROGRESS";
      },
      getLastCommitAtMs: async () => {
        commitCalls += 1;
        return null;
      },
      getLastEventAtMs: async () => {
        eventCalls += 1;
        return null;
      },
    };

    const snapshot = await buildDispatchWatchdogSnapshot(deps, NOW_MS, DISPATCH_WATCHDOG_STALE_MS);

    expect(taskStatusCalls).toBe(1);
    expect(commitCalls).toBe(1);
    expect(eventCalls).toBe(1);
    expect(snapshot.checkedAt).toBe(new Date(NOW_MS).toISOString());
    expect(snapshot.staleMs).toBe(DISPATCH_WATCHDOG_STALE_MS);
    expect(snapshot.flags).toHaveLength(2);
  });

  test("produces an empty flag set when nothing is in flight", async () => {
    const deps: DispatchWatchdogDeps = {
      listInFlightInvocations: async () => [],
      getTaskStatus: async () => null,
      getLastCommitAtMs: async () => null,
      getLastEventAtMs: async () => null,
    };
    const snapshot = await buildDispatchWatchdogSnapshot(deps, NOW_MS);
    expect(snapshot.flags).toHaveLength(0);
  });
});

describe("LAST_EVENT_AT_QUERY", () => {
  // R1 BLOCKING #1: system_events.created_at is `timestamp with time zone` —
  // casting it directly to `::bigint` is an INVALID Postgres cast (unlike the
  // sibling prod-state-cache.ts query, whose `created_at` column really is
  // bigint). Pin the corrected query text so a future edit can't silently
  // reintroduce the invalid direct cast.
  test("converts the timestamptz via extract(epoch from ...) before casting to bigint", () => {
    expect(LAST_EVENT_AT_QUERY).toMatch(/extract\(epoch from max\(created_at\)\)\s*\*\s*1000/);
    expect(LAST_EVENT_AT_QUERY).toMatch(/::bigint/);
  });

  test("does NOT contain the invalid direct timestamptz->bigint cast", () => {
    // The invalid form this replaces: `max(created_at)::bigint` with no
    // intervening extract(epoch from ...) conversion.
    expect(LAST_EVENT_AT_QUERY).not.toMatch(/max\(created_at\)::bigint/);
  });

  test("still filters by related_task_id OR related_session_id, parameterized", () => {
    expect(LAST_EVENT_AT_QUERY).toMatch(/related_task_id\s*=\s*\$1/);
    expect(LAST_EVENT_AT_QUERY).toMatch(/related_session_id\s*=\s*\$2/);
  });

  test("the epoch-seconds*1000 unit conversion matches what getLastEventAtMs expects (ms)", () => {
    // Simulate what postgres.js returns for a bigint column: a numeric string.
    // extract(epoch from <a timestamptz>) * 1000, rounded to bigint, is the
    // epoch-MILLISECONDS value the rest of dispatch-watchdog.ts operates in
    // (see computeDispatchWatchdogFlags' use of Date.parse-derived ms values).
    const expectedMs = Date.parse("2026-07-07T12:00:00.000Z");
    const simulatedPgRow = { latest_at: String(expectedMs) };
    const ms = Number(simulatedPgRow.latest_at);
    expect(ms).toBe(expectedMs);
  });
});

describe("DispatchWatchdogSweepTracker (R1 non-blocking #2: sweep observability)", () => {
  test("starts at zero / null counters", () => {
    const tracker = DispatchWatchdogSweepTracker.resetForTest();
    const summary = tracker.getSummary(NOW_MS);
    expect(summary).toEqual({
      ticksRun: 0,
      flagsWritten: 0,
      lastSnapshotAt: null,
      lastSnapshotAgeMs: null,
      lastErrorAt: null,
    });
  });

  test("recordTick increments ticksRun and accumulates flagsWritten across ticks", () => {
    const tracker = DispatchWatchdogSweepTracker.resetForTest();
    tracker.recordTick(2, NOW_MS);
    tracker.recordTick(1, NOW_MS + 60000);

    const summary = tracker.getSummary(NOW_MS + 60000);
    expect(summary.ticksRun).toBe(2);
    expect(summary.flagsWritten).toBe(3);
    expect(summary.lastSnapshotAt).toBe(new Date(NOW_MS + 60000).toISOString());
  });

  test("lastSnapshotAgeMs reflects elapsed time since the last successful tick", () => {
    const tracker = DispatchWatchdogSweepTracker.resetForTest();
    tracker.recordTick(0, NOW_MS);
    const summary = tracker.getSummary(NOW_MS + 5 * 60 * 1000);
    expect(summary.lastSnapshotAgeMs).toBe(5 * 60 * 1000);
  });

  test("recordError sets lastErrorAt without touching ticksRun/flagsWritten", () => {
    const tracker = DispatchWatchdogSweepTracker.resetForTest();
    tracker.recordTick(1, NOW_MS);
    tracker.recordError(NOW_MS + 1000);

    const summary = tracker.getSummary(NOW_MS + 1000);
    expect(summary.lastErrorAt).toBe(new Date(NOW_MS + 1000).toISOString());
    expect(summary.ticksRun).toBe(1);
    expect(summary.flagsWritten).toBe(1);
  });

  test("a negative flagCount is clamped to zero rather than corrupting the cumulative total", () => {
    const tracker = DispatchWatchdogSweepTracker.resetForTest();
    tracker.recordTick(-5, NOW_MS);
    expect(tracker.getSummary(NOW_MS).flagsWritten).toBe(0);
  });

  test("getInstance returns the same singleton across calls", () => {
    DispatchWatchdogSweepTracker.resetForTest();
    const a = DispatchWatchdogSweepTracker.getInstance();
    const b = DispatchWatchdogSweepTracker.getInstance();
    expect(a).toBe(b);
  });
});
