import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import * as path from "path";
import { readContentFromFileIfExists, parseGlobs } from "../../cli/rules.js";

// Create a realistic temp directory for file tests
const testDir = path.join(process.cwd(), "test-tmp", `rules-helpers-test-${Date.now()}`);
const testFilePath = path.join(testDir, "test-content.txt");
const testContent = "This is test content for the rules helper functions";

describe("Rules CLI Helper Functions", () => {
  beforeEach(async () => {
    // Create test directory and file
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testFilePath, testContent);
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("readContentFromFileIfExists", () => {
    test("reads content from file if file exists", async () => {
      // When a file path is provided and the file exists
      const content = await readContentFromFileIfExists(testFilePath);
      
      // Then the file content is returned
      expect(content).toBe(testContent);
    });

    test("returns input as content if file does not exist", async () => {
      // When a path is provided but the file doesn't exist
      const nonExistentPath = "/path/does/not/exist.txt";
      const content = await readContentFromFileIfExists(nonExistentPath);
      
      // Then the input path is returned as the content
      expect(content).toBe(nonExistentPath);
    });

    test("throws error if file exists but cannot be read", async () => {
      // When a directory is provided as a file path
      const dirAsFilePath = testDir;
      
      // Then an error is thrown
      await expect(readContentFromFileIfExists(dirAsFilePath)).rejects.toThrow(
        "Failed to read content from file"
      );
    });
  });

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
      const result = parseGlobs('["**/*.ts", "**/*.tsx", "*.md"]');
      expect(result).toEqual(["**/*.ts", "**/*.tsx", "*.md"]);
    });

    test("falls back to comma handling if JSON parsing fails", () => {
      const result = parseGlobs('["**/*.ts", "**/*.tsx", malformed');
      expect(result).toEqual(['["**/*.ts"', '"**/*.tsx"', 'malformed']);
    });

    test("returns undefined for empty string", () => {
      const result = parseGlobs("");
      expect(result).toBeUndefined();
    });
  });
}); 
