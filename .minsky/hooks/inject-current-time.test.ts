import { describe, expect, it } from "bun:test";
import {
  buildTimeContext,
  reconstructZonedUtcMs,
  TIME_INJECTION_OVERRIDE_ENV,
} from "./inject-current-time";

describe("reconstructZonedUtcMs (mt#2304 R1 — hour=24 rollover)", () => {
  it("treats hour=24 as next-day 00:00 (May 30 24:00 === May 31 00:00)", () => {
    expect(reconstructZonedUtcMs(2026, 5, 30, 24, 0, 0)).toBe(Date.UTC(2026, 4, 31, 0, 0, 0));
  });

  it("handles month rollover (May 31 24:00 === Jun 1 00:00)", () => {
    expect(reconstructZonedUtcMs(2026, 5, 31, 24, 0, 0)).toBe(Date.UTC(2026, 5, 1, 0, 0, 0));
  });

  it("handles year rollover (Dec 31 24:00 === Jan 1 00:00)", () => {
    expect(reconstructZonedUtcMs(2026, 12, 31, 24, 0, 0)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it("leaves normal hours unchanged", () => {
    expect(reconstructZonedUtcMs(2026, 5, 30, 13, 45, 7)).toBe(Date.UTC(2026, 4, 30, 13, 45, 7));
  });
});

// All tests pin timeZone explicitly so the suite is deterministic regardless
// of CI/developer machine timezone (PR #1427 R1 BLOCKING fix).
const UTC = "UTC";

describe("buildTimeContext (mt#2181)", () => {
  it("includes the day of week (UTC)", () => {
    // 2026-05-30 in UTC is Saturday — verified via `date -u`.
    const ctx = buildTimeContext(new Date("2026-05-30T20:39:00Z"), UTC);
    expect(ctx).toContain("Saturday");
  });

  it("includes the ISO date (YYYY-MM-DD) under the given timezone", () => {
    const ctx = buildTimeContext(new Date("2026-05-30T20:39:00Z"), UTC);
    expect(ctx).toContain("2026-05-30");
  });

  it("includes the UTC ISO timestamp regardless of given timezone", () => {
    const ctx = buildTimeContext(new Date("2026-05-30T20:39:00Z"), "America/New_York");
    expect(ctx).toContain("UTC: 2026-05-30T20:39:00Z");
  });

  it("starts with the canonical prefix", () => {
    const ctx = buildTimeContext(new Date(), UTC);
    expect(ctx.startsWith("Current time: ")).toBe(true);
  });

  it("includes a numeric timezone offset (signed, 4-digit)", () => {
    const ctx = buildTimeContext(new Date(), UTC);
    expect(ctx).toMatch(/[+-]\d{4} \(UTC:/);
  });

  it("produces day names for each UTC weekday correctly (sanity)", () => {
    // 2026-05-25 (Mon) through 2026-05-31 (Sun) at noon UTC.
    const cases: Array<[string, string]> = [
      ["2026-05-25T12:00:00Z", "Monday"],
      ["2026-05-26T12:00:00Z", "Tuesday"],
      ["2026-05-27T12:00:00Z", "Wednesday"],
      ["2026-05-28T12:00:00Z", "Thursday"],
      ["2026-05-29T12:00:00Z", "Friday"],
      ["2026-05-30T12:00:00Z", "Saturday"],
      ["2026-05-31T12:00:00Z", "Sunday"],
    ];
    for (const [iso, expectedDay] of cases) {
      const ctx = buildTimeContext(new Date(iso), UTC);
      expect(ctx).toContain(expectedDay);
    }
  });

  it("under UTC produces +0000 offset", () => {
    const ctx = buildTimeContext(new Date("2026-05-30T20:39:00Z"), UTC);
    expect(ctx).toContain("+0000");
  });

  it("under America/New_York in summer produces -0400 (EDT)", () => {
    // 2026-05-30 is during DST, so NY is UTC-4
    const ctx = buildTimeContext(new Date("2026-05-30T20:39:00Z"), "America/New_York");
    expect(ctx).toContain("-0400");
    // Local date in NY for 20:39Z is still 2026-05-30 (16:39 local)
    expect(ctx).toContain("2026-05-30");
  });

  it("is a single line (no embedded newlines)", () => {
    const ctx = buildTimeContext(new Date(), UTC);
    expect(ctx).not.toContain("\n");
  });

  it("without explicit timeZone falls back to system local (smoke check)", () => {
    // Just verify it doesn't throw and produces the canonical prefix; the
    // exact day/date depends on the test runner's TZ which we don't pin here.
    const ctx = buildTimeContext(new Date());
    expect(ctx.startsWith("Current time: ")).toBe(true);
    expect(ctx).toMatch(/UTC: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });
});

describe("TIME_INJECTION_OVERRIDE_ENV (mt#2181)", () => {
  it("is the documented MINSKY_SKIP_TIME_INJECTION env var", () => {
    // Asserted to catch accidental renames — the env-var name is the contract
    // with HOOK_ONLY_ENV_VARS in environment.ts and with operator docs.
    expect(TIME_INJECTION_OVERRIDE_ENV).toBe("MINSKY_SKIP_TIME_INJECTION");
  });
});
