/**
 * Tests for the diff utilities (mt#3071).
 *
 * These exist because `session_edit_file`'s response is about to report WHERE an
 * edit landed, and that report is only worth having if it is correct for edits
 * that change line count. Before mt#3071 these functions compared lines
 * positionally, so a single inserted line rendered the whole tail of the file as
 * changed — the `insertion` cases below are the regression guards for that.
 */
import { describe, expect, test } from "bun:test";
import {
  computeChangedRange,
  describeChangedRange,
  generateDiffSummary,
  generateUnifiedDiff,
} from "./diff";

/** Eight distinct lines — long enough that a wrong answer is obvious. */
const BASE = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");

describe("computeChangedRange", () => {
  test("identical content -> null (a no-op edit is itself a signal)", () => {
    expect(computeChangedRange(BASE, BASE)).toBeNull();
  });

  test("same-length replacement reports exactly the replaced line", () => {
    const modified = ["a", "b", "c", "REPLACED", "e", "f", "g", "h"].join("\n");
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 4,
      originalCount: 1,
      finalStart: 4,
      finalCount: 1,
    });
  });

  test("insertion reports one added line, not the shifted tail", () => {
    const modified = ["a", "b", "NEW", "c", "d", "e", "f", "g", "h"].join("\n");
    // diff -u convention: a zero-count side reports the line the change follows.
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 2,
      originalCount: 0,
      finalStart: 3,
      finalCount: 1,
    });
  });

  test("deletion reports one removed line, not the shifted tail", () => {
    const modified = ["a", "b", "d", "e", "f", "g", "h"].join("\n");
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 3,
      originalCount: 1,
      finalStart: 2,
      finalCount: 0,
    });
  });

  test("prepending reports a zero-indexed original start", () => {
    const modified = ["FIRST", ...["a", "b", "c", "d", "e", "f", "g", "h"]].join("\n");
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 0,
      originalCount: 0,
      finalStart: 1,
      finalCount: 1,
    });
  });

  test("appending reports a range past the original's end", () => {
    const modified = [...["a", "b", "c", "d", "e", "f", "g", "h"], "LAST"].join("\n");
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 8,
      originalCount: 0,
      finalStart: 9,
      finalCount: 1,
    });
  });

  test("two disjoint changes report the bounding range covering both", () => {
    const modified = ["a", "B!", "c", "d", "e", "f", "G!", "h"].join("\n");
    // Lines 2..7 bound both edits; the untouched head (1) and tail (8) stay out.
    expect(computeChangedRange(BASE, modified)).toEqual({
      originalStart: 2,
      originalCount: 6,
      finalStart: 2,
      finalCount: 6,
    });
  });

  // PR #2238 R1: creating and clearing a file used to report a 1-line
  // REPLACEMENT, because "".split("\n") is [""] — one empty line. The range
  // disagreed with generateDiffSummary, which special-cased it. Both now go
  // through the same zero-line normalization.
  test("creating a file reports a pure insertion, not a replacement", () => {
    expect(computeChangedRange("", "a\nb\nc")).toEqual({
      originalStart: 0,
      originalCount: 0,
      finalStart: 1,
      finalCount: 3,
    });
  });

  test("clearing a file reports a pure deletion, not a replacement", () => {
    expect(computeChangedRange("a\nb\nc", "")).toEqual({
      originalStart: 1,
      originalCount: 3,
      finalStart: 0,
      finalCount: 0,
    });
  });

  test("a repeated line is not counted in both the prefix and the suffix", () => {
    // "x" repeats; a naive suffix walk could overlap the prefix and produce a
    // negative changed-region length.
    const original = ["x", "x"].join("\n");
    const modified = ["x"].join("\n");
    expect(computeChangedRange(original, modified)).toEqual({
      originalStart: 2,
      originalCount: 1,
      finalStart: 1,
      finalCount: 0,
    });
  });
});

