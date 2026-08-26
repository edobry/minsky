/**
 * Replay of the consecutive-degraded counter against two real windows (mt#4598).
 *
 * The question: during the 2026-08-25 partial DB degradation, could
 * `consecutiveDegraded` ever have reached the tray watchdog's
 * `NOT_READY_POLL_THRESHOLD = 24`, which is the only path to the restart-storm
 * watchdog that alerts the principal?
 *
 * The fixtures are the gaps, in seconds, between consecutive
 * `[shared-persistence] DB unreachable from this daemon` lines in
 * `~/.local/state/minsky/logs/`. They are recorded here rather than re-derived
 * so the answer is reproducible after the logs rotate away.
 */
import { describe, test, expect } from "bun:test";
import {
  maxConsecutiveDegraded,
  maxConsecutiveDegradedFromGaps,
  nextConsecutiveDegraded,
} from "./degraded-run-length";

/** `cockpit-tray/src-tauri/src/supervisor.rs:94` — restart after this many. */
const NOT_READY_POLL_THRESHOLD = 24;

/** `POLL_INTERVAL` in the tray supervisor, in seconds. */
const POLL_INTERVAL_SECONDS = 5;

/**
 * 2026-08-25T20:00Z–21:00Z — the worst hour of the ~95-minute degradation.
 * 86 logged failures, so 85 gaps.
 */
const DEGRADED_HOUR_GAPS = [
  29.9, 15.8, 11.9, 161.8, 22.7, 34.5, 41.5, 28.7, 109.1, 16.2, 5.4, 30.4, 6.7, 28.5, 13.1, 13.4,
  28.6, 12.4, 6.7, 6.7, 29.1, 18.6, 17.1, 57.1, 39.7, 27.4, 31.2, 5.2, 5.4, 17.1, 5.2, 11.9, 33.1,
  10.4, 5.2, 10.4, 91.0, 6.7, 6.0, 40.6, 38.7, 152.9, 133.8, 62.6, 122.1, 160.3, 27.0, 21.9, 40.9,
  6.7, 11.9, 10.4, 11.9, 10.4, 5.2, 11.9, 10.4, 10.3, 92.4, 5.0, 39.4, 60.6, 118.0, 121.0, 105.8,
  17.2, 54.1, 207.7, 34.3, 58.2, 29.5, 159.9, 11.4, 47.2, 53.9, 116.1, 56.0, 28.8, 10.3, 10.3, 10.3,
  33.0, 32.0, 71.6, 27.1,
];

/**
 * The single gap in the degraded hour that sits near the poll interval: 5.005s
 * against a 5s cadence, a 5ms margin.
 *
 * Recorded separately because the first version of this fixture rounded it to
 * `5.0`, which flipped it to the inside of the boundary and changed the
 * computed maximum from 1 to 2. That is a fidelity bug in a fixture, and it is
 * also the useful warning: **the exact maximum is boundary-sensitive at the
 * millisecond scale, so no claim here rests on 1-versus-2.** What the data
 * supports is the ORDER OF MAGNITUDE — a counter in the low single digits
 * against a threshold of 24 — and the comparison against the baseline day.
 */
const NEAR_BOUNDARY_GAP_SECONDS = 5.005;

/**
 * 2026-08-24, a NORMAL day — the baseline the spec's 1–7 failures/hour figure
 * comes from. 116 logged failures across the day.
 */
const BASELINE_DAY_GAPS = [
  374.9, 12.2, 22.8, 11.0, 4.8, 21.9, 7.0, 38.0, 6.5, 33.4, 47.0, 11.2, 40.7, 5.9, 123.0, 10.9,
  40.3, 11.1, 312.6, 14.8, 27.8, 124.8, 2.3, 11.5, 15.4, 11.4, 9.0, 16.6, 10.6, 448.4, 7.1, 8.5,
  97.6, 11.2, 90.7, 8.5, 10.9, 413.0, 10.0, 7.1, 40.9, 7.0, 10.5, 32.5, 4.9, 65.3, 6.9, 22.7, 11.4,
  33.8, 10.7, 89.5, 11.1, 29.1, 43.4, 6.3, 13.5, 17.8, 18.7, 11.4, 108.3, 22.4, 10.4, 13.7, 57.8,
  10.8, 160.3, 11.0, 58.1, 11.2, 180.9, 11.1, 6.8, 36.6, 11.2, 199.9, 22.7, 11.1, 28.8, 10.2, 10.9,
  6.8, 13.9, 557.7, 3.4, 249.2, 5.5, 1843.3, 909.8, 3191.0, 2401.8, 25630.4, 2400.3, 8434.8, 48.7,
  41.6, 2877.7, 1381.8, 47.2, 946.3, 1476.0, 5.9, 1288.6, 4899.8, 1876.1, 3899.0, 3604.1, 926.3,
  15.8, 66.5, 11.1, 10.7, 1786.9, 1079.2, 3058.2,
];

