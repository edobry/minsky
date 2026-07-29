/**
 * Tests for attention-window cron matching and scheduling — mt#1489.
 */

import { describe, test, expect } from "bun:test";
import { matchesCronNow, shouldWindowFireNow, nextCronFire } from "./cron";

/**
 * Build a Date whose LOCAL wall clock reads exactly y-m-d h:m, in any timezone —
 * which is precisely what the plain local-time constructor does. The previous
 * per-describe copies constructed via Date.UTC and shifted hour/minute back to
 * local, which corrected the clock but not the DAY: under a large offset
 * (TZ=Pacific/Kiritimati, UTC+14, the test-forced-tz CI job) the local date
 * landed one day late, turning the constructed "Sunday" into a Monday (mt#3319).
 */
function makeLocalDate(
  year: number,
  month: number, // 1-indexed
  day: number,
  hour: number,
  minute: number
): Date {
  return new Date(year, month - 1, day, hour, minute, 0);
}

// ---------------------------------------------------------------------------
// matchesCronNow
// ---------------------------------------------------------------------------

describe("matchesCronNow", () => {
  test("matches exact minute and hour on wildcard day/month/dow", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    expect(matchesCronNow("0 16 * * *", now)).toBe(true);
  });

  test("does not match different minute", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 1);
    expect(matchesCronNow("0 16 * * *", now)).toBe(false);
  });

  test("matches weekday range 1-5 on Monday (dow=1)", () => {
    // 2024-04-15 is a Monday
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    expect(matchesCronNow("0 16 * * 1-5", now)).toBe(true);
  });

  test("does not match weekday range 1-5 on Sunday (dow=0)", () => {
    // 2024-04-14 is a Sunday
    const now = makeLocalDate(2024, 4, 14, 16, 0);
    expect(matchesCronNow("0 16 * * 1-5", now)).toBe(false);
  });

  test("matches named DOW abbreviation MON-FRI on Wednesday", () => {
    // 2024-04-17 is a Wednesday (dow=3)
    const now = makeLocalDate(2024, 4, 17, 10, 0);
    expect(matchesCronNow("0 10 * * MON-FRI", now)).toBe(true);
  });

  test("does not match named DOW abbreviation MON-FRI on Saturday", () => {
    // 2024-04-20 is a Saturday (dow=6)
    const now = makeLocalDate(2024, 4, 20, 10, 0);
    expect(matchesCronNow("0 10 * * MON-FRI", now)).toBe(false);
  });

  test("throws on expression with wrong field count", () => {
    const now = new Date();
    expect(() => matchesCronNow("0 16 *", now)).toThrow("5 fields");
  });
});

// ---------------------------------------------------------------------------
// shouldWindowFireNow
// ---------------------------------------------------------------------------

describe("shouldWindowFireNow", () => {
  test("manual schedule never fires on cron tick", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    expect(shouldWindowFireNow({ type: "manual" }, now)).toBe(false);
  });

  test("cron schedule fires when expression matches and no lastFiredAt", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    expect(shouldWindowFireNow({ type: "cron", expr: "0 16 * * *" }, now)).toBe(true);
  });

  test("cron schedule does not fire when expression does not match", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 1);
    expect(shouldWindowFireNow({ type: "cron", expr: "0 16 * * *" }, now)).toBe(false);
  });

  test("cron schedule skips if lastFiredAt is in the same minute", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    const lastFiredAt = makeLocalDate(2024, 4, 15, 16, 0);
    lastFiredAt.setSeconds(30); // same minute, different second
    expect(shouldWindowFireNow({ type: "cron", expr: "0 16 * * *" }, now, lastFiredAt)).toBe(false);
  });

  test("cron schedule fires if lastFiredAt is a different minute", () => {
    const now = makeLocalDate(2024, 4, 15, 16, 0);
    const lastFiredAt = makeLocalDate(2024, 4, 15, 15, 59);
    expect(shouldWindowFireNow({ type: "cron", expr: "0 16 * * *" }, now, lastFiredAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextCronFire
// ---------------------------------------------------------------------------

describe("nextCronFire", () => {
  test("finds the next fire time for a daily-at-16:00 cron", () => {
    const after = makeLocalDate(2024, 4, 15, 15, 30);
    const next = nextCronFire("0 16 * * *", after);
    expect(next).not.toBeNull();
    if (!next) throw new Error("expected non-null");
    expect(next.getHours()).toBe(16);
    expect(next.getMinutes()).toBe(0);
  });

  test("returns null for an expression that never matches in window", () => {
    // 29th of February only occurs in leap years and only once a month.
    // This will not fire in the next 10080 minutes (1 week) from an arbitrary date.
    const after = makeLocalDate(2024, 3, 1, 0, 0);
    const next = nextCronFire("0 0 29 2 *", after, 100);
    expect(next).toBeNull();
  });
});
