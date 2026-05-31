import { describe, expect, it } from "bun:test";
import { buildTimeContext, TIME_INJECTION_OVERRIDE_ENV } from "./inject-current-time";

describe("buildTimeContext (mt#2181)", () => {
  it("includes the day of week", () => {
    // 2026-05-30 was a Saturday (verified via `date` in originating session)
    const sat = new Date("2026-05-30T20:39:00Z");
    const ctx = buildTimeContext(sat);
    expect(ctx).toContain("Saturday");
  });

  it("includes the ISO date (YYYY-MM-DD)", () => {
    const d = new Date("2026-05-30T20:39:00Z");
    const ctx = buildTimeContext(d);
    expect(ctx).toContain("2026-05-30");
  });

  it("includes the UTC ISO timestamp", () => {
    const d = new Date("2026-05-30T20:39:00Z");
    const ctx = buildTimeContext(d);
    expect(ctx).toContain("UTC: 2026-05-30T20:39:00Z");
  });

  it("starts with the canonical prefix", () => {
    const ctx = buildTimeContext(new Date());
    expect(ctx.startsWith("Current time: ")).toBe(true);
  });

  it("includes a numeric timezone offset (signed, 4-digit)", () => {
    const ctx = buildTimeContext(new Date());
    // The offset is either +HHMM or -HHMM (e.g., -0400 for EDT, +0000 for UTC)
    expect(ctx).toMatch(/[+-]\d{4} \(UTC:/);
  });

  it("produces day names for each weekday correctly (sanity)", () => {
    // 2026-05-25 = Monday, 26 = Tuesday, ..., 31 = Sunday
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
      const ctx = buildTimeContext(new Date(iso));
      expect(ctx).toContain(expectedDay);
    }
  });

  it("is a single line (no embedded newlines)", () => {
    const ctx = buildTimeContext(new Date());
    expect(ctx).not.toContain("\n");
  });
});

describe("TIME_INJECTION_OVERRIDE_ENV (mt#2181)", () => {
  it("is the documented MINSKY_SKIP_TIME_INJECTION env var", () => {
    // Asserted to catch accidental renames — the env-var name is the contract
    // with HOOK_ONLY_ENV_VARS in environment.ts and with operator docs.
    expect(TIME_INJECTION_OVERRIDE_ENV).toBe("MINSKY_SKIP_TIME_INJECTION");
  });
});
