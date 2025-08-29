import { describe, it, expect } from "bun:test";

// Test the actual case that went wrong in PR #132
describe("Bug Fix Verification", () => {
  it("should catch the exact title duplication that occurred in PR #132", () => {
    // The actual title that was used
    const actualTitle = "feat(mt#478): Implement Context-Aware Rules Filtering";
    
    // The actual PR body that was created (problematic)
    const problematicBody = `# feat(#478): Implement Context-Aware Rules Filtering for Workspace Rules Component

## Summary

Implemented an enhanced rules system that provides context-aware filtering...`;

    const result = validatePRBodyForTitleDuplication(actualTitle, problematicBody);
    
    // This should FAIL validation (isValid = false)
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("Title duplication detected");
  });

  it("should accept the corrected PR body format", () => {
    const actualTitle = "feat(mt#478): Implement Context-Aware Rules Filtering";
    
    // The corrected body format (without title duplication)
    const correctedBody = `## Summary

Implemented an enhanced rules system that provides context-aware filtering based on Cursor's rule type system, significantly reducing context pollution while ensuring relevant rules are always available.

## Changes

### Added
- Rule Type Classification System
- Glob Pattern Matching
...`;

    const result = validatePRBodyForTitleDuplication(actualTitle, correctedBody);
    
    // This should PASS validation
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// Copy the validation function from the other test file
function validatePRBodyForTitleDuplication(title: string, body: string): { isValid: boolean; error?: string } {
  if (!body || !title) {
    return { isValid: true }; // Empty body/title is valid
  }

  // Extract the first line of the body (typically a markdown header)
  const firstLine = body.split('\n')[0].trim();
  
  // Skip if first line is not a header
  if (!firstLine.startsWith('#')) {
    return { isValid: true };
  }

  // Remove markdown header prefix and normalize for comparison
  const bodyTitle = firstLine.replace(/^#+\s*/, '').trim();
  const normalizedBodyTitle = bodyTitle.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
  const normalizedPRTitle = title.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

  // Check if the normalized titles are substantially similar
  // Use a simple approach: check if one title contains most words of the other
  const bodyWords = normalizedBodyTitle.split(' ').filter(w => w.length > 3); // Ignore short words
  const titleWords = normalizedPRTitle.split(' ').filter(w => w.length > 3);
  
  if (bodyWords.length === 0 || titleWords.length === 0) {
    return { isValid: true };
  }

  // Count how many significant words from the title appear in the body title
  const matchingWords = titleWords.filter(word => normalizedBodyTitle.includes(word));
  const similarityRatio = matchingWords.length / titleWords.length;

  // If more than 70% of significant words match, consider it title duplication
  if (similarityRatio > 0.7) {
    return {
      isValid: false,
      error: "PR description body should NOT start with the same title as the PR. Title duplication detected in first line."
    };
  }

  return { isValid: true };
}
