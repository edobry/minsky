import { describe, test, expect } from "bun:test";
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers.ts";

describe("Rules CLI Core Functionality", () => {
  describe("readContentFromFileIfExists function", () => {
    test("returns input string when path doesn't exist", async () => {
      const nonExistentPath = "/non/existent/path.txt";
      const _result = await readContentFromFileIfExists(nonExistentPath);
      expect(_result).toBe(nonExistentPath);
    });
  });

  describe("parseGlobs function", () => {
    test("handles comma-separated glob patterns", () => {
      const _result = parseGlobs("**/*.ts,**/*.tsx,*.md");
      expect(_result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("handles JSON array glob patterns", () => {
      const _result = parseGlobs("[\"**/*.ts\", \"**/*.tsx\", \"*.md\"]");
      expect(_result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("returns undefined for undefined input", () => {
      const _result = parseGlobs(undefined);
      expect(_result).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
      const _result = parseGlobs("");
      expect(_result).toBeUndefined();
    });
  });
});
