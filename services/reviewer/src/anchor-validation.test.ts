/**
 * Tests for inline-comment anchor pre-validation (mt#2350).
 *
 * Pure functions, no DB or network. Covers:
 *   - parseRightSideAnchorableLines: added + context lines anchorable, removed
 *     lines not, multi-hunk/multi-file, deleted files.
 *   - partitionInlineComments: out-of-hunk demoted, in-hunk anchored, reply
 *     comments always pass through, LEFT-side conservatively demoted.
 *   - formatUnanchoredFindings: section rendering / empty case.
 */

import { describe, test, expect } from "bun:test";
import {
  parseRightSideAnchorableLines,
  partitionInlineComments,
  formatUnanchoredFindings,
} from "./anchor-validation";
import type { ReviewInlineComment } from "./github-client";

// A small two-file diff: file A adds lines 10-12 with surrounding context;
// file B is a pure deletion (no RIGHT side).
const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -8,4 +8,6 @@ context header
 const ctxBefore = 1;
+const added1 = 2;
+const added2 = 3;
 const ctxMid = 4;
+const added3 = 5;
 const ctxAfter = 6;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const goneA = 1;
-const goneB = 2;
-const goneC = 3;
`;

describe("parseRightSideAnchorableLines", () => {
  test("captures added AND context lines on the RIGHT side", () => {
    const map = parseRightSideAnchorableLines(SAMPLE_DIFF);
    const a = map.get("src/a.ts");
    expect(a).toBeDefined();
    // New file lines, starting at @@ +8: 8=ctxBefore, 9=added1, 10=added2,
    // 11=ctxMid, 12=added3, 13=ctxAfter.
    expect([...(a ?? [])].sort((x, y) => x - y)).toEqual([8, 9, 10, 11, 12, 13]);
  });

  test("a fully-deleted file has no RIGHT-side anchorable lines", () => {
    const map = parseRightSideAnchorableLines(SAMPLE_DIFF);
    // +++ /dev/null → currentFile stays null → no entry for src/b.ts.
    expect(map.get("src/b.ts")).toBeUndefined();
  });

  test("empty diff yields an empty map", () => {
    expect(parseRightSideAnchorableLines("").size).toBe(0);
  });

  test("removed (-) lines do not advance the new-file counter", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -5,3 +5,2 @@
 keep1
-removed
 keep2
`;
    const map = parseRightSideAnchorableLines(diff);
    // New lines: 5=keep1, (removed advances only old), 6=keep2.
    expect([...(map.get("x.ts") ?? [])].sort((a, b) => a - b)).toEqual([5, 6]);
  });
});

describe("partitionInlineComments", () => {
  const anchorable = parseRightSideAnchorableLines(SAMPLE_DIFF);

  test("comment on an added line is anchored", () => {
    const comments: ReviewInlineComment[] = [{ path: "src/a.ts", line: 9, body: "on added1" }];
    const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
    expect(anchored).toHaveLength(1);
    expect(unanchored).toHaveLength(0);
  });

  test("comment on a context line within a hunk is anchored", () => {
    const comments: ReviewInlineComment[] = [
      { path: "src/a.ts", line: 11, body: "on ctxMid (context)" },
    ];
    const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
    expect(anchored).toHaveLength(1);
    expect(unanchored).toHaveLength(0);
  });

  test("comment on a line outside any hunk is demoted (would 422)", () => {
    const comments: ReviewInlineComment[] = [{ path: "src/a.ts", line: 999, body: "out of hunk" }];
    const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
    expect(anchored).toHaveLength(0);
    expect(unanchored).toHaveLength(1);
  });

  test("comment on an unknown file is demoted", () => {
    const comments: ReviewInlineComment[] = [
      { path: "src/never.ts", line: 1, body: "no such file in diff" },
    ];
    const { unanchored } = partitionInlineComments(comments, anchorable);
    expect(unanchored).toHaveLength(1);
  });

  test("reply comments (inReplyTo) always pass through as anchored", () => {
    const comments: ReviewInlineComment[] = [
      // line is irrelevant for replies — GitHub anchors via the parent.
      { path: "src/a.ts", line: 999, body: "reply", inReplyTo: 12345 },
    ];
    const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
    expect(anchored).toHaveLength(1);
    expect(unanchored).toHaveLength(0);
  });

  test("LEFT-side comments are conservatively demoted (reviewer only uses RIGHT)", () => {
    const comments: ReviewInlineComment[] = [
      { path: "src/a.ts", line: 9, body: "left side", side: "LEFT" },
    ];
    const { unanchored } = partitionInlineComments(comments, anchorable);
    expect(unanchored).toHaveLength(1);
  });

  test("mixed batch: one bad anchor no longer sinks the good ones", () => {
    const comments: ReviewInlineComment[] = [
      { path: "src/a.ts", line: 9, body: "good" },
      { path: "src/a.ts", line: 999, body: "bad" },
      { path: "src/a.ts", line: 12, body: "also good" },
    ];
    const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
    expect(anchored.map((c) => c.line).sort((a, b) => a - b)).toEqual([9, 12]);
    expect(unanchored.map((c) => c.line)).toEqual([999]);
  });
});

describe("formatUnanchoredFindings", () => {
  test("empty input yields the empty string", () => {
    expect(formatUnanchoredFindings([])).toBe("");
  });

  test("renders a section listing each demoted finding", () => {
    const section = formatUnanchoredFindings([
      { path: "src/a.ts", line: 999, body: "line one\nline two" },
    ]);
    expect(section).toContain("## Unanchored findings");
    expect(section).toContain("`src/a.ts:999`");
    // Multi-line bodies are collapsed onto the list entry.
    expect(section).toContain("line one line two");
  });
});
