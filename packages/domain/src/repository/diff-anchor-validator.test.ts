/**
 * Unit tests for diff-anchor-validator.ts (mt#1347).
 *
 * Covers:
 *  - Empty/undefined comments[] passes without invoking validator
 *  - Path not in diff → DiffAnchorError with reason "path not in PR"
 *  - Line outside any hunk → DiffAnchorError with nearestValidAnchor
 *  - Side mismatch: RIGHT on a deleted-only line, LEFT on an added-only line
 *  - Valid single-line RIGHT comment passes
 *  - Valid single-line LEFT comment passes
 *  - Valid multi-line comment passes (startLine + line both valid)
 *  - Multi-line comment with invalid startLine → DiffAnchorError on startLine
 *  - Binary file (no hunks) → DiffAnchorError with no nearest anchor
 *  - Warning-flagged file (path "", warning set) is skipped for path lookup
 *  - CONTEXT line valid as both LEFT and RIGHT anchor
 *
 * Fixtures:
 *  - SINGLE_HUNK_DIFF: a single modified file with one hunk spanning lines 10-20
 *  - MULTI_HUNK_DIFF: a modified file with two separate hunks
 *  - BINARY_DIFF: a binary file (no hunks)
 *  - WARNING_DIFF: a warning-flagged file with path ""
 */

import { describe, test, expect } from "bun:test";
import { validateDiffAnchors, DiffAnchorError } from "./diff-anchor-validator";
import { MinskyError } from "../errors/index";
import type { DiffFile } from "../utils/parse-diff";

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A single modified file with one hunk.
 *
 * Hunk layout (new-file line numbers):
 *   line 10: context (oldLine=10, newLine=10)
 *   line 11: added   (oldLine=null, newLine=11)   [RIGHT only]
 *   line 12: deleted (oldLine=11, newLine=null)   [LEFT only]
 *   line 13: context (oldLine=12, newLine=13)
 *   line 14: added   (oldLine=null, newLine=14)   [RIGHT only]
 *   line 15: context (oldLine=13, newLine=15)
 *
 * Valid RIGHT anchors (newLine): 10, 11, 13, 14, 15
 * Valid LEFT anchors (oldLine):  10, 11 (=oldLine 11→ deleted), 12, 13
 */
const SINGLE_HUNK_DIFF: DiffFile[] = [
  {
    path: "src/foo.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 10,
        oldLines: 6,
        newStart: 10,
        newLines: 6,
        header: "@@ -10,6 +10,6 @@",
        lines: [
          { side: "CONTEXT", oldLine: 10, newLine: 10, content: "context line A" },
          { side: "RIGHT", oldLine: null, newLine: 11, content: "added line" },
          { side: "LEFT", oldLine: 11, newLine: null, content: "deleted line" },
          { side: "CONTEXT", oldLine: 12, newLine: 13, content: "context line B" },
          { side: "RIGHT", oldLine: null, newLine: 14, content: "another added" },
          { side: "CONTEXT", oldLine: 13, newLine: 15, content: "context line C" },
        ],
      },
    ],
  },
];

/**
 * A modified file with two hunks (multi-hunk).
 *
 * Hunk 1: new-file lines 5-8 (added)
 * Hunk 2: new-file lines 20-22 (context + added)
 */
const MULTI_HUNK_DIFF: DiffFile[] = [
  {
    path: "src/bar.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 5,
        oldLines: 2,
        newStart: 5,
        newLines: 4,
        header: "@@ -5,2 +5,4 @@",
        lines: [
          { side: "CONTEXT", oldLine: 5, newLine: 5, content: "context" },
          { side: "RIGHT", oldLine: null, newLine: 6, content: "added1" },
          { side: "RIGHT", oldLine: null, newLine: 7, content: "added2" },
          { side: "CONTEXT", oldLine: 6, newLine: 8, content: "context2" },
        ],
      },
      {
        oldStart: 20,
        oldLines: 2,
        newStart: 22,
        newLines: 3,
        header: "@@ -20,2 +22,3 @@",
        lines: [
          { side: "CONTEXT", oldLine: 20, newLine: 22, content: "ctx" },
          { side: "RIGHT", oldLine: null, newLine: 23, content: "added3" },
          { side: "CONTEXT", oldLine: 21, newLine: 24, content: "ctx2" },
        ],
      },
    ],
  },
];

