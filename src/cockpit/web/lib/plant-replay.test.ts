/**
 * plant-replay.ts tests (mt#2600) — window selection, ordering + pacing, and
 * playback due-step selection. All pure functions; no timers, no DOM.
 */
import { describe, test, expect } from "bun:test";
import {
  computeReplayWindow,
  buildReplaySchedule,
  dueSteps,
  isReplayComplete,
  isValidReplayWindow,
  MIN_STEP_MS,
  MAX_STEP_MS,
  type ReplaySpeed,
} from "./plant-replay";
import type { SystemEventRow } from "../hooks/useSystemEvents";

function row(id: string, createdAt: string, eventType = "task.status_changed"): SystemEventRow {
  return { id, eventType, payload: {}, createdAt };
}

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

describe("computeReplayWindow", () => {
  const NOW = Date.parse("2026-07-03T23:40:00Z");

  test("lookback 0 ends the window at now", () => {
    const w = computeReplayWindow(NOW, 0, 5 * 60_000);
    expect(w.until).toBe(new Date(NOW).toISOString());
    expect(w.since).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  test("a positive lookback shifts the window into the past by that amount", () => {
    const w = computeReplayWindow(NOW, 10 * 60_000, 5 * 60_000);
    expect(w.until).toBe(new Date(NOW - 10 * 60_000).toISOString());
    expect(w.since).toBe(new Date(NOW - 15 * 60_000).toISOString());
  });

  test("negative lookback clamps to 0 (never scrub into the future)", () => {
    const w = computeReplayWindow(NOW, -1000, 60_000);
    expect(w.until).toBe(new Date(NOW).toISOString());
  });

  test("zero or negative span clamps to a minimum 1ms window (never inverted/zero-width)", () => {
    const w = computeReplayWindow(NOW, 0, 0);
    expect(Date.parse(w.until) - Date.parse(w.since)).toBe(1);
    const w2 = computeReplayWindow(NOW, 0, -500);
    expect(Date.parse(w2.until) - Date.parse(w2.since)).toBe(1);
  });
});

describe("isValidReplayWindow", () => {
  test("true when since is strictly before until", () => {
    expect(
      isValidReplayWindow({ since: "2026-07-03T23:24:00Z", until: "2026-07-03T23:34:00Z" })
    ).toBe(true);
  });

  test("false when since equals until (zero-width)", () => {
    expect(
      isValidReplayWindow({ since: "2026-07-03T23:24:00Z", until: "2026-07-03T23:24:00Z" })
    ).toBe(false);
  });

  test("false when since is after until (inverted range)", () => {
    expect(
      isValidReplayWindow({ since: "2026-07-03T23:34:00Z", until: "2026-07-03T23:24:00Z" })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering + pacing
// ---------------------------------------------------------------------------

describe("buildReplaySchedule", () => {
  test("orders events oldest-first even when input is most-recent-first (API order)", () => {
    const events = [
      row("3", "2026-07-03T23:33:00Z"),
      row("2", "2026-07-03T23:31:00Z"),
      row("1", "2026-07-03T23:25:00Z"),
    ];
    const schedule = buildReplaySchedule(events, 60);
    expect(schedule.map((s) => s.event.id)).toEqual(["1", "2", "3"]);
  });

  test("the first step always fires at offset 0", () => {
    const events = [row("1", "2026-07-03T23:25:00Z"), row("2", "2026-07-03T23:31:00Z")];
    const schedule = buildReplaySchedule(events, 10);
    expect(schedule[0]?.offsetMs).toBe(0);
  });

  test("offsets are monotonically non-decreasing", () => {
    const events = [
      row("1", "2026-07-03T23:25:00Z"),
      row("2", "2026-07-03T23:27:00Z"),
      row("3", "2026-07-03T23:31:00Z"),
      row("4", "2026-07-03T23:33:00Z"),
    ];
    const schedule = buildReplaySchedule(events, 10);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].offsetMs).toBeGreaterThanOrEqual(schedule[i - 1].offsetMs);
    }
  });

  test("a dense burst (tiny real gap) is clamped up to MIN_STEP_MS, not imperceptible", () => {
    const events = [
      row("1", "2026-07-03T23:25:00.000Z"),
      row("2", "2026-07-03T23:25:00.010Z"), // 10ms real gap
    ];
    const schedule = buildReplaySchedule(events, 1);
    expect(schedule[1]?.offsetMs).toBe(MIN_STEP_MS);
  });

  test("a huge real gap is clamped down to MAX_STEP_MS, not stalling playback for real minutes", () => {
    const events = [
      row("1", "2026-07-03T23:00:00Z"),
      row("2", "2026-07-03T23:30:00Z"), // 30 real minutes
    ];
    const schedule = buildReplaySchedule(events, 1);
    expect(schedule[1]?.offsetMs).toBe(MAX_STEP_MS);
  });

  test("a mid-range gap is scaled by speed with faithful relative timing", () => {
    const events = [
      row("1", "2026-07-03T23:25:00.000Z"),
      row("2", "2026-07-03T23:25:20.000Z"), // 20,000ms real gap
    ];
    const speed: ReplaySpeed = 10;
    const schedule = buildReplaySchedule(events, speed);
    // 20_000 / 10 = 2_000ms, within [MIN_STEP_MS, MAX_STEP_MS] so unclamped.
    expect(schedule[1]?.offsetMs).toBe(2_000);
  });

  test("higher speed compresses the same window into fewer cumulative ms", () => {
    const events = [
      row("1", "2026-07-03T23:00:00Z"),
      row("2", "2026-07-03T23:10:00Z"),
      row("3", "2026-07-03T23:20:00Z"),
    ];
    const slow = buildReplaySchedule(events, 1);
    const fast = buildReplaySchedule(events, 60);
    const slowTotal = slow[slow.length - 1].offsetMs;
    const fastTotal = fast[fast.length - 1].offsetMs;
    expect(fastTotal).toBeLessThanOrEqual(slowTotal);
  });

  test("empty input produces an empty schedule", () => {
    expect(buildReplaySchedule([], 1)).toEqual([]);
  });

  test("a single event produces a single zero-offset step", () => {
    const schedule = buildReplaySchedule([row("1", "2026-07-03T23:25:00Z")], 1);
    expect(schedule).toEqual([{ event: expect.objectContaining({ id: "1" }), offsetMs: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// Playback due-step selection
// ---------------------------------------------------------------------------

describe("dueSteps", () => {
  const schedule = buildReplaySchedule(
    [
      row("1", "2026-07-03T23:25:00.000Z"),
      row("2", "2026-07-03T23:25:20.000Z"), // +2000ms at speed 10
      row("3", "2026-07-03T23:25:40.000Z"), // +2000ms more -> offset 4000ms
    ],
    10
  );

  test("nothing is due before the first offset is reached", () => {
    const result = dueSteps(schedule, -1, 0);
    expect(result.due).toEqual([]);
    expect(result.firedCount).toBe(0);
  });

  test("the first step is due at elapsed=0", () => {
    const result = dueSteps(schedule, 0, 0);
    expect(result.due.map((s) => s.event.id)).toEqual(["1"]);
    expect(result.firedCount).toBe(1);
  });

  test("multiple steps become due in one tick if elapsed jumps past several offsets", () => {
    const result = dueSteps(schedule, 4_000, 0);
    expect(result.due.map((s) => s.event.id)).toEqual(["1", "2", "3"]);
    expect(result.firedCount).toBe(3);
  });

  test("subsequent calls only return NEWLY due steps, using the returned firedCount", () => {
    const first = dueSteps(schedule, 0, 0);
    expect(first.due.map((s) => s.event.id)).toEqual(["1"]);
    const second = dueSteps(schedule, 2_000, first.firedCount);
    expect(second.due.map((s) => s.event.id)).toEqual(["2"]);
    const third = dueSteps(schedule, 2_000, second.firedCount);
    expect(third.due).toEqual([]); // no time has passed since the last check
  });

  test("calling past the end of the schedule returns no further due steps", () => {
    const result = dueSteps(schedule, 1_000_000, schedule.length);
    expect(result.due).toEqual([]);
    expect(result.firedCount).toBe(schedule.length);
  });
});

describe("isReplayComplete", () => {
  const schedule = buildReplaySchedule(
    [row("1", "2026-07-03T23:25:00Z"), row("2", "2026-07-03T23:26:00Z")],
    1
  );

  test("false for an empty schedule (nothing to complete)", () => {
    expect(isReplayComplete([], 0)).toBe(false);
  });

  test("false while firedCount is below the schedule length", () => {
    expect(isReplayComplete(schedule, 1)).toBe(false);
  });

  test("true once every step has fired", () => {
    expect(isReplayComplete(schedule, schedule.length)).toBe(true);
  });
});
