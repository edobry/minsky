/**
 * Unit tests for the pure helpers in mine-ground-truth-corpus.ts (mt#2726
 * Milestone A, wave 2).
 *
 * All tests exercise fixture inputs directly — no live GitHub API calls, no
 * network. The GitHub-orchestration functions (fetchClosedMergedPrs,
 * fetchBotReviewRounds, fetchCompare, fetchCodeContextWindow, mineOnePr,
 * runDryRun, runFullMine) are intentionally NOT unit-tested here; they are
 * thin I/O wrappers around the pure helpers below, exercised instead via
 * `--dry-run` against the live API (see the PR body for that output).
 */

import { describe, expect, test } from "bun:test";
import type { BugPattern } from "./seeded-bug-harness";
import { BUG_CATALOG } from "./seeded-bug-harness";
import type { FlatFinding } from "../src/replay-summary";
import {
  buildInjectedBugCorpusRow,
  buildInjectedBugCorpusRows,
  deriveLabel,
  extractContextWindow,
  findingReRaised,
  parsePatchHunkRanges,
  regionChangedForFinding,
} from "./mine-ground-truth-corpus";

// ---------------------------------------------------------------------------
// deriveLabel
// ---------------------------------------------------------------------------

describe("deriveLabel", () => {
  test("region changed -> git-diff-fixed / noisy-positive", () => {
    const result = deriveLabel({ regionChanged: true, reRaised: false });
    expect(result).toEqual({ value: "git-diff-fixed", confidence: "noisy-positive" });
  });

  test("region unchanged, re-raised -> carried-forward-unchanged / noisy-negative", () => {
    const result = deriveLabel({ regionChanged: false, reRaised: true });
    expect(result).toEqual({ value: "carried-forward-unchanged", confidence: "noisy-negative" });
  });

  test("region unchanged, not re-raised -> dismissed-no-change / noisy-negative", () => {
    const result = deriveLabel({ regionChanged: false, reRaised: false });
    expect(result).toEqual({ value: "dismissed-no-change", confidence: "noisy-negative" });
  });

  test("region changed AND re-raised -> region-changed takes priority (git-diff-fixed)", () => {
    const result = deriveLabel({ regionChanged: true, reRaised: true });
    expect(result).toEqual({ value: "git-diff-fixed", confidence: "noisy-positive" });
  });
});

// ---------------------------------------------------------------------------
// extractContextWindow
// ---------------------------------------------------------------------------

