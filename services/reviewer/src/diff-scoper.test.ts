/**
 * Unit tests for diff-scoper.ts (mt#1875 — Fix 3).
 */

import { describe, test, expect } from "bun:test";
import {
  parseFixCommitLineRanges,
  extractFixCommitDiff,
  isLineInScope,
  applyDiffScopeBoundedDowngrade,
  type FixCommitLineRangeMap,
} from "./diff-scoper";
import type { ReviewToolCall } from "./output-tools";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal unified diff touching foo.ts lines 10-15 and bar.ts lines 5-8. */
const SAMPLE_DIFF = `
diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -8,8 +8,10 @@ export function foo() {
   const a = 1;
   const b = 2;
+  const c = 3;
+  const d = 4;
   return a + b;
 }

diff --git a/src/bar.ts b/src/bar.ts
index 111111..222222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -3,6 +3,8 @@ export function bar() {
   const x = 1;
+  const y = 2;
+  const z = 3;
   return x;
 }
`.trim();

/** A diff with no added lines (deletion-only). */
const DELETION_DIFF = `
diff --git a/src/old.ts b/src/old.ts
index aaa..bbb 100644
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,5 +1,3 @@
 function old() {
-  return 1;
-  return 2;
   return 0;
 }
`.trim();

// ---------------------------------------------------------------------------
// parseFixCommitLineRanges
// ---------------------------------------------------------------------------

