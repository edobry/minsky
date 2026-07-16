// Tests for .minsky/hooks/guard-health.ts — mt#2812.
//
// Covers: recording never throws (even on a broken fs seam), the JSONL
// round-trip, and the pure aggregation (computeGuardHealthSummary)'s
// consecutive-streak + escalation logic, per the mt#2812 acceptance tests:
//   - Fault-inject a throwing guard -> log line written; escalation reflects
//     it after N consecutive.
//   - The deploy-surface crash payload replayed 3x -> tracker escalates.
//   - Tracker DB/log unavailable -> summary degrades to zero-filled, never throws.

import { describe, test, expect } from "bun:test";
import {
  recordGuardError,
  recordGuardCheckSkip,
  readGuardHealthEvents,
  computeGuardHealthSummary,
  getGuardHealthSummary,
  getGuardHealthLogPath,
  getGuardHealthStateDir,
  ATTENTION_STREAK_THRESHOLD,
  CRITICAL_STREAK_THRESHOLD,
  STREAK_RESET_GAP_MS,
  type GuardHealthEvent,
  type GuardHealthFsDeps,
} from "./guard-health";

// ---------------------------------------------------------------------------
// In-memory fs fixture
// ---------------------------------------------------------------------------

function makeInMemoryFs(initial?: Record<string, string>): GuardHealthFsDeps & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    existsSync: (p: string) => p in files || Object.keys(files).some((k) => k.startsWith(p)),
    mkdirSync: () => {
      /* no-op — flat in-memory map */
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

const LOG_PATH = "/fake/state/guard-health-log.jsonl";

describe("getGuardHealthStateDir / getGuardHealthLogPath", () => {
  test("honors MINSKY_STATE_DIR override", () => {
    const dir = getGuardHealthStateDir({ MINSKY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv);
    expect(dir).toBe("/custom/state");
    const logPath = getGuardHealthLogPath({
      MINSKY_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv);
    expect(logPath).toBe("/custom/state/guard-health-log.jsonl");
  });

  test("falls back to ~/.local/state/minsky when unset", () => {
    const dir = getGuardHealthStateDir({} as NodeJS.ProcessEnv);
    expect(dir).toContain(".local/state/minsky");
  });
});

describe("recordGuardError", () => {
  test("appends a well-formed JSONL line with guard name, event, error class/message, tool context, timestamp", () => {
    const fs = makeInMemoryFs();
    recordGuardError(
      {
        guardName: "test-guard",
        event: "PreToolUse",
        error: new TypeError("boom"),
        toolName: "Bash",
        sessionId: "sess-1",
      },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-14T00:00:00.000Z") }
    );

    const events = readGuardHealthEvents({ logPath: LOG_PATH, fs });
    expect(events.length).toBe(1);
    const ev = events[0] as GuardHealthEvent;
    expect(ev.guardName).toBe("test-guard");
    expect(ev.event).toBe("PreToolUse");
    expect(ev.kind).toBe("error");
    expect(ev.errorClass).toBe("TypeError");
    expect(ev.message).toBe("boom");
    expect(ev.toolName).toBe("Bash");
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.timestamp).toBe("2026-07-14T00:00:00.000Z");
  });

  test("handles non-Error thrown values", () => {
    const fs = makeInMemoryFs();
    recordGuardError(
      { guardName: "g", event: "UserPromptSubmit", error: "a string was thrown" },
      { logPath: LOG_PATH, fs }
    );
    const events = readGuardHealthEvents({ logPath: LOG_PATH, fs });
    expect(events[0]?.message).toBe("a string was thrown");
    expect(events[0]?.errorClass).toBe("string");
  });

  test("NEVER throws even when the fs seam throws on every call", () => {
    const brokenFs: GuardHealthFsDeps = {
      existsSync: () => {
        throw new Error("fs is down");
      },
      mkdirSync: () => {
        throw new Error("fs is down");
      },
      appendFileSync: () => {
        throw new Error("fs is down");
      },
      readFileSync: () => {
        throw new Error("fs is down");
      },
    };
    expect(() =>
      recordGuardError(
        { guardName: "g", event: "PreToolUse", error: new Error("x") },
        { logPath: LOG_PATH, fs: brokenFs }
      )
    ).not.toThrow();
  });
});

describe("recordGuardCheckSkip", () => {
  test("appends a check-skip event distinct from an error event", () => {
    const fs = makeInMemoryFs();
    recordGuardCheckSkip(
      { guardName: "g", event: "PreToolUse", reason: "upstream fetch unavailable, permitting" },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-14T00:00:00.000Z") }
    );
    const events = readGuardHealthEvents({ logPath: LOG_PATH, fs });
    expect(events[0]?.kind).toBe("check-skip");
    expect(events[0]?.message).toBe("upstream fetch unavailable, permitting");
    expect(events[0]?.errorClass).toBeUndefined();
  });
});

describe("readGuardHealthEvents", () => {
  test("skips malformed lines and returns only valid events", () => {
    const fs = makeInMemoryFs({
      [LOG_PATH]:
        `${JSON.stringify({
          timestamp: "2026-07-14T00:00:00.000Z",
          guardName: "g",
          event: "PreToolUse",
          kind: "error",
          message: "ok",
        })}\n` +
        "not json\n" +
        `${JSON.stringify({ missing: "fields" })}\n`,
    });
    const events = readGuardHealthEvents({ logPath: LOG_PATH, fs });
    expect(events.length).toBe(1);
    expect(events[0]?.guardName).toBe("g");
  });

  test("missing log file returns empty array, does not throw", () => {
    const fs = makeInMemoryFs();
    expect(readGuardHealthEvents({ logPath: LOG_PATH, fs })).toEqual([]);
  });

  test("a fs seam that throws on read degrades to empty array, never throws", () => {
    const brokenFs: GuardHealthFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {},
      readFileSync: () => {
        throw new Error("disk error");
      },
    };
    expect(() => readGuardHealthEvents({ logPath: LOG_PATH, fs: brokenFs })).not.toThrow();
    expect(readGuardHealthEvents({ logPath: LOG_PATH, fs: brokenFs })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeGuardHealthSummary — the pure aggregation core
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<GuardHealthEvent> & { timestamp: string }): GuardHealthEvent {
  return {
    guardName: "test-guard",
    event: "PreToolUse",
    kind: "error",
    message: "boom",
    ...overrides,
  };
}

describe("computeGuardHealthSummary", () => {
  test("no events -> escalation none, empty guard map", () => {
    const summary = computeGuardHealthSummary([]);
    expect(summary.escalation).toBe("none");
    expect(Object.keys(summary.byGuard).length).toBe(0);
    expect(summary.criticalGuards).toEqual([]);
    expect(summary.attentionGuards).toEqual([]);
  });

  test("1 error -> streak 1, escalation none", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" })],
      now
    );
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(1);
    expect(summary.byGuard["test-guard"]?.escalation).toBe("none");
    expect(summary.escalation).toBe("none");
  });

  test(`2 consecutive errors (streak > ATTENTION_STREAK_THRESHOLD=${ATTENTION_STREAK_THRESHOLD}) -> escalation attention`, () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ timestamp: "2026-07-14T10:00:00.000Z" }),
        makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(2);
    expect(summary.byGuard["test-guard"]?.escalation).toBe("attention");
    expect(summary.escalation).toBe("attention");
    expect(summary.attentionGuards).toEqual(["test-guard"]);
    expect(summary.criticalGuards).toEqual([]);
  });

  test(`3 consecutive errors (streak > CRITICAL_STREAK_THRESHOLD=${CRITICAL_STREAK_THRESHOLD}) -> escalation critical (mt#2812 spec's explicit calibration)`, () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ timestamp: "2026-07-14T09:00:00.000Z" }),
        makeEvent({ timestamp: "2026-07-14T10:00:00.000Z" }),
        makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(3);
    expect(summary.byGuard["test-guard"]?.escalation).toBe("critical");
    expect(summary.escalation).toBe("critical");
    expect(summary.criticalGuards).toEqual(["test-guard"]);
  });

  test("the deploy-surface crash payload replayed 3x -> tracker escalates (mt#2812 acceptance test)", () => {
    const now = new Date("2026-07-14T20:00:00.000Z");
    const events: GuardHealthEvent[] = Array.from({ length: 3 }, (_, i) =>
      makeEvent({
        guardName: "require-deploy-verification-before-merge",
        timestamp: new Date(2026, 6, 14, 10 + i).toISOString(),
        errorClass: "TypeError",
        message: "Cannot read properties of undefined (reading 'deployConfig')",
      })
    );
    const summary = computeGuardHealthSummary(events, now);
    expect(summary.escalation).toBe("critical");
    expect(summary.criticalGuards).toEqual(["require-deploy-verification-before-merge"]);
  });

  test("a gap larger than STREAK_RESET_GAP_MS resets the streak", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const farBack = new Date(
      new Date("2026-07-14T11:00:00.000Z").getTime() - STREAK_RESET_GAP_MS - 1000
    ).toISOString();
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ timestamp: farBack }),
        makeEvent({ timestamp: farBack }),
        // isolated recent failure — streak resets, so only 1 counts
        makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(1);
    expect(summary.byGuard["test-guard"]?.escalation).toBe("none");
  });

  test("check-skip events count toward the streak the same as error events", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ kind: "check-skip", timestamp: "2026-07-14T09:00:00.000Z" }),
        makeEvent({ kind: "error", timestamp: "2026-07-14T10:00:00.000Z" }),
        makeEvent({ kind: "check-skip", timestamp: "2026-07-14T11:00:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(3);
    expect(summary.escalation).toBe("critical");
  });

  test("independent guards are tracked separately — one critical does not affect another's count", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ guardName: "guard-a", timestamp: "2026-07-14T09:00:00.000Z" }),
        makeEvent({ guardName: "guard-a", timestamp: "2026-07-14T10:00:00.000Z" }),
        makeEvent({ guardName: "guard-a", timestamp: "2026-07-14T11:00:00.000Z" }),
        makeEvent({ guardName: "guard-b", timestamp: "2026-07-14T11:30:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["guard-a"]?.escalation).toBe("critical");
    expect(summary.byGuard["guard-b"]?.escalation).toBe("none");
    expect(summary.criticalGuards).toEqual(["guard-a"]);
    expect(summary.escalation).toBe("critical");
  });

  test("errorCount24h / errorCount7d window correctly", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }), // within 24h
        makeEvent({ timestamp: "2026-07-10T00:00:00.000Z" }), // within 7d, outside 24h
        makeEvent({ timestamp: "2026-06-01T00:00:00.000Z" }), // outside 7d
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.errorCount24h).toBe(1);
    expect(summary.byGuard["test-guard"]?.errorCount7d).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getGuardHealthSummary — the fail-safe read+aggregate convenience wrapper