describe("extractContextWindow", () => {
  test("extracts +/-80 lines around the anchor from a large file", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i + 1}`);
    const text = lines.join("\n");
    const window = extractContextWindow(text, 150);
    const windowLines = window.split("\n");
    // anchor 150 (1-based) -> index 149; window is [149-80, 149+80] inclusive -> 161 lines.
    expect(windowLines).toHaveLength(161);
    expect(windowLines[0]).toBe("line-70");
    expect(windowLines[windowLines.length - 1]).toBe("line-230");
  });

  test("clamps the start of the window at the beginning of the file", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    const text = lines.join("\n");
    const window = extractContextWindow(text, 5);
    const windowLines = window.split("\n");
    expect(windowLines[0]).toBe("line-1");
    expect(windowLines[windowLines.length - 1]).toBe("line-50");
  });

  test("clamps the end of the window at the end of the file", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    const text = lines.join("\n");
    const window = extractContextWindow(text, 20);
    const windowLines = window.split("\n");
    expect(windowLines[0]).toBe("line-1");
    expect(windowLines[windowLines.length - 1]).toBe("line-20");
  });
});

// ---------------------------------------------------------------------------
// parsePatchHunkRanges
// ---------------------------------------------------------------------------

describe("parsePatchHunkRanges", () => {
  test("parses a single hunk header with explicit length", () => {
    const patch = "@@ -10,5 +12,8 @@ function foo() {\n+added line\n context\n";
    expect(parsePatchHunkRanges(patch)).toEqual([{ start: 12, end: 19 }]);
  });

  test("defaults length to 1 when the hunk header omits it", () => {
    const patch = "@@ -3 +4 @@\n+added\n";
    expect(parsePatchHunkRanges(patch)).toEqual([{ start: 4, end: 4 }]);
  });

  test("parses multiple hunks in one patch", () => {
    const patch = "@@ -1,3 +1,3 @@\n context\n@@ -50,2 +51,4 @@\n context\n";
    expect(parsePatchHunkRanges(patch)).toEqual([
      { start: 1, end: 3 },
      { start: 51, end: 54 },
    ]);
  });

  test("returns empty array for a patch with no hunk headers", () => {
    expect(parsePatchHunkRanges("no hunks here")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// regionChangedForFinding
// ---------------------------------------------------------------------------

describe("regionChangedForFinding", () => {
  const finding: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING", line: 42 };

  test("true when the finding's line falls inside a changed hunk", () => {
    const compare = {
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -30,20 +30,25 @@\n" }],
    };
    // hunk covers post-image lines [30, 54]; finding at line 42 is inside.
    expect(regionChangedForFinding(compare, finding)).toBe(true);
  });

  test("false when the finding's line falls outside every changed hunk", () => {
    const compare = {
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -100,5 +100,5 @@\n" }],
    };
    expect(regionChangedForFinding(compare, finding)).toBe(false);
  });

  test("false when the file was not touched in the diff", () => {
    const compare = {
      files: [{ filename: "src/other.ts", status: "modified", patch: "@@ -1,5 +1,5 @@\n" }],
    };
    expect(regionChangedForFinding(compare, finding)).toBe(false);
  });

  test("conservative true when the file was touched but has no patch text", () => {
    const compare = { files: [{ filename: "src/foo.ts", status: "modified" }] };
    expect(regionChangedForFinding(compare, finding)).toBe(true);
  });

  test("conservative true when the finding has no line number", () => {
    const noLineFinding: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING" };
    const compare = {
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -1,5 +1,5 @@\n" }],
    };
    expect(regionChangedForFinding(compare, noLineFinding)).toBe(true);
  });

  test("true when a lineEnd range overlaps a changed hunk", () => {
    const rangeFinding: FlatFinding = {
      file: "src/foo.ts",
      severity: "BLOCKING",
      line: 5,
      lineEnd: 15,
    };
    const compare = {
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -1,3 +12,3 @@\n" }],
    };
    // hunk covers post-image [12,14]; finding range [5,15] overlaps at 12-14.
    expect(regionChangedForFinding(compare, rangeFinding)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findingReRaised
// ---------------------------------------------------------------------------

describe("findingReRaised", () => {
  const finding: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING", line: 42 };

  test("true when the next round has an overlapping finding on the same file", () => {
    const next: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 44 }];
    expect(findingReRaised(finding, next)).toBe(true);
  });

  test("false when the next round has no finding on that file", () => {
    const next: FlatFinding[] = [{ file: "src/bar.ts", severity: "BLOCKING", line: 42 }];
    expect(findingReRaised(finding, next)).toBe(false);
  });

  test("false when the next round's finding on the same file is far away", () => {
    const next: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 500 }];
    expect(findingReRaised(finding, next)).toBe(false);
  });

  test("false for an empty next-round findings list", () => {
    expect(findingReRaised(finding, [])).toBe(false);
  });

  test("conservative true when either side lacks a line number on the same file", () => {
    const noLineFinding: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING" };
    const next: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 999 }];
    expect(findingReRaised(noLineFinding, next)).toBe(true);
  });

  test("true when within the proximity threshold (line shifted by unrelated edits)", () => {
    const shifted: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING", line: 10 };
    const next: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 13 }];
    expect(findingReRaised(shifted, next)).toBe(true);
  });

  test("false just outside the proximity threshold", () => {
    const shifted: FlatFinding = { file: "src/foo.ts", severity: "BLOCKING", line: 10 };
    const next: FlatFinding[] = [{ file: "src/foo.ts", severity: "BLOCKING", line: 16 }];
    expect(findingReRaised(shifted, next)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildInjectedBugCorpusRow / buildInjectedBugCorpusRows
// ---------------------------------------------------------------------------

describe("buildInjectedBugCorpusRow", () => {
  test("maps a fixture BugPattern to the expected CorpusRow shape", () => {
    const bug: BugPattern = {
      name: "fixture-bug",
      description: "Fixture description of the bug",
      code: Array.from({ length: 30 }, (_, i) => `code-line-${i + 1}`).join("\n"),
      injectedLine: 15,
    };

    const row = buildInjectedBugCorpusRow(bug, "v1", "2026-07-21T00:00:00.000Z");

    expect(row.id).toBe("injected-fixture-bug");
    expect(row.corpusVersion).toBe("v1");
    expect(row.source).toBe("injected-bug");
    expect(row.prNumber).toBe(0);
    expect(row.round).toBe(0);
    expect(row.minedAt).toBe("2026-07-21T00:00:00.000Z");
    expect(row.finding).toEqual({
      file: "services/reviewer/scripts/__seeded_bug_targets__/fixture-bug.ts",
      severity: "BLOCKING",
      line: 15,
      text: "Fixture description of the bug",
    });
    expect(row.label).toEqual({
      value: "injected-exact",
      provenance: "deterministic",
      confidence: "gold",
    });
    // 30-line fixture, anchor at line 15 -> window is clamped to the whole file.
    const windowLines = row.codeContextWindow.split("\n");
    expect(windowLines[0]).toBe("code-line-1");
    expect(windowLines[windowLines.length - 1]).toBe("code-line-30");
  });

  test("finding.text is always non-empty (never undefined)", () => {
    const bug: BugPattern = {
      name: "empty-desc-bug",
      description: "",
      code: "line-1\nline-2",
      injectedLine: 1,
    };
    const row = buildInjectedBugCorpusRow(bug, "v1", "2026-07-21T00:00:00.000Z");
    // Even a fixture with an empty description gets a defined (if empty)
    // string, not undefined -- CorpusFinding.text is required, non-optional.
    expect(typeof row.finding.text).toBe("string");
  });
});

describe("buildInjectedBugCorpusRows", () => {
  test("maps every entry in the real BUG_CATALOG to a CorpusRow", () => {
    const rows = buildInjectedBugCorpusRows("v1", "2026-07-21T00:00:00.000Z");
    expect(rows).toHaveLength(BUG_CATALOG.length);

    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(BUG_CATALOG.map((b) => `injected-${b.name}`));

    for (const row of rows) {
      expect(row.source).toBe("injected-bug");
      expect(row.label.value).toBe("injected-exact");
      expect(row.label.confidence).toBe("gold");
      expect(row.finding.severity).toBe("BLOCKING");
      expect(row.finding.text.length).toBeGreaterThan(0);
      expect(row.codeContextWindow.length).toBeGreaterThan(0);
    }
  });

  test("off-by-one entry's finding.line matches the catalog's injectedLine", () => {
    const rows = buildInjectedBugCorpusRows("v1", "2026-07-21T00:00:00.000Z");
    const offByOne = rows.find((r) => r.id === "injected-off-by-one");
    const catalogEntry = BUG_CATALOG.find((b) => b.name === "off-by-one");
    expect(catalogEntry).toBeDefined();
    expect(offByOne?.finding.line).toBe(catalogEntry?.injectedLine);
  });
});
