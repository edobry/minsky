/**
 * Unit tests for the severity-monotonicity recovery layer (mt#1496).
 *
 * Tests both the diff parser (parseDiffAddedRanges) and the recovery
 * decision (applyMonotonicityRecovery) in isolation. Pure functions with
 * no I/O; all inputs are inline literals.
 */

import { describe, expect, test } from "bun:test";
import {
  applyMonotonicityRecovery,
  parseDiffAddedRanges,
  parsePriorBodyFindings,
  parsePriorReviewFindings,
  parseUnifiedDiff,
  type FlatPriorFinding,
} from "./severity-recovery";
import type { ReviewToolCall } from "./output-tools";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function finding(
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING",
  file: string,
  line: number,
  lineEnd?: number
): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity,
      file,
      line,
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      summary: "test finding",
      details: "test details",
    },
  };
}

const SIMPLE_DIFF_NEW_LINES_ON_FOO = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@ context line
 unchanged line
-removed line
+added line at 11
+second added line at 12
 unchanged line
`;

const DIFF_TOUCHING_OTHER_FILE_ONLY = `diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,3 +1,4 @@
 line
+new line at 2
 line
 line
`;

// ---------------------------------------------------------------------------
// parseDiffAddedRanges
// ---------------------------------------------------------------------------

describe("parseDiffAddedRanges", () => {
  test("returns empty map on empty input", () => {
    expect(parseDiffAddedRanges("")).toEqual(new Map());
  });

  test("captures contiguous additions as a single range", () => {
    const result = parseDiffAddedRanges(SIMPLE_DIFF_NEW_LINES_ON_FOO);
    expect(result.get("src/foo.ts")).toEqual([[11, 12]]);
  });

  test("captures multiple non-contiguous additions as separate ranges", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,5 +1,7 @@
 line1
+added2
 line3
 line4
+added6
 line7
`;
    const result = parseDiffAddedRanges(diff);
    // line1 + added2 + line3 line4 + added6 line7
    // After "line1" (new=1), "+added2" (new=2), "line3" (new=3), "line4" (new=4), "+added6" (new=5)
    // wait, re-reading: hunk says +1,7 but only 6 lines listed. Let me trace:
    //   new=1 line1
    //   new=2 +added2
    //   new=3 line3
    //   new=4 line4
    //   new=5 +added6
    //   new=6 line7
    expect(result.get("x.ts")).toEqual([
      [2, 2],
      [5, 5],
    ]);
  });

  test("ignores deleted lines (no new-file advance)", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,3 @@
 keep
-remove1
-remove2
 keep
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.get("x.ts") ?? []).toEqual([]);
  });

  test("handles multiple files in one diff", () => {
    const combined = SIMPLE_DIFF_NEW_LINES_ON_FOO + DIFF_TOUCHING_OTHER_FILE_ONLY;
    const result = parseDiffAddedRanges(combined);
    expect(result.get("src/foo.ts")).toEqual([[11, 12]]);
    expect(result.get("src/other.ts")).toEqual([[2, 2]]);
  });

  test("deleted-file diffs (+++ /dev/null) report empty added ranges (PR #922 R3)", () => {
    // Pre-PR-#922-R3 the parseDiffAddedRanges shim was expected to drop
    // deleted files entirely (the old `currentFile = null` branch). Now:
    // the parser captures the OLD path and records removed ranges under
    // it, so the file IS in the map but with an empty added array.
    // Backwards-compat shim returns just the added ranges.
    const diff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line
-line
-line
`;
    const result = parseDiffAddedRanges(diff);
    // gone.ts now appears in the map (with empty added range).
    expect(result.get("gone.ts")).toEqual([]);
  });

  test("multiple hunks on same file accumulate ranges", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 a
+added2
 b
 c
@@ -10,3 +11,4 @@
 d
+added12
 e
 f
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.get("a.ts")).toEqual([
      [2, 2],
      [12, 12],
    ]);
  });

  test("ignores diff metadata lines between hunks (PR #922 R1#1/R1#2)", () => {
    // `index abc..def`, `new file mode`, `\ No newline at end of file`,
    // `rename from/to`, `Binary files` and friends must NOT advance the
    // new-file line counter when they appear between or after hunks.
    const diff = `diff --git a/x.ts b/x.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/x.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
\\ No newline at end of file
diff --git a/y.ts b/y.ts
similarity index 90%
rename from y.ts
rename to renamed.ts
index 1234567..7654321 100644
--- a/y.ts
+++ b/renamed.ts
@@ -10,2 +10,3 @@
 keep
+inserted
 keep2
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.get("x.ts")).toEqual([[1, 3]]);
    expect(result.get("renamed.ts")).toEqual([[11, 11]]);
    expect(result.get("y.ts")).toBeUndefined();
  });

  test("inHunk gate prevents context-line bleed between files (PR #922 R1#1)", () => {
    // Pre-fix: a non-hunk `diff --git` line between two hunk-less file
    // sections fell into the generic "context line" branch and advanced
    // currentNewLine on the previous file. Now: explicit inHunk reset.
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 keep
+added
 keep2
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,2 +5,3 @@
 keep
+addedB
 keep2
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.get("a.ts")).toEqual([[2, 2]]);
    expect(result.get("b.ts")).toEqual([[6, 6]]);
  });

  test("parseUnifiedDiff captures removed-line ranges (PR #922 R2#1)", () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,5 +10,3 @@
 keep
-removed11
-removed12
 keep
 keep
`;
    const result = parseUnifiedDiff(diff);
    expect(result.removed.get("x.ts")).toEqual([[11, 12]]);
    // No additions in this hunk → empty added entry.
    expect(result.added.get("x.ts")).toEqual([]);
  });

  test("parseUnifiedDiff captures removed lines on deleted files (PR #922 R3)", () => {
    // Pre-PR-#922-R3 the parser saw `+++ /dev/null` and set currentFile=null,
    // dropping the deletion's `-` lines entirely. Now: the parser captures
    // the OLD path from the `--- a/X` header and uses it as currentFile
    // when `+++ /dev/null` arrives, so removed ranges are recorded under
    // the deleted file's path.
    const diff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;
    const result = parseUnifiedDiff(diff);
    expect(result.removed.get("deleted.ts")).toEqual([[1, 3]]);
    // No additions on a deleted file.
    expect(result.added.get("deleted.ts")).toEqual([]);
  });

  test("applyMonotonicityRecovery preserves BLOCKING on deleted file (PR #922 R3)", () => {
    // Combined effect: deleted-file removed ranges + unspecified-side
    // overlap check. Pre-PR-#922-R3 a finding citing a line in a fully
    // deleted file would always be downgraded; now it's preserved when
    // the cited line is in the deleted range.
    const prior: FlatPriorFinding[] = [{ file: "deleted.ts", severity: "NON-BLOCKING", line: 2 }];
    const tc = [finding("BLOCKING", "deleted.ts", 2)];
    const diff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;
    const result = applyMonotonicityRecovery(tc, prior, diff);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("parseUnifiedDiff captures rename mappings (PR #922 R2#2)", () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 80%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,2 +1,3 @@
 keep
+added
 keep2
`;
    const result = parseUnifiedDiff(diff);
    expect(result.renames.get("old-name.ts")).toBe("new-name.ts");
    expect(result.added.get("new-name.ts")).toEqual([[2, 2]]);
  });

  test("parseDiffAddedRanges remains backwards compatible (PR #922 R2)", () => {
    // Existing callers expect just a Map<string, ranges>. The shim should
    // forward to parseUnifiedDiff().added without exposing the new fields.
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,3 @@
 keep
+added
 keep2
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.get("x.ts")).toEqual([[2, 2]]);
  });

  test("`--- a/...` header resets currentFile (PR #922 R2#2)", () => {
    // If a malformed/truncated diff has `--- a/X` followed by `@@` without
    // an intervening `+++ b/...`, we must NOT accumulate added lines under
    // a stale currentFile from the previous section.
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 keep
+addedA
 keep2
diff --git a/b.ts b/b.ts
--- a/b.ts
@@ -1,1 +1,2 @@
 keep
+orphaned
`;
    // The orphaned hunk has no +++ header. addedB must NOT be attributed
    // to a.ts (the previous file).
    const result = parseDiffAddedRanges(diff);
    expect(result.get("a.ts")).toEqual([[2, 2]]);
    // b.ts has no entry because its +++ header never appeared.
    expect(result.has("b.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsePriorBodyFindings + parsePriorReviewFindings
// ---------------------------------------------------------------------------

describe("parsePriorBodyFindings", () => {
  test("returns empty on empty body", () => {
    expect(parsePriorBodyFindings("")).toEqual([]);
    expect(parsePriorBodyFindings("   ")).toEqual([]);
  });

  test("parses bare [BLOCKING] (production format) with line", () => {
    const body = "[BLOCKING] src/foo.ts:42 — bad thing";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
  });

  test("parses bold-wrapped **[BLOCKING]** with line", () => {
    const body = "**[BLOCKING]** src/foo.ts:42 — bad";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
  });

  test("parses line ranges (171-176)", () => {
    const body = "[BLOCKING] src/foo.ts:171-176 — broad concern";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 171, lineEnd: 176 },
    ]);
  });

  test("parses NON-BLOCKING and PRE-EXISTING severities", () => {
    const body = "[NON-BLOCKING] src/a.ts:10 — nit\n[PRE-EXISTING] src/b.ts:20 — old";
    const findings = parsePriorBodyFindings(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.severity).toBe("NON-BLOCKING");
    expect(findings[1]?.severity).toBe("PRE-EXISTING");
  });

  test("parses finding without line number", () => {
    const body = "[BLOCKING] src/foo.ts — broad concern";
    expect(parsePriorBodyFindings(body)).toEqual([{ file: "src/foo.ts", severity: "BLOCKING" }]);
  });

  test("parses extensionless and dotfile paths (PR #922 R1#4 / R2#1)", () => {
    const body = [
      "[BLOCKING] Dockerfile:12 — security issue",
      "[NON-BLOCKING] Makefile:5 — minor target",
      "[BLOCKING] .env:1 — leaked secret",
      "[NON-BLOCKING] .eslintrc.json:3 — config drift",
      "[BLOCKING] LICENSE — license incompatibility",
    ].join("\n");
    const findings = parsePriorBodyFindings(body);
    expect(findings.map((f) => f.file)).toEqual([
      "Dockerfile",
      "Makefile",
      ".env",
      ".eslintrc.json",
      "LICENSE",
    ]);
  });

  test("rejects one-sided bold wrappers (PR #922 R1)", () => {
    const body = "**[BLOCKING] src/foo.ts:42 — stray open\n[BLOCKING]** src/bar.ts:5 — stray close";
    expect(parsePriorBodyFindings(body)).toEqual([]);
  });

  test("parses range citations into line + lineEnd (PR #922 R1)", () => {
    const body = "[BLOCKING] src/foo.ts:171-176 — range citation";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 171, lineEnd: 176 },
    ]);
  });

  test("does not match severity in prose without file path", () => {
    const body = "Conclusion: [BLOCKING] above are the issues.";
    expect(parsePriorBodyFindings(body)).toEqual([]);
  });

  test("parses Windows-style backslash paths (PR #922 R7#2)", () => {
    // Real bodies may cite paths with backslashes (cross-platform contributors,
    // pasted Windows output, etc). Pre-fix the path char class excluded `\`.
    const body = "[BLOCKING] packages\\app\\src\\Foo.ts:10 — broken";
    const findings = parsePriorBodyFindings(body);
    expect(findings).toEqual([
      { file: "packages\\app\\src\\Foo.ts", severity: "BLOCKING", line: 10 },
    ]);
  });

  test("parses bare-colon path before dash (PR #922 R5#2)", () => {
    // Real bodies sometimes use a bare colon with no line number:
    // "[BLOCKING] LICENSE: — text". Pre-fix the regex required digits
    // when the colon was present.
    const body =
      "[BLOCKING] LICENSE: — incompatibility\n[NON-BLOCKING] Dockerfile: – security review";
    const findings = parsePriorBodyFindings(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("LICENSE");
    expect(findings[1]?.file).toBe("Dockerfile");
  });

  test("parses ASCII hyphen as dash separator (PR #922 R2#3)", () => {
    // Real bodies may use ASCII '-' instead of em-dash due to typing
    // variation or Markdown rendering. Pre-fix, the regex hardcoded U+2014.
    const body = [
      "[BLOCKING] src/foo.ts:42 - bad thing",
      "[BLOCKING] LICENSE - incompatible terms",
    ].join("\n");
    const findings = parsePriorBodyFindings(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("src/foo.ts");
    expect(findings[0]?.line).toBe(42);
    expect(findings[1]?.file).toBe("LICENSE");
  });

  test("parses en-dash separator (PR #922 R2#3)", () => {
    const body = "[BLOCKING] src/foo.ts:42 – en-dash variant";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ]);
  });

  test("preserves ASCII hyphens inside path names (PR #922 R2#3)", () => {
    // Path-internal hyphens must NOT be confused with the description
    // separator. Real example: `task-spec-fetch.ts`. The dash-boundary
    // alternative requires whitespace around the dash to disambiguate.
    const body = "[BLOCKING] services/reviewer/src/task-spec-fetch.ts:42 — broken";
    expect(parsePriorBodyFindings(body)).toEqual([
      {
        file: "services/reviewer/src/task-spec-fetch.ts",
        severity: "BLOCKING",
        line: 42,
      },
    ]);
  });

  test("accepts paths with parenthesized annotations (PR #922 R14)", () => {
    // Real bot review bodies sometimes cite paths with bracketed labels:
    // `docs/Guide (draft).md`, `examples/v1 (deprecated)/foo.ts`.
    const body = [
      "[NON-BLOCKING] docs/Guide (draft).md:12 — nit",
      "[BLOCKING] examples/v1 (deprecated)/foo.ts:5 — bad",
    ].join("\n");
    const findings = parsePriorBodyFindings(body);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      file: "docs/Guide (draft).md",
      severity: "NON-BLOCKING",
      line: 12,
    });
    expect(findings[1]).toEqual({
      file: "examples/v1 (deprecated)/foo.ts",
      severity: "BLOCKING",
      line: 5,
    });
  });

  test("rejects bare-prose over-match (no parens, no path-like chars)", () => {
    // Critical negative case: severity marker followed by English prose
    // ending in a dash boundary must NOT be parsed as a finding. The path
    // alt requires either path chars OR `(...)` continuation, so prose
    // like "above are issues" cannot grow past the first word.
    const body = "Conclusion: [BLOCKING] above are issues — see context";
    expect(parsePriorBodyFindings(body)).toEqual([]);
  });

  test("accepts paths with bare spaces (PR #922 R15#1)", () => {
    // Some real codebases use spaced filenames: `src/My Component.tsx`.
    // The permissive path branch allows spaces but requires `.`, `/`, or
    // `\\` somewhere — pure prose without those chars is still rejected.
    const body = "[BLOCKING] src/My Component.tsx:12 — bad pattern";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "src/My Component.tsx", severity: "BLOCKING", line: 12 },
    ]);
  });

  test("accepts paths with commas (PR #922 R15#1)", () => {
    // Comma-containing paths (rare but valid): `examples/foo,bar.ts`.
    const body = "[NON-BLOCKING] examples/foo,bar.ts:3 — note";
    expect(parsePriorBodyFindings(body)).toEqual([
      { file: "examples/foo,bar.ts", severity: "NON-BLOCKING", line: 3 },
    ]);
  });

  test("rejects prose with space adjacent to slash (PR #922 R19#1)", () => {
    // Bot flagged that bare `[BLOCKING] see /docs — text` could match
    // with file=`see /docs`. Segment grammar forbids bare space adjacent
    // to a `/` separator outside parens.
    const body = "Conclusion: [BLOCKING] see /docs — for details";
    expect(parsePriorBodyFindings(body)).toEqual([]);
  });

  test("rejects URL-style strings (PR #922 R19#1)", () => {
    // URLs like `http://example.com/foo.html` should not be parsed as
    // file paths. The `://` sequence is rejected because `:` is not in
    // the segment char class.
    const body = "[BLOCKING] http://example.com/foo.html — broken link";
    expect(parsePriorBodyFindings(body)).toEqual([]);
  });
});

