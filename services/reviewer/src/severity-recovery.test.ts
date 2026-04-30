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

  test("ignores deleted-file diffs (+++ /dev/null)", () => {
    const diff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line
-line
-line
`;
    const result = parseDiffAddedRanges(diff);
    expect(result.has("gone.ts")).toBe(false);
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
