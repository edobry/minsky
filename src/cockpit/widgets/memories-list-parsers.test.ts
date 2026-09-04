/**
 * Query-parameter integer parsing for the memories-list widget
 * (PR #3508 R1 BLOCKING).
 *
 * `parsePositiveInt` accepted `n >= 0` under a name promising otherwise. The
 * damage is worst on the day-thresholds, which are interpolated into a SQL
 * interval: `coldDays=0` becomes `interval '0 days'`, so every ever-read
 * record matches and the cold worklist widens to "all read" — a plausible
 * number with no error anywhere. `unreadOrColdDays=0` does the same to the union
 * filter, which predates this PR and was equally exposed.
 *
 * The two parsers are split rather than merged because `offset` genuinely
 * wants 0 (it is the first page) and nothing else does.
 */
import { describe, test, expect } from "bun:test";
import { parsePositiveInt, parseNonNegativeInt } from "./memories-list";
import { parsePositiveInt as curationParsePositiveInt } from "./memories-curation";
import { DEFAULT_COLD_DAYS } from "@minsky/domain/memory/types";

describe("parsePositiveInt rejects the values that produce a wrong answer", () => {
  test("accepts a positive integer", () => {
    expect(parsePositiveInt("30")).toBe(30);
  });

  test("rejects 0 — the interval-collapse case", () => {
    // `interval '0 days'` matches every record with a non-null
    // last_accessed_at. The filter still runs, still returns rows, and is
    // simply answering a different question than the tile that linked here.
    expect(parsePositiveInt("0")).toBeUndefined();
  });

  test.each([
    ["negative", "-5"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["undefined", undefined],
  ])("rejects %s", (_label, input) => {
    expect(parsePositiveInt(input as string | undefined)).toBeUndefined();
  });
});

describe("parseNonNegativeInt keeps 0 for the one caller that needs it", () => {
  test("accepts 0 — offset's first page", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
  });

  test("accepts a positive integer", () => {
    expect(parseNonNegativeInt("50")).toBe(50);
  });

  test("still rejects negatives and junk", () => {
    expect(parseNonNegativeInt("-1")).toBeUndefined();
    expect(parseNonNegativeInt("abc")).toBeUndefined();
  });
});

describe("the two widgets agree on what a valid coldDays is", () => {
  // The count comes from `memories-curation` and the table it links to comes
  // from `memories-list`. They are independent code paths by design (aggregate
  // vs row predicate), so any divergence in input validation shows up as a
  // tile whose number disagrees with the list it opens. That divergence was
  // the reviewer's finding.
  test.each(["0", "-1", "abc", "7.5"])("both reject %s", (input) => {
    expect(parsePositiveInt(input)).toBeUndefined();
    expect(curationParsePositiveInt(input, DEFAULT_COLD_DAYS)).toBe(DEFAULT_COLD_DAYS);
  });

  test.each(["1", "14", "30", "365"])("both accept %s", (input) => {
    expect(parsePositiveInt(input)).toBe(Number(input));
    expect(curationParsePositiveInt(input, DEFAULT_COLD_DAYS)).toBe(Number(input));
  });

  test("an omitted value lands on the same default on both paths", () => {
    // list: undefined -> the domain applies DEFAULT_COLD_DAYS.
    // curation: undefined -> DEFAULT_COLD_DAYS explicitly.
    expect(parsePositiveInt(undefined)).toBeUndefined();
    expect(curationParsePositiveInt(undefined, DEFAULT_COLD_DAYS)).toBe(DEFAULT_COLD_DAYS);
  });
});