// ---------------------------------------------------------------------------

describe("getGuardHealthSummary (fail-safe)", () => {
  test("reads the log fresh from disk and computes the summary end-to-end", () => {
    const fs = makeInMemoryFs();
    recordGuardError(
      { guardName: "g", event: "PreToolUse", error: new Error("1") },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-14T09:00:00.000Z") }
    );
    recordGuardError(
      { guardName: "g", event: "PreToolUse", error: new Error("2") },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-14T10:00:00.000Z") }
    );
    recordGuardError(
      { guardName: "g", event: "PreToolUse", error: new Error("3") },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-14T11:00:00.000Z") }
    );
    const summary = getGuardHealthSummary({
      logPath: LOG_PATH,
      fs,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(summary.escalation).toBe("critical");
  });

  test("tracker/log unavailable (broken fs) -> zero-filled summary, guards run normally (mt#2812 acceptance test)", () => {
    const brokenFs: GuardHealthFsDeps = {
      existsSync: () => {
        throw new Error("fs unavailable");
      },
      mkdirSync: () => {},
      appendFileSync: () => {},
      readFileSync: () => {
        throw new Error("fs unavailable");
      },
    };
    expect(() => getGuardHealthSummary({ logPath: LOG_PATH, fs: brokenFs })).not.toThrow();
    const summary = getGuardHealthSummary({ logPath: LOG_PATH, fs: brokenFs });
    expect(summary).toEqual({
      byGuard: {},
      criticalGuards: [],
      attentionGuards: [],
      escalation: "none",
    });
  });
});
