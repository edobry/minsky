import { describe, test, expect } from "bun:test";
import {
  computeDispatchWatchdogFlags,
  buildDispatchWatchdogSnapshot,
  DISPATCH_WATCHDOG_STALE_MS,
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
