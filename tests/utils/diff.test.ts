/**
 * Tests for diff utility functions
 */
import { describe, test, expect } from "bun:test";
import { generateUnifiedDiff, generateDiffSummary } from "../../src/utils/diff";
import { DIFF_TEST_CONTENT } from "../../src/utils/test-utils/test-constants";

describe("Diff Utilities", () => {
  describe("generateUnifiedDiff", () => {
    test("should generate diff for simple text changes", () => {
      const original = DIFF_TEST_CONTENT.THREE_LINES;
      const modified = DIFF_TEST_CONTENT.MODIFIED_THREE_LINES;

      const diff = generateUnifiedDiff(original, modified, "test.txt");

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("-line 2");
      expect(diff).toContain("+modified line 2");
    });

    test("should generate diff for added lines", () => {
      const original = DIFF_TEST_CONTENT.TWO_LINES;
      const modified = DIFF_TEST_CONTENT.THREE_LINES;

      const diff = generateUnifiedDiff(original, modified, "test.txt");

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("+line 3");
    });

    test("should generate diff for removed lines", () => {
      const original = DIFF_TEST_CONTENT.THREE_LINES;
      const modified = DIFF_TEST_CONTENT.TWO_LINES_ONLY;

      const diff = generateUnifiedDiff(original, modified, "test.txt");

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("-line 2");
    });

    test("should handle completely new file", () => {
      const original = "";
      const modified = "new content\nline 2";

      const diff = generateUnifiedDiff(original, modified, "new-file.txt");

      expect(diff).toContain("--- new-file.txt");
      expect(diff).toContain("+++ new-file.txt");
      expect(diff).toContain("+new content");
      expect(diff).toContain("+line 2");
    });

    test("should handle empty modifications", () => {
      const original = "content";
      const modified = "";

      const diff = generateUnifiedDiff(original, modified, "test.txt");

      expect(diff).toContain("--- test.txt");
      expect(diff).toContain("+++ test.txt");
      expect(diff).toContain("-content");
    });

    test("should use default filename when not provided", () => {
      const original = "old";
      const modified = "new";

      const diff = generateUnifiedDiff(original, modified);

      expect(diff).toContain("--- file");
      expect(diff).toContain("+++ file");
    });
  });

  describe("generateDiffSummary", () => {
    test("should calculate correct statistics for changes", () => {
      const original = DIFF_TEST_CONTENT.THREE_LINES;
      const modified = DIFF_TEST_CONTENT.MODIFIED_THREE_LINES;

      const summary = generateDiffSummary(original, modified);

      // One line substituted: the trim leaves a 1-line original region and a
      // 1-line final region, so `linesChanged` — defined as the OVERLAP between
      // removed and added, `Math.min(originalCount, finalCount)` — is 1, not 0.
      // A substitution is simultaneously an add, a remove, and a replace; the
      // three fields are different views of one region, not a partition of it.
      expect(summary).toEqual({
        linesAdded: 1,
        linesRemoved: 1,
        linesChanged: 1,
        totalLines: 3,
      });
    });

    test("should calculate correct statistics for additions", () => {
      const original = DIFF_TEST_CONTENT.TWO_LINES;
      const modified = DIFF_TEST_CONTENT.FOUR_LINES;

      const summary = generateDiffSummary(original, modified);

      expect(summary).toEqual({
        linesAdded: 2,
        linesRemoved: 0,
        linesChanged: 0,
        totalLines: 4,
      });
    });

    test("should calculate correct statistics for removals", () => {
      const original = DIFF_TEST_CONTENT.FOUR_LINES;
      const modified = DIFF_TEST_CONTENT.FOUR_TO_TWO;

      const summary = generateDiffSummary(original, modified);

      // `line 1..4` -> `line 1\nline 4`. The trim (mt#3071) takes the common
      // prefix `line 1` and the common suffix `line 4`, leaving the original
      // region ["line 2","line 3"] against an EMPTY final region: 2 removed,
      // 0 added, overlap 0.
      //
      // This previously expected {added: 1, removed: 3} under a comment reading
      // "Our algorithm is positional, so 'line 4' moving to position 2 counts as
      // 1 substitution plus 2 pure removals" — describing the POSITIONAL
      // algorithm mt#3071 replaced. Both the comment and the numbers outlived
      // the implementation, and nothing caught it because `tests/utils` was not
      // in the runner's ROOTS until mt#3934 added it.
      expect(summary).toEqual({
        linesAdded: 0,
        linesRemoved: 2,
        linesChanged: 0,
        totalLines: 2,
      });
    });

    test("should handle new file", () => {
      const original = "";
      const modified = "new content\nline 2";

      const summary = generateDiffSummary(original, modified);

      expect(summary).toEqual({
        linesAdded: 2,
        linesRemoved: 0,
        linesChanged: 0,
        totalLines: 2,
      });
    });

    test("should handle file deletion", () => {
      const original = "content\nline 2";
      const modified = "";

      const summary = generateDiffSummary(original, modified);

      expect(summary).toEqual({
        linesAdded: 0,
        linesRemoved: 2,
        linesChanged: 0,
        totalLines: 0,
      });
    });

    test("should handle no changes", () => {
      const original = DIFF_TEST_CONTENT.THREE_LINES;
      const modified = DIFF_TEST_CONTENT.THREE_LINES;

      const summary = generateDiffSummary(original, modified);

      expect(summary).toEqual({
        linesAdded: 0,
        linesRemoved: 0,
        linesChanged: 0,
        totalLines: 3,
      });
    });
  });
});