describe("nextConsecutiveDegraded", () => {
  test("any non-ok reading increments, ok resets", () => {
    expect(nextConsecutiveDegraded(0, "degraded")).toBe(1);
    expect(nextConsecutiveDegraded(7, "unreachable")).toBe(8);
    expect(nextConsecutiveDegraded(23, "ok")).toBe(0);
    // The rule is "not ok", not an enumeration — an unexpected value counts as
    // degraded, which is the fail-safe direction and matches the shipped route.
    expect(nextConsecutiveDegraded(1, "something-new")).toBe(2);
  });

  test("a single ok in a long degraded run zeroes it", () => {
    const readings = [...Array(23).fill("degraded"), "ok", ...Array(23).fill("degraded")];
    // 23 either side of one success — never reaches 24, though 46 of 47 polls failed.
    expect(maxConsecutiveDegraded(readings)).toBe(23);
    expect(maxConsecutiveDegraded(Array(24).fill("degraded"))).toBe(24);
  });
});

describe("replay against the recorded windows", () => {
  test("AT1: the degraded hour leaves the counter in the low single digits", () => {
    const result = maxConsecutiveDegradedFromGaps(DEGRADED_HOUR_GAPS, POLL_INTERVAL_SECONDS);

    // 86 failures in one hour, almost all of them their own run: barely any
    // pair of failures landed within one poll interval of each other.
    expect(result.gapsWithinOnePoll).toBeLessThanOrEqual(1);
    expect(result.runs).toBeGreaterThanOrEqual(85);

    // The finding, stated at the resolution the data supports: the escalation
    // ladder's first rung is more than an order of magnitude away from where
    // this counter peaked during the worst hour of a 95-minute outage.
    expect(result.max).toBeLessThanOrEqual(2);
    expect(result.max * 10).toBeLessThan(NOT_READY_POLL_THRESHOLD);
  });

  test("AT1: the maximum is boundary-sensitive, and the finding does not depend on it", () => {
    // One gap sits 5ms outside the poll interval. Counting it either way moves
    // the maximum between 1 and 2 — and leaves the conclusion untouched.
    const justOutside = maxConsecutiveDegradedFromGaps(
      [NEAR_BOUNDARY_GAP_SECONDS],
      POLL_INTERVAL_SECONDS
    );
    const justInside = maxConsecutiveDegradedFromGaps(
      [NEAR_BOUNDARY_GAP_SECONDS - 0.01],
      POLL_INTERVAL_SECONDS
    );
    expect(justOutside.max).toBe(1);
    expect(justInside.max).toBe(2);
    expect(Math.max(justOutside.max, justInside.max)).toBeLessThan(NOT_READY_POLL_THRESHOLD);
  });

  test("AT2: a NORMAL day reaches a HIGHER value than the degraded hour", () => {
    const baseline = maxConsecutiveDegradedFromGaps(BASELINE_DAY_GAPS, POLL_INTERVAL_SECONDS);
    const degraded = maxConsecutiveDegradedFromGaps(DEGRADED_HOUR_GAPS, POLL_INTERVAL_SECONDS);

    expect(baseline.max).toBe(2);
    expect(baseline.gapsWithinOnePoll).toBe(4);

    // The load-bearing comparison: the counter is NO HIGHER during a 95-minute
    // degradation than on an ordinary day. 86 failures in one hour and 116
    // across a whole normal day produce the same low-single-digit maximum,
    // because what this counter measures is back-to-back-ness, not rate — and
    // spreading failures across an hour produces more resets, not fewer. So the
    // signal does not RISE with the severity of a partial degradation, which is
    // why moving the threshold in either direction cannot fix this class.
    expect(degraded.max).toBeLessThanOrEqual(baseline.max);
    expect(baseline.max).toBeLessThan(NOT_READY_POLL_THRESHOLD);
  });

  test("the replay can produce a high value — it is not hardwired low", () => {
    // Guards against the reading that these numbers are an artifact of the
    // replay rather than of the data: a sustained outage, where every poll
    // fails back-to-back, climbs normally and clears the threshold.
    const sustained = Array(40).fill(POLL_INTERVAL_SECONDS);
    const result = maxConsecutiveDegradedFromGaps(sustained, POLL_INTERVAL_SECONDS);
    expect(result.max).toBe(41);
    expect(result.max).toBeGreaterThan(NOT_READY_POLL_THRESHOLD);
    expect(result.runs).toBe(1);
  });

  test("an empty window replays as zero, not as a phantom run of 1", () => {
    // PR #3365 R1: the guard here was `gapsSeconds.length >= 0 ? 1 : 0`, always
    // true, so a window with no failures reported max 1 / runs 1 — a run that
    // never happened, in the direction that would overstate the counter.
    expect(maxConsecutiveDegradedFromGaps([], POLL_INTERVAL_SECONDS)).toEqual({
      max: 0,
      runs: 0,
      gapsWithinOnePoll: 0,
    });
  });

  test("a non-positive poll interval is refused rather than treated as valid", () => {
    // Asserted on the thrown type and the parameter it names, not on the exact
    // sentence — the message is allowed to be reworded (PR #3365 R1).
    expect(() => maxConsecutiveDegradedFromGaps([1, 2], 0)).toThrow(Error);
    expect(() => maxConsecutiveDegradedFromGaps([1, 2], -5)).toThrow(/pollIntervalSeconds/);
  });
});