describe("parsePriorReviewFindings", () => {
  test("aggregates findings across multiple bodies", () => {
    const bodies = [
      "[BLOCKING] src/a.ts:1 — first review blocker",
      "[NON-BLOCKING] src/b.ts:5 — second review nit",
    ];
    expect(parsePriorReviewFindings(bodies)).toEqual([
      { file: "src/a.ts", severity: "BLOCKING", line: 1 },
      { file: "src/b.ts", severity: "NON-BLOCKING", line: 5 },
    ]);
  });

  test("returns empty for empty list", () => {
    expect(parsePriorReviewFindings([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyMonotonicityRecovery
// ---------------------------------------------------------------------------

describe("applyMonotonicityRecovery", () => {
  test("downgrades BLOCKING when prior NON-BLOCKING and no new diff lines on range", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const diff = ""; // no diff at all → no new lines
    const result = applyMonotonicityRecovery(tc, prior, diff);
    expect(result.toolCalls).toHaveLength(1);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
    expect(result.downgrades).toHaveLength(1);
    expect(result.downgrades[0]?.matchingPriorSeverity).toBe("NON-BLOCKING");
  });

  test("downgrades BLOCKING when prior PRE-EXISTING and no new diff lines on range", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "PRE-EXISTING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
    expect(result.downgrades[0]?.matchingPriorSeverity).toBe("PRE-EXISTING");
  });

  test("preserves BLOCKING when prior was also BLOCKING", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("preserves BLOCKING when file has no prior finding at all", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/other.ts", severity: "NON-BLOCKING", line: 1 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("preserves BLOCKING when diff introduces new lines overlapping the cited range", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    // BLOCKING cited at line 11, which is exactly where SIMPLE_DIFF_NEW_LINES_ON_FOO adds lines.
    const tc = [finding("BLOCKING", "src/foo.ts", 11)];
    const result = applyMonotonicityRecovery(tc, prior, SIMPLE_DIFF_NEW_LINES_ON_FOO);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("downgrades when diff touches the file but not the cited range", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 100 }];
    // BLOCKING cited at line 100, but diff only adds at lines 11-12.
    const tc = [finding("BLOCKING", "src/foo.ts", 100)];
    const result = applyMonotonicityRecovery(tc, prior, SIMPLE_DIFF_NEW_LINES_ON_FOO);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
    expect(result.downgrades).toHaveLength(1);
  });

  test("multi-line range overlap: cited range 11-15, diff adds 11-12 — overlaps, preserve", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 11, 15)];
    const result = applyMonotonicityRecovery(tc, prior, SIMPLE_DIFF_NEW_LINES_ON_FOO);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
  });

  test("multi-line range no overlap: cited range 50-60, diff adds 11-12 — downgrade", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 50, 60)];
    const result = applyMonotonicityRecovery(tc, prior, SIMPLE_DIFF_NEW_LINES_ON_FOO);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
  });

  test("non-finding tool calls pass through unchanged", () => {
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5), // will be downgraded
      {
        name: "submit_inline_comment",
        args: { file: "src/foo.ts", line: 5, body: "comment" },
      },
      {
        name: "submit_spec_verification",
        args: { criterion: "X", status: "Met", evidence: "see line 5" },
      },
      {
        name: "conclude_review",
        args: { event: "REQUEST_CHANGES", summary: "review summary" },
      },
    ];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls[1]?.name).toBe("submit_inline_comment");
    expect(result.toolCalls[2]?.name).toBe("submit_spec_verification");
    expect(result.toolCalls[3]?.name).toBe("conclude_review");
    expect(result.downgrades).toHaveLength(1);
  });

  test("partial downgrade: 2 of 3 BLOCKING are inflated", () => {
    const prior: FlatPriorFinding[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING" },
      { file: "src/b.ts", severity: "PRE-EXISTING" },
    ];
    const tc = [
      finding("BLOCKING", "src/a.ts", 5), // downgrade (NON-BLOCKING prior, no new diff)
      finding("BLOCKING", "src/b.ts", 5), // downgrade (PRE-EXISTING prior, no new diff)
      finding("BLOCKING", "src/c.ts", 5), // keep (no prior finding on c.ts)
    ];
    const result = applyMonotonicityRecovery(tc, prior, "");
    const severities = result.toolCalls.map((t) =>
      t.name === "submit_finding" ? t.args.severity : "?"
    );
    expect(severities).toEqual(["NON-BLOCKING", "NON-BLOCKING", "BLOCKING"]);
    expect(result.downgrades).toHaveLength(2);
  });

  test("returns input unchanged when priorFindings is empty", () => {
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, [], "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("when prior file has both NON-BLOCKING and PRE-EXISTING, NON-BLOCKING wins for telemetry", () => {
    const prior: FlatPriorFinding[] = [
      { file: "src/foo.ts", severity: "PRE-EXISTING", line: 1 },
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const tc = [finding("BLOCKING", "src/foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(result.downgrades[0]?.matchingPriorSeverity).toBe("NON-BLOCKING");
  });

  test("never downgrades LEFT-side findings even with prior NON-BLOCKING (PR #922 R1#3)", () => {
    // LEFT-side findings cite line numbers in the OLD/base file, not the
    // new file. parseDiffAddedRanges only models new-file additions, so a
    // LEFT-side finding's range can never overlap and would always downgrade
    // — over-eagerly removing legitimate re-escalations on removed code.
    // Conservative policy: never downgrade LEFT-side, regardless of priors.
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 50 }];
    const tc: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/foo.ts",
          line: 50,
          side: "LEFT",
          summary: "deletion concern",
          details: "removed code",
        },
      },
    ];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("preserves BLOCKING when side undefined and finding overlaps removed lines (PR #922 R2#1)", () => {
    // Unspecified-side findings on deletions cite line numbers in the OLD
    // file. Without a removed-range check, applyMonotonicityRecovery would
    // see no added overlap and downgrade. Now: removed-range check fires
    // when side is undefined.
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc = [finding("BLOCKING", "src/foo.ts", 11)];
    // Diff that REMOVES lines 11-12 of the old file (no additions).
    const diffWithRemovals = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,4 +10,2 @@
 keep
-removed11
-removed12
 keep
`;
    const result = applyMonotonicityRecovery(tc, prior, diffWithRemovals);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("preserves BLOCKING on rename: new-path finding with undefined side overlapping old-path removed lines (PR #922 R12)", () => {
    // R4#2 fix: removed lines on renames are keyed under OLD path so LEFT-
    // side overlap works for old-path findings. R12 catch: but a current
    // finding citing the NEW path with side undefined would query removed
    // ranges by NEW path and miss because they're under OLD path.
    // Now: removedRanges unions both lookups so the overlap check sees the
    // old-path removals too.
    const prior: FlatPriorFinding[] = [
      { file: "src/old-name.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const tc = [finding("BLOCKING", "src/new-name.ts", 11)]; // side undefined
    const renameDiff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 70%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -10,3 +10,1 @@
 keep
-removed11
-removed12
`;
    const result = applyMonotonicityRecovery(tc, prior, renameDiff);
    // Should preserve BLOCKING — the cited line 11 overlaps removed-range
    // 11-12 on the OLD path. Pre-R12 the lookup was only by NEW path which
    // had no removed entries, and the rename's conservative-preserve branch
    // would have also preserved (so this test specifically demonstrates the
    // removed-range path now works correctly).
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
  });

  test("normalizes current finding's backslash path against POSIX diff ranges (PR #922 R11)", () => {
    // Inverse direction of R10: current finding cites a backslash path,
    // diff reports added ranges under POSIX. Pre-R11 the rename map and
    // added/removed range lookups used tc.args.file directly (without
    // normalization), so a backslash current path would miss POSIX-keyed
    // ranges and trigger a wrongful downgrade. Now: normalize before all
    // three lookups (renames, added, removed).
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const tc = [
      finding("BLOCKING", "src\\foo.ts", 11), // backslash form
    ];
    const diffWithRightAdditions = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,2 +10,4 @@
 keep
+added11
+added12
 keep
`;
    const result = applyMonotonicityRecovery(tc, prior, diffWithRightAdditions);
    // Diff adds lines 11-12; finding cites line 11. Should preserve BLOCKING.
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("normalizes backslash paths to match POSIX-style current findings (PR #922 R10)", () => {
    // Prior finding cites a Windows-style path; current finding (from
    // production reviewer-bot) uses POSIX-style. Without normalization,
    // the lookup misses and gating fails. Now: both sides normalize
    // backslashes to forward slashes before map insert/lookup.
    const prior: FlatPriorFinding[] = [
      { file: "packages\\app\\Foo.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const tc = [finding("BLOCKING", "packages/app/Foo.ts", 5)];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
    expect(result.downgrades).toHaveLength(1);
  });

  test("preserves BLOCKING on rename pairs when finding cites NEW path with prior on OLD path (PR #922 R4#1)", () => {
    // Inverse direction of R2#2: prior finding was on the old path, current
    // finding cites the new path. Pre-PR-#922-R4 the stickyByFile lookup
    // was strictly by current path and missed this case.
    const prior: FlatPriorFinding[] = [
      { file: "src/old-name.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const tc = [finding("BLOCKING", "src/new-name.ts", 5)];
    const renameDiff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 80%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 keep1
 keep2
 keep3
`;
    const result = applyMonotonicityRecovery(tc, prior, renameDiff);
    // Rename + no overlapping additions = preserve (rename always conservative).
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
  });

  test("preserves BLOCKING on rename pairs when finding cites old path (PR #922 R2#2)", () => {
    // Renames attribute additions to the new path. A finding citing the
    // OLD path would see no added-range overlap and be downgraded — the
    // rename map preserves BLOCKING in this case.
    const prior: FlatPriorFinding[] = [
      { file: "src/old-name.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const tc = [finding("BLOCKING", "src/old-name.ts", 5)];
    const renameDiff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 80%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,4 @@
 keep
+added
 keep2
 keep3
`;
    const result = applyMonotonicityRecovery(tc, prior, renameDiff);
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("BLOCKING");
    expect(result.downgrades).toHaveLength(0);
  });

  test("RIGHT-side findings still downgrade per the standard rule (PR #922 R1#3)", () => {
    // Sanity check: explicit RIGHT side does not affect downgrade semantics.
    const prior: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 50 }];
    const tc: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/foo.ts",
          line: 50,
          side: "RIGHT",
          summary: "right-side concern",
          details: "added code",
        },
      },
    ];
    const result = applyMonotonicityRecovery(tc, prior, "");
    expect(
      result.toolCalls[0]?.name === "submit_finding" ? result.toolCalls[0].args.severity : null
    ).toBe("NON-BLOCKING");
    expect(result.downgrades).toHaveLength(1);
  });
});
