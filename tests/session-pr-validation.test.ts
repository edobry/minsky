import { describe, it, expect } from "bun:test";
import {
  validatePrContent,
  isDuplicateContent,
  preparePrContent,
} from "../src/domain/session/pr-validation";

describe("Session PR Body Validation", () => {
  describe("title duplication detection", () => {
    const TEST_TITLE = "feat(mt#478): Implement Context-Aware Rules Filtering";

    it("should detect duplicate content with different formatting", () => {
      const duplicatedLine =
        "# feat(#478): Implement Context-Aware Rules Filtering for Workspace Rules Component";

      expect(isDuplicateContent(TEST_TITLE, duplicatedLine)).toBe(true);
    });

    it("should reject PR body that starts with the same title as PR", () => {
      const prTitle = TEST_TITLE;
      const prBody = `# feat(#478): Implement Context-Aware Rules Filtering for Workspace Rules Component

## Summary

This is the actual content...`;

      const validationResult = validatePrContent(prTitle, prBody);

      expect(validationResult.isValid).toBe(false);
      expect(validationResult.errors).toContain(
        "PR body must not repeat the title as the first line"
      );
    });

    it("should accept PR body that starts with proper content", () => {
      const prTitle = TEST_TITLE;
      const prBody = `## Summary

Implemented an enhanced rules system...`;

      const validationResult = validatePrContent(prTitle, prBody);

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.errors).toEqual([]);
    });

    it("should handle case variations in title duplication", () => {
      const prTitle = "feat(mt#478): Implement Context-Aware Rules";
      const prBody = `# FEAT(#478): IMPLEMENT CONTEXT-AWARE RULES

Content here...`;

      const validationResult = validatePrContent(prTitle, prBody);

      expect(validationResult.isValid).toBe(false);
      expect(validationResult.errors).toContain(
        "PR body must not repeat the title as the first line"
      );
    });

    it("should allow similar but not duplicate titles", () => {
      const prTitle = "feat(mt#478): Implement Rules";
      const prBody = `# Implementation Details

## Rules Enhancement

Content about rules...`;

      const validationResult = validatePrContent(prTitle, prBody);

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.errors).toEqual([]);
    });
  });

  describe("PR content preparation", () => {
    it("should sanitize duplicate title content from body", () => {
      const title = "feat: Add new feature";
      const body = `# feat: Add new feature

## Summary
Content here`;

      const result = preparePrContent(title, body);

      expect(result.title).toBe(title);
      expect(result.body).toBe("## Summary\nContent here");
      expect(result.warnings).toContain("Removed duplicate title content from PR body");
    });

    it("should handle empty body gracefully", () => {
      const title = "feat: Add feature";
      const result = preparePrContent(title, "");

      expect(result.title).toBe(title);
      expect(result.body).toBe("");
      expect(result.warnings).toEqual([]);
    });

    it("should throw error for empty title", () => {
      expect(() => preparePrContent("", "body")).toThrow(
        "PR title is required and cannot be empty"
      );
    });
  });
});
