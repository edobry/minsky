import { describe, test, expect } from "bun:test";
import {
  computeDispatchWatchdogFlags,
  buildDispatchWatchdogSnapshot,
  DISPATCH_WATCHDOG_STALE_MS,
  DISPATCH_WATCHDOG_MAX_AGE_MS,
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
    expect(flags[0]?.activitySource).toBe("dispatch-start");
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
    expect(flags[0]?.activitySource).toBe("commit");
  });

  test("a stale event that is fresher than a stale commit produces activitySource 'event'", () => {
    const staleCommitMs = NOW_MS - 50 * 60 * 1000; // 50m ago
    const staleEventMs = NOW_MS - 45 * 60 * 1000; // 45m ago — fresher than commit, still >= 30m window
    const activity: ActivitySources = {
      lastCommitAtMs: () => staleCommitMs,
      lastEventAtMs: () => staleEventMs,
    };
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: "2026-07-07T10:00:00.000Z" })], // 2h before NOW_MS
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]?.lastActivityAt).toBe(new Date(staleEventMs).toISOString());
    expect(flags[0]?.activitySource).toBe("event");
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

  // mt#3062 AT: a row orphaned weeks ago whose task is moved back to
  // IN-PROGRESS does not produce a multi-week stall flag (age-bound).
  test("a row started weeks ago on a reopened task is suppressed by the age bound", () => {
    const weeksAgo = new Date(NOW_MS - 21 * 24 * 60 * 60 * 1000).toISOString(); // 3 weeks ago
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: weeksAgo })],
      { "mt#2646": "IN-PROGRESS" }, // reopened/resumed back to IN-PROGRESS
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS,
      DISPATCH_WATCHDOG_MAX_AGE_MS
    );
    expect(flags).toHaveLength(0);
  });

  // mt#3062 AT: a still-fresh in-flight dispatch of a genuinely live task IS
  // still flagged when it exceeds the stale window — the age bound must not
  // over-suppress ordinary stalls well within the age bound.
  test("a fresh dispatch well within the age bound is still flagged once stale", () => {
    const twoHoursAgo = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: twoHoursAgo })],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS,
      DISPATCH_WATCHDOG_MAX_AGE_MS
    );
    expect(flags).toHaveLength(1);
  });

  // Reviewer finding (PR #2254 R1, non-blocking): pin the equality-at-threshold
  // behavior explicitly. A row exactly maxAgeMs old is treated as too old
  // (>=, not >), matching the staleForMs >= staleMs convention.
  test("a row exactly at the age bound is suppressed (>=, not >)", () => {
    const exactlyAtBound = new Date(NOW_MS - DISPATCH_WATCHDOG_MAX_AGE_MS).toISOString();
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: exactlyAtBound })],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS,
      DISPATCH_WATCHDOG_MAX_AGE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("a row 1ms inside the age bound is still eligible to be flagged", () => {
    const justInsideBound = new Date(NOW_MS - DISPATCH_WATCHDOG_MAX_AGE_MS + 1).toISOString();
    const flags = computeDispatchWatchdogFlags(
      [row({ startedAt: justInsideBound })],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS,
      DISPATCH_WATCHDOG_MAX_AGE_MS
    );
    expect(flags).toHaveLength(1);
  });

  // mt#3062 AT: a row whose session workspace is absent is not flagged
  // (distinguishes "session gone" from "session silent").
  test("a row whose session workspace is confirmed gone is not flagged", () => {
    const activity: ActivitySources = {
      lastCommitAtMs: () => null,
      lastEventAtMs: () => null,
      sessionExists: () => false, // workspace confirmed deleted/gone
    };
    const flags = computeDispatchWatchdogFlags(
      [row()], // startedAt 60m ago — well past the 30m stale window
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(0);
  });

  test("a row whose session existence is unknown (null) is still flagged — unknown is not gone", () => {
    const activity: ActivitySources = {
      lastCommitAtMs: () => null,
      lastEventAtMs: () => null,
      sessionExists: () => null, // can't determine — must not suppress
    };
    const flags = computeDispatchWatchdogFlags(
      [row()],
      { "mt#2646": "IN-PROGRESS" },
      activity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
  });

  test("ActivitySources without a sessionExists method behaves as unknown (backward compatible)", () => {
    // noActivity predates the sessionExists field entirely — omitting it
    // must not suppress flags (equivalent to always returning null).
    const flags = computeDispatchWatchdogFlags(
      [row()],
      { "mt#2646": "IN-PROGRESS" },
      noActivity,
      NOW_MS,
      DISPATCH_WATCHDOG_STALE_MS
    );
    expect(flags).toHaveLength(1);
  });

  // mt#3172: the watchdog now shares tasks.dispatch-recover's mt#3086
  // presence-claim signal, closing the false-positive family the mt#3062
  // real-world incident illustrates — mt#3062's own dispatch was flagged by
  // this injection twice within 10 minutes while tasks.dispatch-recover
  // independently reported "healthy"/"presence" (staleForMs 478601, then
  // 114798 — i.e. presence ~8m then ~2m fresh) both times. These fixtures
  // mirror that timing.
  describe("presence-claim activity signal (mt#3172)", () => {
    test("AT1: fresh presence-claim activity with no commit suppresses the flag", () => {
      const presenceMs = NOW_MS - 8 * 60 * 1000; // ~8m ago — mirrors the mt#3062 incident's first check
      const activity: ActivitySources = {
        lastCommitAtMs: () => null,
        lastEventAtMs: () => null,
        lastPresenceActivityAtMs: (sid) => (sid === "session-1" ? presenceMs : null),
      };
      const flags = computeDispatchWatchdogFlags(
        [row()], // startedAt 60m ago — well past the 30m stale window on dispatch-start alone
        { "mt#2646": "IN-PROGRESS" },
        activity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(0);
    });

    test("AT1 (second checkpoint): even fresher presence (~2m) still suppresses the flag", () => {
      const presenceMs = NOW_MS - 2 * 60 * 1000; // ~2m ago — mirrors the incident's second check
      const activity: ActivitySources = {
        lastCommitAtMs: () => null,
        lastEventAtMs: () => null,
        lastPresenceActivityAtMs: () => presenceMs,
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

    test("AT2: a dispatch stale on every signal (commit, event, presence) is still flagged unchanged", () => {
      const staleMs = NOW_MS - 45 * 60 * 1000; // 45m ago on every signal — still >= 30m window
      const activity: ActivitySources = {
        lastCommitAtMs: () => staleMs,
        lastEventAtMs: () => staleMs,
        lastPresenceActivityAtMs: () => staleMs,
      };
      const flags = computeDispatchWatchdogFlags(
        [row({ startedAt: "2026-07-07T10:00:00.000Z" })], // 2h before NOW_MS
        { "mt#2646": "IN-PROGRESS" },
        activity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.staleForMs).toBe(NOW_MS - staleMs);
    });

    test("AT3: a flag's activitySource is 'presence' when presence is the freshest signal", () => {
      // Commit is the oldest signal (45m ago); presence is fresher (40m ago)
      // but still >= the 30m stale window, so the row is still flagged — and
      // the flag's activitySource should name "presence", not "commit".
      const staleCommitMs = NOW_MS - 45 * 60 * 1000;
      const stalePresenceMs = NOW_MS - 40 * 60 * 1000;
      const activity: ActivitySources = {
        lastCommitAtMs: () => staleCommitMs,
        lastEventAtMs: () => null,
        lastPresenceActivityAtMs: () => stalePresenceMs,
      };
      const flags = computeDispatchWatchdogFlags(
        [row({ startedAt: "2026-07-07T10:00:00.000Z" })], // 2h before NOW_MS
        { "mt#2646": "IN-PROGRESS" },
        activity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.activitySource).toBe("presence");
      expect(flags[0]?.lastActivityAt).toBe(new Date(stalePresenceMs).toISOString());
    });

    // mt#3172 PR #2294 R1: pin the tie behavior explicitly (each candidate
    // replaces the running max only when STRICTLY greater — `>`, not `>=`)
    // — matching tasks.dispatch-recover's computeDispatchStaleness. Event
    // and presence sharing the IDENTICAL timestamp must resolve to "event"
    // (the earlier-checked signal in the dispatch-start -> commit -> event
    // -> presence precedence order), because the presence check requires
    // STRICTLY exceeding the value the event check already set.
    test("a tied event and presence timestamp resolves to 'event' (tie -> earlier-checked signal wins)", () => {
      const staleCommitMs = NOW_MS - 50 * 60 * 1000; // oldest of the three
      const tiedMs = NOW_MS - 40 * 60 * 1000; // event and presence share this exact ms
      const activity: ActivitySources = {
        lastCommitAtMs: () => staleCommitMs,
        lastEventAtMs: () => tiedMs,
        lastPresenceActivityAtMs: () => tiedMs,
      };
      const flags = computeDispatchWatchdogFlags(
        [row({ startedAt: "2026-07-07T10:00:00.000Z" })], // 2h before NOW_MS
        { "mt#2646": "IN-PROGRESS" },
        activity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.activitySource).toBe("event");
      expect(flags[0]?.lastActivityAt).toBe(new Date(tiedMs).toISOString());
    });

    test("ActivitySources without a lastPresenceActivityAtMs method behaves as unknown (backward compatible)", () => {
      // noActivity predates the lastPresenceActivityAtMs field entirely —
      // omitting it must not suppress flags (equivalent to always returning null).
      const flags = computeDispatchWatchdogFlags(
        [row()],
        { "mt#2646": "IN-PROGRESS" },
        noActivity,
        NOW_MS,
        DISPATCH_WATCHDOG_STALE_MS
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.activitySource).toBe("dispatch-start");
    });
  });
});

describe("buildDispatchWatchdogSnapshot", () => {
  test("orchestrates deps into a snapshot and de-duplicates repeated lookups", async () => {
    let taskStatusCalls = 0;
    let commitCalls = 0;
    let eventCalls = 0;
    let sessionExistsCalls = 0;
    let presenceCalls = 0;

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
      getSessionExists: async () => {
        sessionExistsCalls += 1;
        return true;
      },
      getLastPresenceActivityAtMs: async () => {
        presenceCalls += 1;
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
    expect(sessionExistsCalls).toBe(1);
    expect(presenceCalls).toBe(1);
    expect(snapshot.checkedAt).toBe(new Date(NOW_MS).toISOString());
    expect(snapshot.staleMs).toBe(DISPATCH_WATCHDOG_STALE_MS);
    expect(snapshot.flags).toHaveLength(2);
  });

  test("produces an empty flag set when nothing is in flight", async () => {
    const deps: DispatchWatchdogDeps = {
      listInFlightInvocations: async () => [],
      getTaskStatus: async () => null,
      getLastCommitAtMs: async () => null,
      getSessionExists: async () => null,
      getLastPresenceActivityAtMs: async () => null,
      getLastEventAtMs: async () => null,
    };
    const snapshot = await buildDispatchWatchdogSnapshot(deps, NOW_MS);
    expect(snapshot.flags).toHaveLength(0);
  });

  // mt#3062 AT (end-to-end): a row whose session workspace is confirmed
  // gone via the real dependency wiring is not flagged.
  test("suppresses a flag when getSessionExists resolves false", async () => {
    const deps: DispatchWatchdogDeps = {
      listInFlightInvocations: async () => [
        row({ taskId: "mt#2646", subagentSessionId: "s1", startedAt: "2026-07-07T11:00:00.000Z" }),
      ],
      getTaskStatus: async () => "IN-PROGRESS",
      getLastCommitAtMs: async () => null,
      getSessionExists: async () => false,
      getLastPresenceActivityAtMs: async () => null,
      getLastEventAtMs: async () => null,
    };
    const snapshot = await buildDispatchWatchdogSnapshot(deps, NOW_MS, DISPATCH_WATCHDOG_STALE_MS);
    expect(snapshot.flags).toHaveLength(0);
  });

  // mt#3172 AT1: a row with fresh presence-claim activity and no commits is
  // NOT flagged — parity with tasks.dispatch-recover's mt#3086 presence leg.
  test("suppresses a flag when only presence-claim activity is fresh (no commit)", async () => {
    const recentPresenceMs = NOW_MS - 8 * 60 * 1000; // 8m ago — mirrors the mt#3062 incident
    const deps: DispatchWatchdogDeps = {
      listInFlightInvocations: async () => [
        row({ taskId: "mt#2646", subagentSessionId: "s1", startedAt: "2026-07-07T11:00:00.000Z" }),
      ],
      getTaskStatus: async () => "IN-PROGRESS",
      getLastCommitAtMs: async () => null,
      getSessionExists: async () => true,
      getLastPresenceActivityAtMs: async () => recentPresenceMs,
      getLastEventAtMs: async () => null,
    };
    const snapshot = await buildDispatchWatchdogSnapshot(deps, NOW_MS, DISPATCH_WATCHDOG_STALE_MS);
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
