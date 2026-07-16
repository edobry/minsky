/**
 * GuardHealthTracker unit tests (mt#2812)
 *
 * Verifies:
 * - computeGuardHealthSummary's pure aggregation (streak/escalation math),
 *   mirroring the parallel implementation in
 *   .minsky/hooks/guard-health.ts (kept in sync manually, per that module's
 *   header comment on the cross-boundary duplication rationale).
 * - getSummary() reads a REAL on-disk JSONL log and aggregates correctly
 *   (round-trip against a temp fixture file).
 * - Fail-safe: a missing/unreadable log degrades to the zero-filled summary,
 *   never throws (mt#2812 acceptance test: "Tracker DB/log unavailable ->
 *   guards still run normally").
 *
 * Uses real filesystem operations against a temp directory — this tests the
 * tracker's actual on-disk read behavior, the same rationale
 * disconnect-tracker.test.ts documents for its own real-fs suites.
 */
/* eslint-disable custom/no-real-fs-in-tests */

import { describe, test, expect, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  GuardHealthTracker,
  computeGuardHealthSummary,
  ATTENTION_STREAK_THRESHOLD,
  CRITICAL_STREAK_THRESHOLD,
  type GuardHealthEvent,
} from "./guard-health-tracker";

function makeTempLogPath(name: string): string {
  return path.join(os.tmpdir(), `mt2812-guard-health-tracker-test-${name}-${Date.now()}.jsonl`);
}

function makeEvent(overrides: Partial<GuardHealthEvent> & { timestamp: string }): GuardHealthEvent {
  return {
    guardName: "test-guard",
    event: "PreToolUse",
    kind: "error",
    message: "boom",
    ...overrides,
  };
}

function appendLine(logPath: string, event: GuardHealthEvent): void {
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

const cleanupPaths: string[] = [];
afterEach(() => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  GuardHealthTracker.resetForTest();
});

// ---------------------------------------------------------------------------
// computeGuardHealthSummary — pure aggregation
// ---------------------------------------------------------------------------

describe("computeGuardHealthSummary", () => {
  test("no events -> escalation none", () => {
    const summary = computeGuardHealthSummary([]);
    expect(summary.escalation).toBe("none");
    expect(Object.keys(summary.byGuard).length).toBe(0);
  });

  test(`streak > ATTENTION_STREAK_THRESHOLD (${ATTENTION_STREAK_THRESHOLD}) -> attention`, () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const summary = computeGuardHealthSummary(
      [
        makeEvent({ timestamp: "2026-07-14T10:00:00.000Z" }),
        makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }),
      ],
      now
    );
    expect(summary.byGuard["test-guard"]?.escalation).toBe("attention");
    expect(summary.escalation).toBe("attention");
  });

  test(`streak > CRITICAL_STREAK_THRESHOLD (${CRITICAL_STREAK_THRESHOLD}) -> critical (mt#2812 spec calibration)`, () => {
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
    expect(summary.criticalGuards).toEqual(["test-guard"]);
    expect(summary.escalation).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// GuardHealthTracker — real on-disk read+aggregate
// ---------------------------------------------------------------------------

describe("GuardHealthTracker.getSummary (real fs)", () => {
  test("reads a real JSONL fixture file and aggregates to critical after 3 consecutive errors", () => {
    const logPath = makeTempLogPath("critical");
    cleanupPaths.push(logPath);
    appendLine(logPath, makeEvent({ timestamp: "2026-07-14T09:00:00.000Z" }));
    appendLine(logPath, makeEvent({ timestamp: "2026-07-14T10:00:00.000Z" }));
    appendLine(logPath, makeEvent({ timestamp: "2026-07-14T11:00:00.000Z" }));

    const tracker = GuardHealthTracker.resetForTest(logPath);
    const summary = tracker.getSummary(new Date("2026-07-14T12:00:00.000Z"));
    expect(summary.escalation).toBe("critical");
    expect(summary.criticalGuards).toEqual(["test-guard"]);
  });

  test("skips malformed lines in the real file without throwing", () => {
    const logPath = makeTempLogPath("malformed");
    cleanupPaths.push(logPath);
    fs.appendFileSync(
      logPath,
      `${JSON.stringify(makeEvent({ timestamp: "2026-07-14T10:00:00.000Z" }))}\nnot json\n`
    );
    const tracker = GuardHealthTracker.resetForTest(logPath);
    const summary = tracker.getSummary(new Date("2026-07-14T12:00:00.000Z"));
    expect(summary.byGuard["test-guard"]?.consecutiveStreak).toBe(1);
  });

  test("missing log file -> zero-filled summary (tracker/log unavailable, mt#2812 acceptance test)", () => {
    const logPath = makeTempLogPath("missing");
    // Deliberately never created — exercise the missing-file path.
    const tracker = GuardHealthTracker.resetForTest(logPath);
    expect(() => tracker.getSummary()).not.toThrow();
    const summary = tracker.getSummary();
    expect(summary).toEqual({
      byGuard: {},
      criticalGuards: [],
      attentionGuards: [],
      escalation: "none",
    });
  });

  test("getInstance() returns a stable singleton", () => {
    const a = GuardHealthTracker.getInstance();
    const b = GuardHealthTracker.getInstance();
    expect(a).toBe(b);
  });
});
