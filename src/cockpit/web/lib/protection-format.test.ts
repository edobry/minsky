/**
 * Unit tests for the operator surface's figure formatting (mt#4287).
 *
 * Boundaries only — this is a pure branch-per-unit function, and the branches
 * are where a formatter goes wrong (59.9s reading as "1 min", an hour reading
 * as "60 min"). The multi-hour case that motivated the function at all is
 * exercised end-to-end in `../pages/ProtectionPage.test.tsx`.
 */
import { describe, expect, test } from "bun:test";
import { formatOperatorDuration, pluralize } from "./protection-format";

describe("formatOperatorDuration", () => {
  test("sub-second stays in milliseconds", () => {
    expect(formatOperatorDuration(0)).toBe("0ms");
    expect(formatOperatorDuration(4)).toBe("4ms");
    expect(formatOperatorDuration(999)).toBe("999ms");
  });

  test("seconds carry a decimal only below ten", () => {
    expect(formatOperatorDuration(1000)).toBe("1.0s");
    expect(formatOperatorDuration(9_400)).toBe("9.4s");
    expect(formatOperatorDuration(10_000)).toBe("10s");
    expect(formatOperatorDuration(59_000)).toBe("59s");
  });

  test("crosses into minutes at sixty seconds, and into hours at sixty minutes", () => {
    expect(formatOperatorDuration(60_000)).toBe("1.0 min");
    expect(formatOperatorDuration(600_000)).toBe("10 min");
    expect(formatOperatorDuration(3_540_000)).toBe("59 min");
    expect(formatOperatorDuration(3_600_000)).toBe("1.0 hr");
  });

  test("the measured attention spend from mt#3754 reads in hours", () => {
    // ~2.8 hours; `formatMs` would render this as "10080s".
    expect(formatOperatorDuration(10_080_000)).toBe("2.8 hr");
  });

  test("a nonsense input renders as unknown rather than as a number", () => {
    expect(formatOperatorDuration(Number.NaN)).toBe("—");
    expect(formatOperatorDuration(-1)).toBe("—");
    expect(formatOperatorDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("pluralize", () => {
  test("singular at one, plural otherwise, including zero", () => {
    expect(pluralize(1, "check")).toBe("1 check");
    expect(pluralize(0, "check")).toBe("0 checks");
    expect(pluralize(2, "check")).toBe("2 checks");
  });

  test("thousands separate, so a large corpus count stays readable", () => {
    expect(pluralize(1200, "check")).toBe("1,200 checks");
  });

  test("an irregular plural can be supplied", () => {
    expect(pluralize(2, "entry", "entries")).toBe("2 entries");
  });
});
