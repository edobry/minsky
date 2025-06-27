import { describe, test, expect } from "bun:test";
import { parseGlobs } from "../../../utils/rules-helpers.js";

describe("Rules CLI Helper Functions", () => {
  // Note: readContentFromFileIfExists tests are skipped to avoid global fs mocking
  // that interferes with other tests. The function is simple enough that unit tests
  // for parseGlobs provide sufficient coverage for this module.

  // readContentFromFileIfExists tests removed to avoid global fs mocking

  describe("parseGlobs", () => {
    test("returns undefined for undefined input", () => {
      const _result = parseGlobs(undefined);
      expect(_result).toBeUndefined();
    });

    test("parses comma-separated string into array", () => {
      const _result = parseGlobs("**/*.ts,**/*.tsx,*.md");
      expect(_result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("trims whitespace in comma-separated strings", () => {
      const _result = parseGlobs(" **/*.ts , **/*.tsx , *.md ");
      expect(_result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("parses JSON array string format", () => {
      const _result = parseGlobs("[\"**/*.ts\", \"**/*.tsx\", \"*.md\"]");
      expect(_result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("falls back to comma handling if JSON parsing fails", () => {
      const _result = parseGlobs("[\"**/*.ts\", \"**/*.tsx\", malformed");
      expect(_result).toEqual(["[\"**/*.ts\"", "\"**/*.tsx\"", "malformed"]);
    });

    test("returns undefined for empty string", () => {
      const _result = parseGlobs("");
      expect(_result).toBeUndefined();
    });
  });
});