/**
 * A binary file (status modified, no hunks).
 */
const BINARY_DIFF: DiffFile[] = [
  {
    path: "assets/image.png",
    status: "modified",
    hunks: [],
  },
];

/**
 * A warning-flagged entry (path = "", warning set) plus a normal file.
 * The warning entry should be filtered out during path lookup.
 */
const WARNING_DIFF: DiffFile[] = [
  {
    path: "",
    status: "modified",
    hunks: [],
    warning: "Could not recover file path from diff --git header",
  },
  {
    path: "src/ok.ts",
    status: "modified",
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        header: "@@ -1,2 +1,2 @@",
        lines: [
          { side: "CONTEXT", oldLine: 1, newLine: 1, content: "line1" },
          { side: "RIGHT", oldLine: null, newLine: 2, content: "added" },
        ],
      },
    ],
  },
];

// ── Shared test constants ──────────────────────────────────────────────────

const PATH_NONEXISTENT = "src/nonexistent.ts";
const PATH_BINARY = "assets/image.png";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("validateDiffAnchors", () => {
  // ── Backward compat ──────────────────────────────────────────────────────

  test("passes when comments is undefined", () => {
    expect(() => validateDiffAnchors(SINGLE_HUNK_DIFF, undefined)).not.toThrow();
  });

  test("passes when comments is an empty array", () => {
    expect(() => validateDiffAnchors(SINGLE_HUNK_DIFF, [])).not.toThrow();
  });

  // ── Path not in diff ─────────────────────────────────────────────────────

  test("throws DiffAnchorError when path is not in diff", () => {
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [{ path: PATH_NONEXISTENT, line: 10, body: "comment" }])
    ).toThrow(DiffAnchorError);
  });

  test("error for missing path includes the path and 'not found in PR diff' reason", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: PATH_NONEXISTENT, line: 10, body: "comment" },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiffAnchorError);
    const err = caught as DiffAnchorError;
    expect(err.failure.reason).toContain(PATH_NONEXISTENT);
    expect(err.failure.nearestValidAnchor).toBeNull();
    expect(err.failure.anchor.path).toBe(PATH_NONEXISTENT);
  });

  test("error for missing path has nearestValidAnchor null", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [{ path: "does-not-exist.ts", line: 1, body: "x" }]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.failure.nearestValidAnchor).toBeNull();
  });

  // ── Line outside any hunk ─────────────────────────────────────────────────

  test("throws DiffAnchorError when line is outside any hunk (RIGHT)", () => {
    // Line 99 does not appear in SINGLE_HUNK_DIFF (lines 10-15 only)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 99, side: "RIGHT", body: "comment" },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("error for out-of-hunk line includes nearestValidAnchor", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 99, side: "RIGHT", body: "comment" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    // Nearest RIGHT anchor from lines {10,11,13,14,15} to 99 is 15
    expect(err.failure.nearestValidAnchor).not.toBeNull();
    expect(err.failure.nearestValidAnchor?.line).toBe(15);
    expect(err.failure.nearestValidAnchor?.side).toBe("RIGHT");
    expect(err.failure.anchor.line).toBe(99);
  });

  test("error for out-of-hunk line message mentions line and side", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 1, side: "RIGHT", body: "comment" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.message).toContain("line 1");
    expect(err.message).toContain("RIGHT");
    expect(err.message).toContain("src/foo.ts");
  });

  // ── Side mismatch ──────────────────────────────────────────────────────────

  test("throws when RIGHT is used on a deleted-only line (LEFT line)", () => {
    // Line 11 (oldLine=11) is a deleted-only line: LEFT only, not RIGHT
    // In SINGLE_HUNK_DIFF, newLine=11 is an ADDED line (RIGHT), but oldLine=11 is deleted
    // We need to use a line that only exists on LEFT side: in our fixture, oldLine=11 maps to LEFT
    // The deleted line has oldLine=11, so commenting with side:RIGHT on line 11 (newLine) is valid
    // because newLine=11 is the ADDED line.
    // Let's test side:RIGHT on line 12 — there's no newLine=12 in the fixture (newLine goes 10,11,13,14,15)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 12, side: "RIGHT", body: "comment" },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("throws when LEFT is used on an added-only line", () => {
    // newLine=14 is an ADDED line (RIGHT only): oldLine=null, so no LEFT anchor at 14
    // But we need to check using oldLine numbering for LEFT.
    // In SINGLE_HUNK_DIFF: LEFT valid anchors are oldLine values: 10, 11, 12, 13
    // oldLine=14 does not exist in this fixture, so LEFT anchor at 14 should fail
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 14, side: "LEFT", body: "comment" },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("error for side mismatch includes nearest valid anchor", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 12, side: "RIGHT", body: "comment" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.failure.nearestValidAnchor).not.toBeNull();
    // nearest anchor to line 12 by absolute distance across all sides:
    // oldLine=11 (LEFT, dist=1), newLine=11 (RIGHT, dist=1), oldLine=12 (LEFT, dist=0) — wait,
    // newLine=12 does not exist; oldLine=12 maps to CONTEXT at newLine=13.
    // All anchors: LEFT@10, RIGHT@10, RIGHT@11, LEFT@11, LEFT@12, RIGHT@13, LEFT@12 already...
    // Actually CONTEXT at (oldLine=12, newLine=13): LEFT@12 and RIGHT@13.
    // Closest to line 12: LEFT@12 (distance 0), found first.
    const near = err.failure.nearestValidAnchor;
    expect(near).not.toBeNull();
    expect(near?.line).toBe(12);
    expect(near?.side).toBe("LEFT");
  });

  // ── Valid single-line comments ─────────────────────────────────────────────

  test("passes for valid RIGHT comment on an added line", () => {
    // newLine=11 is RIGHT (added)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 11, side: "RIGHT", body: "comment" },
      ])
    ).not.toThrow();
  });

  test("passes for valid LEFT comment on a deleted line", () => {
    // oldLine=11 is LEFT (deleted)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 11, side: "LEFT", body: "comment" },
      ])
    ).not.toThrow();
  });

  test("passes for valid RIGHT comment on a context line (newLine)", () => {
    // newLine=10 is CONTEXT: valid for RIGHT
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 10, side: "RIGHT", body: "comment" },
      ])
    ).not.toThrow();
  });

  test("passes for valid LEFT comment on a context line (oldLine)", () => {
    // oldLine=10 is CONTEXT: valid for LEFT
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        { path: "src/foo.ts", line: 10, side: "LEFT", body: "comment" },
      ])
    ).not.toThrow();
  });

  test("passes for comment with no side specified (defaults to RIGHT)", () => {
    // No side → defaults to RIGHT; newLine=11 is RIGHT valid
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [{ path: "src/foo.ts", line: 11, body: "comment" }])
    ).not.toThrow();
  });

  // ── Valid multi-line comments ─────────────────────────────────────────────

  test("passes for valid multi-line RIGHT comment (startLine and line both valid)", () => {
    // newLine=11 (RIGHT), newLine=14 (RIGHT) — valid multi-line range
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        {
          path: "src/foo.ts",
          startLine: 11,
          line: 14,
          side: "RIGHT",
          startSide: "RIGHT",
          body: "range",
        },
      ])
    ).not.toThrow();
  });

  test("passes for valid multi-line LEFT comment", () => {
    // oldLine=10 (CONTEXT LEFT), oldLine=12 (CONTEXT LEFT)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        {
          path: "src/foo.ts",
          startLine: 10,
          line: 12,
          side: "LEFT",
          startSide: "LEFT",
          body: "left range",
        },
      ])
    ).not.toThrow();
  });

  // ── Multi-line with invalid startLine ─────────────────────────────────────

  test("throws when startLine is outside any hunk", () => {
    // startLine=1 is not in SINGLE_HUNK_DIFF (starts at 10)
    expect(() =>
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        {
          path: "src/foo.ts",
          startLine: 1,
          line: 11,
          side: "RIGHT",
          startSide: "RIGHT",
          body: "range",
        },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("error for invalid startLine references startLine in anchor", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [
        {
          path: "src/foo.ts",
          startLine: 1,
          line: 11,
          side: "RIGHT",
          startSide: "RIGHT",
          body: "range",
        },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.failure.anchor.line).toBe(1); // startLine reported as the failing anchor line
    expect(err.message).toContain("startLine 1");
  });

  // ── Binary file ──────────────────────────────────────────────────────────

  test("throws for any anchor on a binary file (no hunks)", () => {
    expect(() =>
      validateDiffAnchors(BINARY_DIFF, [
        { path: PATH_BINARY, line: 1, side: "RIGHT", body: "comment on binary" },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("binary file error has null nearestValidAnchor", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(BINARY_DIFF, [
        { path: PATH_BINARY, line: 1, side: "RIGHT", body: "comment on binary" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.failure.nearestValidAnchor).toBeNull();
  });

  test("binary file error message mentions 'binary or empty diff'", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(BINARY_DIFF, [
        { path: PATH_BINARY, line: 5, side: "RIGHT", body: "binary comment" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    expect(err.message).toContain("binary or empty diff");
  });

  // ── Warning-flagged file ──────────────────────────────────────────────────

  test("warning-flagged file (path='', warning set) does not match path lookup", () => {
    // Trying to comment with path="" should fail (path not found) because
    // warning-flagged entries are filtered from the path index
    expect(() =>
      validateDiffAnchors(WARNING_DIFF, [{ path: "", line: 1, side: "RIGHT", body: "x" }])
    ).toThrow(DiffAnchorError);
  });

  test("normal file in diff alongside warning file is still findable", () => {
    // src/ok.ts is in WARNING_DIFF alongside the warning entry; it should be found
    expect(() =>
      validateDiffAnchors(WARNING_DIFF, [{ path: "src/ok.ts", line: 2, side: "RIGHT", body: "y" }])
    ).not.toThrow();
  });

  // ── Multi-hunk diff ──────────────────────────────────────────────────────

  test("validates anchors across multiple hunks", () => {
    // line 6 (RIGHT) in hunk1 and line 23 (RIGHT) in hunk2 — both valid
    expect(() =>
      validateDiffAnchors(MULTI_HUNK_DIFF, [
        { path: "src/bar.ts", line: 6, side: "RIGHT", body: "hunk1" },
        { path: "src/bar.ts", line: 23, side: "RIGHT", body: "hunk2" },
      ])
    ).not.toThrow();
  });

  test("throws for line between hunks (gap line)", () => {
    // Line 15 is between hunk1 (lines 5-8) and hunk2 (lines 22-24) — not in any hunk
    expect(() =>
      validateDiffAnchors(MULTI_HUNK_DIFF, [
        { path: "src/bar.ts", line: 15, side: "RIGHT", body: "gap" },
      ])
    ).toThrow(DiffAnchorError);
  });

  test("gap-line error includes nearest valid anchor from either hunk", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(MULTI_HUNK_DIFF, [
        { path: "src/bar.ts", line: 15, side: "RIGHT", body: "gap" },
      ]);
    } catch (e) {
      caught = e;
    }
    const err = caught as DiffAnchorError;
    // All anchors (both sides): hunk1 lines {5,6,7,8} + hunk2 lines {20,22,23,21,24}
    // (CONTEXT at oldLine=20,newLine=22 produces LEFT@20 and RIGHT@22)
    // Distances from 15: LEFT@20 = dist 5, RIGHT@8 = dist 7, RIGHT@22 = dist 7
    // Nearest is LEFT@20 (distance 5)
    expect(err.failure.nearestValidAnchor).not.toBeNull();
    expect(err.failure.nearestValidAnchor?.line).toBe(20);
    expect(err.failure.nearestValidAnchor?.side).toBe("LEFT");
  });

  // ── DiffAnchorError properties ────────────────────────────────────────────

  test("DiffAnchorError is instanceof MinskyError", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [{ path: "nonexistent.ts", line: 1, body: "x" }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MinskyError);
  });

  test("DiffAnchorError has name 'DiffAnchorError'", () => {
    let caught: unknown;
    try {
      validateDiffAnchors(SINGLE_HUNK_DIFF, [{ path: "nonexistent.ts", line: 1, body: "x" }]);
    } catch (e) {
      caught = e;
    }
    expect((caught as DiffAnchorError).name).toBe("DiffAnchorError");
  });
});
