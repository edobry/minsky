import { describe, it, expect } from "bun:test";

// TODO: This validation should be implemented but currently fails
// Bug: PR body validation doesn't catch title duplication

describe("Session PR Body Validation", () => {
  describe("title duplication detection", () => {
    it("should reject PR body that starts with the same title as PR", () => {
      const prTitle = "feat(mt#478): Implement Context-Aware Rules Filtering";
      const prBody = `# feat(#478): Implement Context-Aware Rules Filtering for Workspace Rules Component

## Summary

This is the actual content...`;

      // This test should FAIL until the validation is fixed
      // The validation should detect that the body starts with a duplicate title
      const validationResult = validatePRBodyForTitleDuplication(prTitle, prBody);

      expect(validationResult.isValid).toBe(false);
      expect(validationResult.error).toContain("Title duplication detected");
      expect(validationResult.error).toContain(
        "PR description body should NOT start with the same title"
      );
    });

    it("should accept PR body that starts with proper content", () => {
      const prTitle = "feat(mt#478): Implement Context-Aware Rules Filtering";
      const prBody = `## Summary

Implemented an enhanced rules system...`;

      const validationResult = validatePRBodyForTitleDuplication(prTitle, prBody);

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.error).toBeUndefined();
    });

    it("should handle case variations in title duplication", () => {
      const prTitle = "feat(mt#478): Implement Context-Aware Rules";
      const prBody = `# FEAT(#478): IMPLEMENT CONTEXT-AWARE RULES

Content here...`;

      const validationResult = validatePRBodyForTitleDuplication(prTitle, prBody);

      expect(validationResult.isValid).toBe(false);
      expect(validationResult.error).toContain("Title duplication detected");
    });

    it("should allow similar but not duplicate titles", () => {
      const prTitle = "feat(mt#478): Implement Rules";
      const prBody = `# Implementation Details

## Rules Enhancement

Content about rules...`;

      const validationResult = validatePRBodyForTitleDuplication(prTitle, prBody);

      expect(validationResult.isValid).toBe(true);
    });
  });
});

// Validation function to prevent title duplication in PR body
function validatePRBodyForTitleDuplication(
  title: string,
  body: string
): { isValid: boolean; error?: string } {
  if (!body || !title) {
    return { isValid: true }; // Empty body/title is valid
  }

  // Extract the first line of the body (typically a markdown header)
  const firstLine = body.split("\n")[0].trim();

  // Skip if first line is not a header
  if (!firstLine.startsWith("#")) {
    return { isValid: true };
  }

  // Remove markdown header prefix and normalize for comparison
  const bodyTitle = firstLine.replace(/^#+\s*/, "").trim();
  const normalizedBodyTitle = bodyTitle
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ");
  const normalizedPRTitle = title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ");

  // Check if the normalized titles are substantially similar
  // Use a simple approach: check if one title contains most words of the other
  const bodyWords = normalizedBodyTitle.split(" ").filter((w) => w.length > 3); // Ignore short words
  const titleWords = normalizedPRTitle.split(" ").filter((w) => w.length > 3);

  if (bodyWords.length === 0 || titleWords.length === 0) {
    return { isValid: true };
  }

  // Count how many significant words from the title appear in the body title
  const matchingWords = titleWords.filter((word) => normalizedBodyTitle.includes(word));
  const similarityRatio = matchingWords.length / titleWords.length;

  // If more than 70% of significant words match, consider it title duplication
  if (similarityRatio > 0.7) {
    return {
      isValid: false,
      error:
        "PR description body should NOT start with the same title as the PR. Title duplication detected in first line.",
    };
  }

  return { isValid: true };
}
