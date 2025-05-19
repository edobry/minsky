import { describe, test, expect } from "bun:test";
import { readContentFromFileIfExists, parseGlobs } from "../../cli/rules.js";

describe("Rules CLI Core Functionality", () => {
  describe("readContentFromFileIfExists function", () => {
    test("returns input string when path doesn't exist", async () => {
      const nonExistentPath = "/non/existent/path.txt";
      const result = await readContentFromFileIfExists(nonExistentPath);
      expect(result).toBe(nonExistentPath);
    });
  });

  describe("parseGlobs function", () => {
    test("handles comma-separated glob patterns", () => {
      const result = parseGlobs("**/*.ts,**/*.tsx,*.md");
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("handles JSON array glob patterns", () => {
      const result = parseGlobs('["**/*.ts", "**/*.tsx", "*.md"]');
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("returns undefined for undefined input", () => {
      const result = parseGlobs(undefined);
      expect(result).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
      const result = parseGlobs("");
      expect(result).toBeUndefined();
    });
  });
});