describe("parseFixCommitLineRanges", () => {
  test("returns empty map for empty diff", () => {
    const result = parseFixCommitLineRanges("");
    expect(result.size).toBe(0);
  });

  test("returns empty map for whitespace-only diff", () => {
    const result = parseFixCommitLineRanges("   \n\n   ");
    expect(result.size).toBe(0);
  });

  test("parses a single-file diff correctly", () => {
    const diff = `
diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,7 @@
 context
+added1
+added2
 context
`.trim();
    const result = parseFixCommitLineRanges(diff);
    expect(result.size).toBe(1);
    const ranges = result.get("src/foo.ts");
    expect(ranges).toBeDefined();
    // newStart=10 → context(10), +added1(11), +added2(12), context(13)
    // Only + lines are in scope: lines 11 and 12, coalesced to [11, 12]
    if (ranges === undefined) throw new Error("ranges should be defined");
    expect(ranges[0]).toEqual([11, 12]);
  });

  test("context lines are NOT in scope (only + lines are in scope)", () => {
    // Verifies Finding 3: only added lines (prefix '+') count as in-scope.
    // Context lines (no prefix) and removed lines (prefix '-') are excluded.
    const diff = `
diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -5,5 +5,6 @@
 context_at_5
 context_at_6
+added_at_7
 context_at_8
 context_at_9
`.trim();
    const result = parseFixCommitLineRanges(diff);
    // newStart=5: context(5), context(6), +added(7), context(8), context(9)
    // Only line 7 is added → range [7, 7]
    const ranges = result.get("src/foo.ts");
    expect(ranges).toBeDefined();
    if (ranges === undefined) throw new Error("ranges should be defined");
    expect(ranges).toEqual([[7, 7]]);
    // Verify context lines are not in scope
    expect(isLineInScope("src/foo.ts", 5, undefined, result)).toBe(false);
    expect(isLineInScope("src/foo.ts", 6, undefined, result)).toBe(false);
    expect(isLineInScope("src/foo.ts", 7, undefined, result)).toBe(true);
    expect(isLineInScope("src/foo.ts", 8, undefined, result)).toBe(false);
    expect(isLineInScope("src/foo.ts", 9, undefined, result)).toBe(false);
  });

  test("normalizes file paths (strips a/ and b/ prefixes)", () => {
    const diff = `
diff --git a/src/util.ts b/src/util.ts
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
`.trim();
    const result = parseFixCommitLineRanges(diff);
    // Should be stored without a/b/ prefix
    expect(result.has("src/util.ts")).toBe(true);
    expect(result.has("a/src/util.ts")).toBe(false);
    expect(result.has("b/src/util.ts")).toBe(false);
  });

  test("handles multi-file diff", () => {
    const result = parseFixCommitLineRanges(SAMPLE_DIFF);
    expect(result.size).toBe(2);
    expect(result.has("src/foo.ts")).toBe(true);
    expect(result.has("src/bar.ts")).toBe(true);
  });

  test("skips deleted files (/dev/null)", () => {
    const diff = `
diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-function deleted() {}
`.trim();
    const result = parseFixCommitLineRanges(diff);
    expect(result.has("deleted.ts")).toBe(false);
  });

  test("handles deletion-only diff (no added lines — file not in scope)", () => {
    const result = parseFixCommitLineRanges(DELETION_DIFF);
    // deletion-only: no + lines in the hunk, so no added lines to record.
    // The file has no in-scope lines and should not appear in the map.
    // This means findings on deleted-only files are conservatively preserved
    // (isLineInScope returns true when the map is empty, or when the file is
    // absent from the map the lineRange check still applies at the caller site).
    // With a non-empty lineRange, a file absent from the map is out-of-scope.
    // But a deletion-only file never has findings at new-file line numbers anyway.
    expect(result.has("src/old.ts")).toBe(false);
  });

  test("handles hunk with no count (count defaults to 1)", () => {
    const diff = `
diff --git a/src/single.ts b/src/single.ts
--- a/src/single.ts
+++ b/src/single.ts
@@ -5 +5 @@
-old
+new
`.trim();
    const result = parseFixCommitLineRanges(diff);
    expect(result.has("src/single.ts")).toBe(true);
  });

  test("preserves file path case (case-sensitive filesystems require exact match)", () => {
    const diff = `
diff --git a/Src/Util.ts b/Src/Util.ts
--- a/Src/Util.ts
+++ b/Src/Util.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
`.trim();
    const result = parseFixCommitLineRanges(diff);
    // File path is stored as-is (without lowercasing) to preserve case.
    // On case-sensitive filesystems, Src/Util.ts and src/util.ts are distinct files.
    expect(result.has("Src/Util.ts")).toBe(true);
    expect(result.has("src/util.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractFixCommitDiff
// ---------------------------------------------------------------------------

describe("extractFixCommitDiff", () => {
  test("returns the provided diff unchanged with parsed ranges", () => {
    const timestamp = "2026-05-17T10:00:00Z";
    const result = extractFixCommitDiff(SAMPLE_DIFF, timestamp);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.lineRange.size).toBe(2);
  });

  test("returns empty ranges for empty diff", () => {
    const result = extractFixCommitDiff("", "2026-05-17T10:00:00Z");
    expect(result.diff).toBe("");
    expect(result.lineRange.size).toBe(0);
  });

  test("handles malformed diff gracefully (returns empty map)", () => {
    const malformed = "not a valid diff @@@ broken";
    const result = extractFixCommitDiff(malformed, "2026-05-17T10:00:00Z");
    // Should not throw; lineRange may be empty or partial
    expect(result.diff).toBe(malformed);
    expect(result.lineRange).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// isLineInScope
// ---------------------------------------------------------------------------

describe("isLineInScope", () => {
  let lineRange: FixCommitLineRangeMap;

  // Build a lineRange covering:
  //   src/foo.ts: lines 10-17 (range [10,17])
  //   src/bar.ts: lines 3-6 (range [3,6])
  const buildTestLineRange = (): FixCommitLineRangeMap =>
    new Map<string, Array<readonly [number, number]>>([
      ["src/foo.ts", [[10, 17]]],
      ["src/bar.ts", [[3, 6]]],
    ]);

  test("returns true for empty lineRange (conservative — preserve all)", () => {
    expect(isLineInScope("src/foo.ts", 5, undefined, new Map())).toBe(true);
  });

  test("returns true when line is undefined (conservative — preserve)", () => {
    lineRange = buildTestLineRange();
    expect(isLineInScope("src/foo.ts", undefined, undefined, lineRange)).toBe(true);
  });

  test("returns true when file:line is in scope", () => {
    lineRange = buildTestLineRange();
    expect(isLineInScope("src/foo.ts", 10, undefined, lineRange)).toBe(true);
    expect(isLineInScope("src/foo.ts", 15, undefined, lineRange)).toBe(true);
    expect(isLineInScope("src/foo.ts", 17, undefined, lineRange)).toBe(true);
  });

  test("returns false when file is not in the map", () => {
    lineRange = buildTestLineRange();
    expect(isLineInScope("src/baz.ts", 5, undefined, lineRange)).toBe(false);
  });

  test("returns false when line is outside all ranges for the file", () => {
    lineRange = buildTestLineRange();
    expect(isLineInScope("src/foo.ts", 5, undefined, lineRange)).toBe(false);
    expect(isLineInScope("src/foo.ts", 18, undefined, lineRange)).toBe(false);
  });

  test("returns true when finding range overlaps scope range (start overlap)", () => {
    lineRange = buildTestLineRange();
    // Finding covers lines 8-12; scope is 10-17 → overlap at 10-12
    expect(isLineInScope("src/foo.ts", 8, 12, lineRange)).toBe(true);
  });

  test("returns true when finding range overlaps scope range (end overlap)", () => {
    lineRange = buildTestLineRange();
    // Finding covers lines 15-20; scope is 10-17 → overlap at 15-17
    expect(isLineInScope("src/foo.ts", 15, 20, lineRange)).toBe(true);
  });

  test("returns false when finding range is completely before scope", () => {
    lineRange = buildTestLineRange();
    // Finding covers lines 1-5; scope is 10-17 → no overlap
    expect(isLineInScope("src/foo.ts", 1, 5, lineRange)).toBe(false);
  });

  test("returns false when finding range is completely after scope", () => {
    lineRange = buildTestLineRange();
    // Finding covers lines 20-25; scope is 10-17 → no overlap
    expect(isLineInScope("src/foo.ts", 20, 25, lineRange)).toBe(false);
  });

  test("is case-sensitive for file paths (matches exact case)", () => {
    lineRange = buildTestLineRange();
    // lineRange uses lowercase keys (src/foo.ts); uppercase input does NOT match
    // because file paths are case-sensitive on Linux/macOS case-sensitive FS.
    expect(isLineInScope("Src/Foo.ts", 10, undefined, lineRange)).toBe(false);
    // Exact lowercase match works
    expect(isLineInScope("src/foo.ts", 10, undefined, lineRange)).toBe(true);
  });

  test("handles file paths with a/ and b/ prefixes", () => {
    lineRange = buildTestLineRange();
    expect(isLineInScope("b/src/foo.ts", 10, undefined, lineRange)).toBe(true);
    expect(isLineInScope("a/src/foo.ts", 10, undefined, lineRange)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyDiffScopeBoundedDowngrade
// ---------------------------------------------------------------------------

describe("applyDiffScopeBoundedDowngrade", () => {
  const buildLineRange = (): FixCommitLineRangeMap =>
    new Map<string, Array<readonly [number, number]>>([["src/foo.ts", [[10, 20]]]]);

  const makeBlockingFinding = (file: string, line: number, lineEnd?: number): ReviewToolCall => ({
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file,
      line,
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      summary: "test finding",
      details: "test details",
    },
  });

  const makeNonBlockingFinding = (file: string, line: number): ReviewToolCall => ({
    name: "submit_finding",
    args: {
      severity: "NON-BLOCKING",
      file,
      line,
      summary: "test finding",
      details: "test details",
    },
  });

  const makeConcludeReview = (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  ): ReviewToolCall => ({
    name: "conclude_review",
    args: { event, summary: "test summary" },
  });

  test("no downgrades when lineRange is empty (conservative)", () => {
    const toolCalls = [makeBlockingFinding("src/foo.ts", 5)];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, new Map());
    expect(result.downgradeApplied).toBe(false);
    expect(result.downgrades).toHaveLength(0);
    expect(result.toolCalls).toHaveLength(1);
    expect((result.toolCalls[0] as any).args.severity).toBe("BLOCKING");
  });

  test("downgrades BLOCKING finding outside fix-commit-diff range", () => {
    const lineRange = buildLineRange(); // src/foo.ts: lines 10-20
    // Finding at line 5 is outside range
    const toolCalls = [makeBlockingFinding("src/foo.ts", 5)];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(true);
    expect(result.downgrades).toHaveLength(1);
    const downgrade = result.downgrades[0];
    if (downgrade === undefined) throw new Error("downgrade should be defined");
    expect(downgrade.fromSeverity).toBe("BLOCKING");
    expect(downgrade.toSeverity).toBe("NON-BLOCKING");
    expect((result.toolCalls[0] as any).args.severity).toBe("NON-BLOCKING");
  });

  test("preserves BLOCKING finding inside fix-commit-diff range", () => {
    const lineRange = buildLineRange(); // src/foo.ts: lines 10-20
    const toolCalls = [makeBlockingFinding("src/foo.ts", 15)];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(false);
    expect(result.downgrades).toHaveLength(0);
    expect((result.toolCalls[0] as any).args.severity).toBe("BLOCKING");
  });

  test("downgrades BLOCKING for file not in fix-commit-diff", () => {
    const lineRange = buildLineRange(); // only src/foo.ts
    // src/bar.ts is not in the lineRange
    const toolCalls = [makeBlockingFinding("src/bar.ts", 5)];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(true);
    expect(result.downgrades).toHaveLength(1);
  });

  test("does not touch NON-BLOCKING findings", () => {
    const lineRange = buildLineRange();
    const toolCalls = [
      makeNonBlockingFinding("src/bar.ts", 5), // out of scope but not BLOCKING
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(false);
    expect((result.toolCalls[0] as any).args.severity).toBe("NON-BLOCKING");
  });

  test("reconciles conclude_review REQUEST_CHANGES → COMMENT when all BLOCKINGs downgraded", () => {
    const lineRange = buildLineRange(); // src/foo.ts: 10-20
    // All findings outside scope
    const toolCalls: ReviewToolCall[] = [
      makeBlockingFinding("src/bar.ts", 5), // out of scope
      makeConcludeReview("REQUEST_CHANGES"),
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(true);
    const concludeCall = result.toolCalls.find((tc) => tc.name === "conclude_review");
    expect(concludeCall).toBeDefined();
    expect((concludeCall as any).args.event).toBe("COMMENT");
  });

  test("does NOT reconcile conclude_review when some BLOCKINGs remain in scope", () => {
    const lineRange = buildLineRange(); // src/foo.ts: 10-20
    const toolCalls: ReviewToolCall[] = [
      makeBlockingFinding("src/foo.ts", 15), // in scope — preserved
      makeBlockingFinding("src/bar.ts", 5), // out of scope — downgraded
      makeConcludeReview("REQUEST_CHANGES"),
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(true);
    const concludeCall = result.toolCalls.find((tc) => tc.name === "conclude_review");
    expect((concludeCall as any).args.event).toBe("REQUEST_CHANGES"); // not reconciled
  });

  test("mixed findings: some in scope, some out of scope", () => {
    const lineRange = buildLineRange(); // src/foo.ts: 10-20
    const toolCalls: ReviewToolCall[] = [
      makeBlockingFinding("src/foo.ts", 15), // in scope → preserved
      makeBlockingFinding("src/foo.ts", 5), // out of scope → downgraded
      makeBlockingFinding("src/bar.ts", 1), // out of scope (file not in map) → downgraded
      makeNonBlockingFinding("src/foo.ts", 100), // non-blocking → untouched
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.downgradeApplied).toBe(true);
    expect(result.downgrades).toHaveLength(2);
    // First toolCall (line 15): still BLOCKING
    expect((result.toolCalls[0] as any).args.severity).toBe("BLOCKING");
    // Second toolCall (line 5): now NON-BLOCKING
    expect((result.toolCalls[1] as any).args.severity).toBe("NON-BLOCKING");
    // Third toolCall (bar.ts line 1): now NON-BLOCKING
    expect((result.toolCalls[2] as any).args.severity).toBe("NON-BLOCKING");
    // Fourth toolCall (non-blocking): unchanged
    expect((result.toolCalls[3] as any).args.severity).toBe("NON-BLOCKING");
  });

  test("preserves non-finding tool calls (conclude_review, inline comments)", () => {
    const lineRange = buildLineRange();
    const toolCalls: ReviewToolCall[] = [
      makeBlockingFinding("src/foo.ts", 15), // in scope
      makeConcludeReview("APPROVE"),
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, lineRange);
    expect(result.toolCalls).toHaveLength(2);
    const concludeCall2 = result.toolCalls[1];
    if (concludeCall2 === undefined) throw new Error("concludeCall2 should be defined");
    expect(concludeCall2.name).toBe("conclude_review");
    expect((concludeCall2 as any).args.event).toBe("APPROVE"); // unchanged
  });

  test("R1 path: when lineRange is empty, full-PR diff is preserved unchanged", () => {
    // This tests the spec's R1 requirement: when no fix-commit-diff is supplied
    // (empty lineRange), all findings are preserved exactly.
    const toolCalls: ReviewToolCall[] = [
      makeBlockingFinding("src/foo.ts", 5),
      makeBlockingFinding("src/bar.ts", 100),
      makeConcludeReview("REQUEST_CHANGES"),
    ];
    const result = applyDiffScopeBoundedDowngrade(toolCalls, new Map());
    expect(result.downgradeApplied).toBe(false);
    expect(result.toolCalls.length).toBe(3);
    for (const tc of result.toolCalls) {
      if (tc.name === "submit_finding") {
        expect(tc.args.severity).toBe("BLOCKING");
      }
      if (tc.name === "conclude_review") {
        expect((tc as any).args.event).toBe("REQUEST_CHANGES");
      }
    }
  });

  test("finding with no line number is preserved (conservative)", () => {
    const lineRange = buildLineRange();
    // submit_finding with no line field
    const noLineFinding: ReviewToolCall = {
      name: "submit_finding",
      args: {
        severity: "BLOCKING",
        file: "src/bar.ts", // not in lineRange
        line: undefined as unknown as number, // explicitly absent
        summary: "no line finding",
        details: "details",
      },
    };
    const result = applyDiffScopeBoundedDowngrade([noLineFinding], lineRange);
    // Conservative: no line → preserve
    expect(result.downgradeApplied).toBe(false);
    expect((result.toolCalls[0] as any).args.severity).toBe("BLOCKING");
  });
});

// ---------------------------------------------------------------------------
// Integration: acceptance test from spec
// ---------------------------------------------------------------------------

describe("acceptance tests", () => {
  test("AT1: extractFixCommitDiff returns only fix-commit diff for given timestamp", () => {
    // The caller supplies the already-filtered diff (only new commits).
    // extractFixCommitDiff parses it and returns ranges.
    const fixCommitDiff = `
diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -20,5 +20,7 @@
 context
+fix1
+fix2
 context
`.trim();

    const result = extractFixCommitDiff(fixCommitDiff, "2026-05-17T10:00:00Z");
    expect(result.diff).toBe(fixCommitDiff);
    // src/foo.ts: newStart=20 → context(20), +fix1(21), +fix2(22), context(23)
    // Only added lines 21 and 22 are in scope (coalesced: [21, 22]).
    expect(result.lineRange.has("src/foo.ts")).toBe(true);
    const ranges = result.lineRange.get("src/foo.ts");
    if (ranges === undefined)
      throw new Error("fix-commit lineRange for src/foo.ts should be defined");
    expect(ranges.length).toBeGreaterThan(0);
    // The finding at line 42 (not in fix-commit added-line range) should be downgraded
    expect(isLineInScope("src/foo.ts", 42, undefined, result.lineRange)).toBe(false);
    // The finding at line 21 (added line in fix-commit) should be preserved
    expect(isLineInScope("src/foo.ts", 21, undefined, result.lineRange)).toBe(true);
    // Context line 20 is NOT in scope (only + lines are in scope)
    expect(isLineInScope("src/foo.ts", 20, undefined, result.lineRange)).toBe(false);
  });

  test("AT2: downgrade logic — BLOCKING outside fix-commit-diff range → NON-BLOCKING", () => {
    // Spec acceptance test: a submit_finding with file:line=foo.ts:42 where the
    // fix-commit-diff doesn't touch foo.ts:42 is downgraded to NON-BLOCKING.
    const lineRange: FixCommitLineRangeMap = new Map([
      ["src/foo.ts", [[10, 20] as [number, number]]],
    ]);
    const finding: ReviewToolCall = {
      name: "submit_finding",
      args: {
        severity: "BLOCKING",
        file: "src/foo.ts",
        line: 42, // outside [10,20]
        summary: "test",
        details: "test",
      },
    };
    const result = applyDiffScopeBoundedDowngrade([finding], lineRange);
    expect(result.downgradeApplied).toBe(true);
    expect(result.downgrades).toHaveLength(1);
    expect((result.toolCalls[0] as any).args.severity).toBe("NON-BLOCKING");
  });

  test("AT3: R1 path — full-PR diff supplied, behavior unchanged", () => {
    // When priorReviewsMarkdown is empty (R1), the lineRange should be empty
    // (caller does not invoke extractFixCommitDiff) or full diff is used.
    // Either way, applyDiffScopeBoundedDowngrade with empty map preserves all.
    const findings: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/foo.ts", line: 42, summary: "x", details: "y" },
      },
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/bar.ts", line: 1, summary: "x", details: "y" },
      },
    ];
    const result = applyDiffScopeBoundedDowngrade(findings, new Map());
    expect(result.downgradeApplied).toBe(false);
    expect(result.toolCalls.length).toBe(2);
    expect((result.toolCalls[0] as any).args.severity).toBe("BLOCKING");
    expect((result.toolCalls[1] as any).args.severity).toBe("BLOCKING");
  });
});
