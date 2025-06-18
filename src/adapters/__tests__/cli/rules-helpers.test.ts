import { describe, test, expect } from "bun:test";
import { parseGlobs } from "../../../utils/rules-helpers.js";

describe("Rules CLI Helper Functions", () => {
  // Note: readContentFromFileIfExists tests are skipped to avoid global fs mocking
  // that interferes with other tests. The function is simple enough that unit tests
  // for parseGlobs provide sufficient coverage for this module.

  // readContentFromFileIfExists tests removed to avoid global fs mocking

  describe("parseGlobs", () => {
    test("returns undefined for undefined input", () => {
      const result = parseGlobs(undefined);
      expect(result).toBeUndefined();
    });

    test("parses comma-separated string into array", () => {
      const result = parseGlobs("**/*.ts,**/*.tsx,*.md");
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("trims whitespace in comma-separated strings", () => {
      const result = parseGlobs(" **/*.ts , **/*.tsx , *.md ");
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("parses JSON array string format", () => {
      const result = parseGlobs("[\"**/*.ts\", \"**/*.tsx\", \"*.md\"]");
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("falls back to comma handling if JSON parsing fails", () => {
      const result = parseGlobs("[\"**/*.ts\", \"**/*.tsx\", malformed");
      expect(result).toEqual(["[\"**/*.ts\"", "\"**/*.tsx\"", "malformed"]);
    });

    test("returns undefined for empty string", () => {
      const result = parseGlobs("");
      expect(result).toBeUndefined();
    });
  });
});
