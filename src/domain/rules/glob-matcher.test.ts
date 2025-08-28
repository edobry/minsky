import { describe, it, expect } from "bun:test";

// TODO: This function should be implemented in glob-matcher.ts
import { matchesGlobPatterns, parseGlobsField } from "./glob-matcher";

describe("Glob Matching for Rules", () => {
  describe("parseGlobsField", () => {
    it("should parse array-style globs", () => {
      const globs = ["**/*.ts", "src/**/*.tsx", "!**/*.test.ts"];
      
      const parsed = parseGlobsField(globs);
      expect(parsed).toEqual(["**/*.ts", "src/**/*.tsx", "!**/*.test.ts"]);
    });

    it("should parse comma-separated string globs", () => {
      const globs = "**/*.ts, src/**/*.tsx, !**/*.test.ts";
      
      const parsed = parseGlobsField(globs);
      expect(parsed).toEqual(["**/*.ts", "src/**/*.tsx", "!**/*.test.ts"]);
    });

    it("should handle single string glob", () => {
      const globs = "**/*.test.ts";
      
      const parsed = parseGlobsField(globs);
      expect(parsed).toEqual(["**/*.test.ts"]);
    });

    it("should handle empty array", () => {
      const globs: string[] = [];
      
      const parsed = parseGlobsField(globs);
      expect(parsed).toEqual([]);
    });

    it("should handle null/undefined", () => {
      expect(parseGlobsField(null as any)).toEqual([]);
      expect(parseGlobsField(undefined as any)).toEqual([]);
    });

    it("should trim whitespace from patterns", () => {
      const globs = " **/*.ts , src/**/*.tsx , !**/*.test.ts ";
      
      const parsed = parseGlobsField(globs);
      expect(parsed).toEqual(["**/*.ts", "src/**/*.tsx", "!**/*.test.ts"]);
    });
  });

  describe("matchesGlobPatterns", () => {
    it("should match files against simple glob patterns", () => {
      const patterns = ["**/*.ts", "**/*.tsx"];
      const files = [
        "src/index.ts",
        "src/components/Button.tsx",
        "README.md"
      ];
      
      expect(matchesGlobPatterns(patterns, files)).toBe(true);
    });

    it("should return false when no files match", () => {
      const patterns = ["**/*.py"];
      const files = [
        "src/index.ts",
        "src/components/Button.tsx",
        "README.md"
      ];
      
      expect(matchesGlobPatterns(patterns, files)).toBe(false);
    });

    it("should handle negation patterns", () => {
      const patterns = ["**/*.ts", "!**/*.test.ts"];
      
      // Should match non-test TS files
      expect(matchesGlobPatterns(patterns, ["src/index.ts"])).toBe(true);
      
      // Should not match test files even though they're .ts
      expect(matchesGlobPatterns(patterns, ["src/index.test.ts"])).toBe(false);
    });

    it("should match specific directory patterns", () => {
      const patterns = ["src/components/**/*.tsx"];
      
      expect(matchesGlobPatterns(patterns, ["src/components/Button.tsx"])).toBe(true);
      expect(matchesGlobPatterns(patterns, ["src/components/forms/Input.tsx"])).toBe(true);
      expect(matchesGlobPatterns(patterns, ["src/utils/helper.tsx"])).toBe(false);
    });

    it("should handle exact file matches", () => {
      const patterns = ["package.json", "tsconfig.json"];
      
      expect(matchesGlobPatterns(patterns, ["package.json"])).toBe(true);
      expect(matchesGlobPatterns(patterns, ["src/package.json"])).toBe(false);
    });

    it("should handle empty patterns", () => {
      const patterns: string[] = [];
      const files = ["src/index.ts"];
      
      // No patterns means no match
      expect(matchesGlobPatterns(patterns, files)).toBe(false);
    });

    it("should handle empty files list", () => {
      const patterns = ["**/*.ts"];
      const files: string[] = [];
      
      // No files means no match
      expect(matchesGlobPatterns(patterns, files)).toBe(false);
    });

    it("should match with real-world Minsky patterns", () => {
      const patterns = ["src/**/*.ts", "src/**/*.md", "**/package.json"];
      
      const files = [
        "src/domain/rules/rule-classifier.ts",
        "src/domain/rules/README.md",
        "package.json",
        "src/components/package.json"
      ];
      
      expect(matchesGlobPatterns(patterns, files)).toBe(true);
    });

    it("should handle complex negation scenarios", () => {
      const patterns = ["src/**/*", "!src/**/*.test.*", "!src/**/__tests__/**"];
      
      expect(matchesGlobPatterns(patterns, ["src/index.ts"])).toBe(true);
      expect(matchesGlobPatterns(patterns, ["src/utils/helper.js"])).toBe(true);
      expect(matchesGlobPatterns(patterns, ["src/index.test.ts"])).toBe(false);
      expect(matchesGlobPatterns(patterns, ["src/__tests__/integration.ts"])).toBe(false);
    });
  });
});
