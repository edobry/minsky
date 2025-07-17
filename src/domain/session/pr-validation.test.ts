/**
 * Tests for PR validation utilities
 */

import { describe, test, expect } from "bun:test";
import { 
  validatePrContent,
  isDuplicateContent,
  sanitizePrBody,
  preparePrContent
} from "./pr-validation";

describe("PR Validation Utilities", () => {
  describe("validatePrContent", () => {
    test("should validate normal PR content without issues", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "## Summary\n\nThis PR fixes the issue where titles are duplicated.";
      
      const result = validatePrContent(title, body);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.sanitizedBody).toBe(body);
    });

    test("should detect and remove title duplication in body", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const duplicatedBody = "feat(#285): Fix session PR title duplication bug\n\n## Summary\n\nThis PR fixes the issue.";
      
      const result = validatePrContent(title, duplicatedBody);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.sanitizedBody).toBe("## Summary\n\nThis PR fixes the issue.");
    });

    test("should reject empty title", () => {
      const result = validatePrContent("", "Some body content");
      
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("PR title cannot be empty");
    });

    test("should handle empty body gracefully", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      
      const result = validatePrContent(title, "");
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.sanitizedBody).toBe("");
    });
  });

  describe("isDuplicateContent", () => {
    test("should detect identical content", () => {
      const content1 = "feat(#285): Fix session PR title duplication bug";
      const content2 = "feat(#285): Fix session PR title duplication bug";
      
      expect(isDuplicateContent(content1, content2)).toBe(true);
    });

    test("should detect content with different whitespace", () => {
      const content1 = "feat(#285): Fix session PR title duplication bug";
      const content2 = "  feat(#285):   Fix session   PR title duplication bug  ";
      
      expect(isDuplicateContent(content1, content2)).toBe(true);
    });

    test("should detect content with different case", () => {
      const content1 = "feat(#285): Fix session PR title duplication bug";
      const content2 = "FEAT(#285): FIX SESSION PR TITLE DUPLICATION BUG";
      
      expect(isDuplicateContent(content1, content2)).toBe(true);
    });

    test("should not match different content", () => {
      const content1 = "feat(#285): Fix session PR title duplication bug";
      const content2 = "feat(#286): Different issue";
      
      expect(isDuplicateContent(content1, content2)).toBe(false);
    });

    test("should handle empty strings", () => {
      expect(isDuplicateContent("", "")).toBe(false);
      expect(isDuplicateContent("content", "")).toBe(false);
      expect(isDuplicateContent("", "content")).toBe(false);
    });
  });

  describe("sanitizePrBody", () => {
    test("should remove lines that duplicate the title", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "feat(#285): Fix session PR title duplication bug\n\n## Summary\n\nThis PR fixes the issue.\n\nfeat(#285): Fix session PR title duplication bug\n\n## Changes\n\n- Fixed parsing";
      
      const result = sanitizePrBody(title, body);
      
      // Empty lines remain where duplicate titles were removed
      expect(result).toBe("## Summary\n\nThis PR fixes the issue.\n\n\n## Changes\n\n- Fixed parsing");
    });

    test("should preserve non-duplicate content", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "## Summary\n\nThis PR fixes the issue.\n\n## Changes\n\n- Fixed parsing";
      
      const result = sanitizePrBody(title, body);
      
      expect(result).toBe(body);
    });

    test("should handle empty body", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "";
      
      const result = sanitizePrBody(title, body);
      
      expect(result).toBe("");
    });
  });

  describe("preparePrContent", () => {
    test("should prepare normal content without changes", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "## Summary\n\nThis PR fixes the issue.";
      
      const result = preparePrContent(title, body);
      
      expect(result.title).toBe(title);
      expect(result.body).toBe(body);
      expect(result.warnings).toEqual([]);
    });

    test("should sanitize content with duplication and provide warnings", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      const body = "feat(#285): Fix session PR title duplication bug\n\n## Summary\n\nThis PR fixes the issue.";
      
      const result = preparePrContent(title, body);
      
      expect(result.title).toBe(title);
      expect(result.body).toBe("## Summary\n\nThis PR fixes the issue.");
      expect(result.warnings).toContain("Removed duplicate title content from PR body");
    });

    test("should throw error for empty title", () => {
      expect(() => preparePrContent("", "Some body")).toThrow("PR title is required and cannot be empty");
      expect(() => preparePrContent(undefined, "Some body")).toThrow("PR title is required and cannot be empty");
    });

    test("should handle undefined body", () => {
      const title = "feat(#285): Fix session PR title duplication bug";
      
      const result = preparePrContent(title, undefined);
      
      expect(result.title).toBe(title);
      expect(result.body).toBe("");
      expect(result.warnings).toEqual([]);
    });
  });
}); 
