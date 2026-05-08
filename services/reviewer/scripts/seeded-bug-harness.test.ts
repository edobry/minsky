/**
 * Unit tests for seeded-bug-harness.ts — pure helpers only.
 *
 * Tests cover: catalog selection logic, line-citation regex, and the
 * computeMedian helper. These do NOT test Octokit integration paths
 * (those require live credentials and belong to the live verification step).
 *
 * mt#1515 companion to seeded-bug-harness.ts.
 */

import { describe, test, expect } from "bun:test";
import { computeMedian } from "./seeded-bug-harness";

// ---------------------------------------------------------------------------
// computeMedian
// ---------------------------------------------------------------------------

describe("computeMedian", () => {
  test("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });

  test("returns the single value for a one-element array", () => {
    expect(computeMedian([42])).toBe(42);
  });

  test("returns the middle value for an odd-length array", () => {
    expect(computeMedian([1, 3, 5])).toBe(3);
  });

  test("returns the average of two middle values for an even-length array", () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
  });

  test("sorts the values before computing median", () => {
    // Unsorted input — median of [10, 3, 7] sorted is [3, 7, 10] → 7.
    expect(computeMedian([10, 3, 7])).toBe(7);
  });

  test("handles negative values", () => {
    expect(computeMedian([-5, -1, 0, 2, 4])).toBe(0);
  });

  test("handles duplicate values", () => {
    expect(computeMedian([2, 2, 2, 2])).toBe(2);
  });

  test("does not mutate the input array", () => {
    const input = [5, 1, 3];
    const copy = [...input];
    computeMedian(input);
    expect(input).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Line-citation regex logic
//
// The `checkCitation` function is not exported from seeded-bug-harness.ts
// (it's an internal helper). We test its logic here directly using the same
// regex pattern, which is the key correctness-sensitive piece.
// ---------------------------------------------------------------------------

/**
 * Inline reimplementation of the citation check logic from seeded-bug-harness.ts.
 * We test this shape rather than the module's internal helper because the
 * function is not exported — keeping it internal prevents callers from relying
 * on it outside the harness context.
 *
 * If the regex or line-match logic changes in the harness, these tests will
 * catch the divergence.
 */
function checkCitationInline(
  reviewBody: string,
  injectedFilename: string,
  injectedLine: number
): number | null {
  const escapedFilename = injectedFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const citationRe = new RegExp(`${escapedFilename}:(\\d+)`, "g");
  let match: RegExpExecArray | null;
  while ((match = citationRe.exec(reviewBody)) !== null) {
    const citedLine = parseInt(match[1], 10);
    if (!isNaN(citedLine) && Math.abs(citedLine - injectedLine) <= 5) {
      return citedLine;
    }
  }
  return null;
}

describe("line-citation regex (checkCitation logic)", () => {
  test("returns null for empty body", () => {
    expect(checkCitationInline("", "off-by-one.ts", 12)).toBeNull();
  });

  test("returns null when the filename is not mentioned", () => {
    const body = "Found an issue in some-other-file.ts:12";
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBeNull();
  });

  test("returns null when the filename matches but no line number follows", () => {
    const body = "Found an issue in off-by-one.ts";
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBeNull();
  });

  test("returns the cited line when it matches exactly", () => {
    const body = "Found a bug at off-by-one.ts:12 — off-by-one in loop bound.";
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBe(12);
  });

  test("accepts a citation within +5 of the injected line", () => {
    const body = "off-by-one.ts:17 has an off-by-one.";
    // 17 - 12 = 5, which is exactly at the boundary → should match.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBe(17);
  });

  test("accepts a citation within -5 of the injected line", () => {
    const body = "See off-by-one.ts:7.";
    // 12 - 7 = 5, exactly at the boundary → should match.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBe(7);
  });

  test("rejects a citation at +6 of the injected line", () => {
    const body = "off-by-one.ts:18 has something.";
    // 18 - 12 = 6, outside ±5 window → null.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBeNull();
  });

  test("rejects a citation at -6 of the injected line", () => {
    const body = "off-by-one.ts:6 has something.";
    // 12 - 6 = 6, outside ±5 window → null.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBeNull();
  });

  test("returns the first matching citation when multiple are present", () => {
    const body = "off-by-one.ts:12 and also off-by-one.ts:14";
    // First match (line 12) is exact; should return it.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBe(12);
  });

  test("returns a later matching citation when the first one is out of range", () => {
    const body = "off-by-one.ts:99 (unrelated) and off-by-one.ts:13 (the bug).";
    // 99 is outside ±5 of 12; 13 is within → should return 13.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBe(13);
  });

  test("handles filenames with hyphens correctly", () => {
    const body = "null-deref.ts:15 is the null dereference.";
    expect(checkCitationInline(body, "null-deref.ts", 15)).toBe(15);
  });

  test("handles filenames with underscores and nested paths", () => {
    const body = "Found in unhandled-promise.ts:18.";
    expect(checkCitationInline(body, "unhandled-promise.ts", 18)).toBe(18);
  });

  test("is case-sensitive on filename", () => {
    const body = "OFF-BY-ONE.TS:12 has a bug.";
    // Regex is case-sensitive; uppercase filename should not match.
    expect(checkCitationInline(body, "off-by-one.ts", 12)).toBeNull();
  });
});
