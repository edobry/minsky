import { describe, it, expect } from "bun:test";
import { validatePrContent, isDuplicateContent } from "../src/domain/session/pr-validation";

// Test the actual case that went wrong in PR #132
describe("Bug Fix Verification", () => {
  it("should catch the exact title duplication that occurred in PR #132", () => {
    // The actual title that was used
    const actualTitle = "feat(mt#478): Implement Context-Aware Rules Filtering";

    // The actual PR body that was created (problematic)
    const problematicBody = `# feat(#478): Implement Context-Aware Rules Filtering for Workspace Rules Component

## Summary

Implemented an enhanced rules system that provides context-aware filtering...`;

    const result = validatePrContent(actualTitle, problematicBody);

    // This should FAIL validation (isValid = false)
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("PR body must not repeat the title as the first line");
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

    const result = validatePrContent(actualTitle, correctedBody);

    // This should PASS validation
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should detect subtle variations in title duplication", () => {
    const title = "feat(mt#123): Add new functionality";
    const duplicateLine = "# feat: Add new functionality";

    expect(isDuplicateContent(title, duplicateLine)).toBe(true);
  });

  it("should handle task ID format variations", () => {
    const title = "feat(md#456): Update system";
    const duplicateLine = "# feat: Update system";

    expect(isDuplicateContent(title, duplicateLine)).toBe(true);
  });
});