describe("generateUnifiedDiff", () => {
  test("identical content emits headers and no hunk", () => {
    expect(generateUnifiedDiff(BASE, BASE, "t.ts")).toBe("--- t.ts\n+++ t.ts");
  });

  test("same-length replacement emits one removed and one added line", () => {
    const modified = ["a", "b", "c", "REPLACED", "e", "f", "g", "h"].join("\n");
    const diff = generateUnifiedDiff(BASE, modified, "t.ts");
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(removed).toEqual(["-d"]);
    expect(added).toEqual(["+REPLACED"]);
  });

  test("insertion emits ONLY the inserted line — the mt#3071 regression guard", () => {
    const modified = ["a", "b", "NEW", "c", "d", "e", "f", "g", "h"].join("\n");
    const diff = generateUnifiedDiff(BASE, modified, "t.ts");
    const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    // The positional comparator this replaced emitted 6 removals and 7 additions here.
    expect(removed).toEqual([]);
    expect(added).toEqual(["+NEW"]);
  });

  test("creating a file emits only additions and a zero-length original side", () => {
    const diff = generateUnifiedDiff("", "a\nb", "t.ts");
    expect(diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
    // diff -u emits `-0,0` for a create; the old code claimed a line 1 that
    // never existed and emitted a phantom removal of the empty line.
    expect(diff).toContain("@@ -0,0 +1,2 @@");
  });

  test("clearing a file emits only removals and a zero-length final side", () => {
    const diff = generateUnifiedDiff("a\nb", "", "t.ts");
    expect(diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toEqual([]);
    expect(diff).toContain("@@ -1,2 +0,0 @@");
  });

  test("hunk header line counts match the lines the hunk actually contains", () => {
    const modified = ["a", "b", "c", "REPLACED", "e", "f", "g", "h"].join("\n");
    const lines = generateUnifiedDiff(BASE, modified, "t.ts").split("\n");
    const header = lines.find((l) => l.startsWith("@@"));
    expect(header).toBeDefined();
    const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(header as string);
    expect(match).not.toBeNull();
    const [, , originalLength, , modifiedLength] = match as RegExpExecArray;

    const body = lines.slice(lines.indexOf(header as string) + 1);
    const originalSide = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const modifiedSide = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(originalSide).toBe(Number(originalLength));
    expect(modifiedSide).toBe(Number(modifiedLength));
  });
});

describe("generateDiffSummary", () => {
  test("insertion counts one added line, not the shifted tail", () => {
    const modified = ["a", "b", "NEW", "c", "d", "e", "f", "g", "h"].join("\n");
    // The positional comparator reported { linesAdded: 7, linesRemoved: 6 } here.
    expect(generateDiffSummary(BASE, modified)).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
      linesChanged: 0,
      totalLines: 9,
    });
  });

  test("same-length replacement counts one line changed in place", () => {
    const modified = ["a", "b", "c", "REPLACED", "e", "f", "g", "h"].join("\n");
    expect(generateDiffSummary(BASE, modified)).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
      linesChanged: 1,
      totalLines: 8,
    });
  });

  test("identical content counts nothing changed", () => {
    expect(generateDiffSummary(BASE, BASE)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      linesChanged: 0,
      totalLines: 8,
    });
  });

  test("empty original counts every line as added", () => {
    expect(generateDiffSummary("", "a\nb")).toEqual({
      linesAdded: 2,
      linesRemoved: 0,
      linesChanged: 0,
      totalLines: 2,
    });
  });

  test("empty result counts every line as removed", () => {
    expect(generateDiffSummary("a\nb", "")).toEqual({
      linesAdded: 0,
      linesRemoved: 2,
      linesChanged: 0,
      totalLines: 0,
    });
  });

  // The three exported functions must agree; PR #2238 R1 was a case where they
  // did not, because only one of them special-cased the empty side.
  test("summary and range agree on a create", () => {
    const summary = generateDiffSummary("", "a\nb\nc");
    const range = computeChangedRange("", "a\nb\nc");
    expect(summary.linesRemoved).toBe(range?.originalCount as number);
    expect(summary.linesAdded).toBe(range?.finalCount as number);
  });

  test("summary and range agree on an insertion", () => {
    const modified = ["a", "b", "NEW", "c", "d", "e", "f", "g", "h"].join("\n");
    const summary = generateDiffSummary(BASE, modified);
    const range = computeChangedRange(BASE, modified);
    expect(summary.linesRemoved).toBe(range?.originalCount as number);
    expect(summary.linesAdded).toBe(range?.finalCount as number);
  });
});

describe("describeChangedRange", () => {
  test("no-op edit says so rather than naming a line", () => {
    expect(describeChangedRange(null)).toBe("no lines changed");
  });

  test("single changed line", () => {
    expect(
      describeChangedRange({ originalStart: 4, originalCount: 1, finalStart: 4, finalCount: 1 })
    ).toBe("changed line 4");
  });

  test("multi-line change names the span", () => {
    expect(
      describeChangedRange({ originalStart: 2, originalCount: 6, finalStart: 2, finalCount: 6 })
    ).toBe("changed lines 2-7");
  });

  test("insertion is described as inserted, not changed", () => {
    expect(
      describeChangedRange({ originalStart: 2, originalCount: 0, finalStart: 3, finalCount: 1 })
    ).toBe("inserted line 3");
  });

  test("deletion names the removed original lines", () => {
    expect(
      describeChangedRange({ originalStart: 3, originalCount: 2, finalStart: 2, finalCount: 0 })
    ).toBe("removed lines 3-4");
  });
});
