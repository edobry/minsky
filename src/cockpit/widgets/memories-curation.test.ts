/**
 * Unit tests for the curation + duplicates widget cores (mt#4767).
 *
 * These cover the PURE halves — payload assembly, the duplicate fold, and the
 * interval-parameter guard. The COUNTS themselves are asserted against the
 * live corpus by `scripts/verify-memory-worklists.ts`, which is the right
 * instrument for a claim of the form "this SQL returns the same number as that
 * SQL": a fake db could only confirm the query is the one I wrote, not that it
 * means what the spec says.
 */
import { describe, test, expect } from "bun:test";
import {
  assembleCurationPayload,
  parsePositiveInt,
  GROWTH_WEEKS,
  type GrowthBucket,
} from "./memories-curation";
import { groupDuplicateRows, DUPLICATE_GROUP_LIMIT } from "./memories-duplicates";

const EMPTY_COUNTS = {
  untagged: 0,
  never_read: 0,
  cold: 0,
  superseded: 0,
  duplicate_rows: 0,
  duplicate_groups: 0,
};

describe("assembleCurationPayload", () => {
  test("maps each count onto its worklist id, in the order the UI renders", () => {
    const payload = assembleCurationPayload(
      {
        untagged: 157,
        never_read: 251,
        cold: 136,
        superseded: 12,
        duplicate_rows: 204,
        duplicate_groups: 116,
      },
      [],
      14
    );

    expect(payload.worklists).toEqual([
      { id: "untagged", count: 157 },
      { id: "neverRead", count: 251 },
      { id: "cold", count: 136 },
      { id: "duplicates", count: 204 },
      { id: "superseded", count: 12 },
    ]);
  });

  test("the duplicates worklist counts REDUNDANT ROWS, with groups reported separately", () => {
    // 204 rows collapsing into 116 groups means 204 rows a cleanup would
    // remove, not 204 groups to review. Rendering the group count under the
    // "Duplicates" heading would understate the population by 43%.
    const payload = assembleCurationPayload(
      { ...EMPTY_COUNTS, duplicate_rows: 204, duplicate_groups: 116 },
      [],
      14
    );
    expect(payload.worklists.find((w) => w.id === "duplicates")?.count).toBe(204);
    expect(payload.duplicateGroups).toBe(116);
  });

  test("echoes back the coldDays it was computed at", () => {
    // The UI labels the tile "not read in Nd" and passes N into the
    // click-through filter. Deriving N on the frontend instead would let the
    // label and the count describe different thresholds.
    expect(assembleCurationPayload(EMPTY_COUNTS, [], 30).coldDays).toBe(30);
  });

  test("an all-zero corpus still reports all five worklists", () => {
    // Absent tiles would read as "not measured"; zero reads as "nothing to do".
    const payload = assembleCurationPayload(EMPTY_COUNTS, [], 14);
    expect(payload.worklists).toHaveLength(5);
    expect(payload.worklists.every((w) => w.count === 0)).toBe(true);
  });
});

describe("parsePositiveInt", () => {
  test("accepts a positive integer", () => {
    expect(parsePositiveInt("30", 14)).toBe(30);
  });

  test.each([
    ["undefined", undefined],
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "abc"],
    ["empty", ""],
    ["fractional", "7.5"],
  ])("falls back on %s", (_label, input) => {
    expect(parsePositiveInt(input as string | undefined, 14)).toBe(14);
  });

  test("rejecting zero is load-bearing, not defensive tidiness", () => {
    // The value is interpolated into `interval 'N days'` via sql.raw. At N=0
    // the cold filter matches every record ever read — a WRONG ANSWER that
    // renders as a plausible number rather than an error, which is the shape
    // that survives review. It is also the injection boundary.
    expect(parsePositiveInt("0", 14)).toBe(14);
    expect(parsePositiveInt("1; drop table memories", 14)).toBe(14);
  });
});

describe("growth panel shape", () => {
  test("covers 8 weeks", () => {
    expect(GROWTH_WEEKS).toBe(8);
  });

  test("carries the cohort split through assembly untouched", () => {
    const growth: GrowthBucket[] = [
      { weekStart: "2026-08-24", total: 120, handoff: 64, retrospective: 9, other: 47 },
    ];
    expect(assembleCurationPayload(EMPTY_COUNTS, growth, 14).growth).toEqual(growth);
  });
});

describe("groupDuplicateRows", () => {
  function row(hash: string, id: string, memberCount: number, createdAt = "2026-08-01") {
    return {
      content_hash: hash,
      member_count: memberCount,
      preview: `preview-${hash}`,
      id,
      short_id: `mem#${id}`,
      name: `name-${id}`,
      type: "project",
      created_at: createdAt,
      last_accessed_at: null,
      access_count: 0,
    };
  }

  test("folds consecutive rows of the same hash into one group", () => {
    const groups = groupDuplicateRows([
      row("aaa", "1", 2),
      row("aaa", "2", 2),
      row("bbb", "3", 2),
      row("bbb", "4", 2),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members.length)).toEqual([2, 2]);
  });

  test("sorts the largest groups first", () => {
    const groups = groupDuplicateRows([
      row("aaa", "1", 2),
      row("aaa", "2", 2),
      row("bbb", "3", 4),
      row("bbb", "4", 4),
      row("bbb", "5", 4),
      row("bbb", "6", 4),
    ]);
    expect(groups[0]?.contentHash).toBe("bbb");
    expect(groups[0]?.memberCount).toBe(4);
  });

  test("preserves a null last_accessed_at rather than coercing it to 0", () => {
    // The UI renders null as "never read" and a number as "Nx". Coercing here
    // would make a never-read copy indistinguishable from one read zero times
    // recently — and which copy has been read is the signal a human deduping
    // the group actually wants.
    const groups = groupDuplicateRows([row("aaa", "1", 2), row("aaa", "2", 2)]);
    expect(groups[0]?.members[0]?.lastAccessedAt).toBeNull();
  });

  test("returns nothing for no rows", () => {
    expect(groupDuplicateRows([])).toEqual([]);
  });

  test("the group limit is above the measured corpus size", () => {
    // 116 groups measured 2026-08-31. If this ever inverts, the view starts
    // truncating and the header's "showing N of M" line becomes load-bearing.
    expect(DUPLICATE_GROUP_LIMIT).toBeGreaterThan(116);
  });
});
