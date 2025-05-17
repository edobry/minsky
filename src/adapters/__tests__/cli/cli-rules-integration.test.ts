import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readContentFromFileIfExists, parseGlobs } from "../../cli/rules.js";
import * as path from "path";
import { promises as fs } from "fs";
import { existsSync } from "fs";

// Test to verify the full integration of the fixes
describe("Rules CLI Integration Tests", () => {
  // Create test dir and files for each test run
  const testDir = path.join(process.cwd(), "test-tmp", `cli-rules-integration-${Date.now()}`);
  const testFilePath = path.join(testDir, "rules-content.md");
  const testContent = "# Test Rule Content\n\nThis is test content for a rule";

  beforeEach(async () => {
    // Create test directory and file
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testFilePath, testContent);
  });

  afterEach(async () => {
    // Clean up
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  // Test the integration of our readContentFromFileIfExists function
  test("CLI should handle content from file", async () => {
    // Should read the content of the file
    const content = await readContentFromFileIfExists(testFilePath);
    expect(content).toBe(testContent);

    // Should return the input string when it's not a file path
    const nonFilePath = "This is just content, not a file path";
    const directContent = await readContentFromFileIfExists(nonFilePath);
    expect(directContent).toBe(nonFilePath);
  });

  // Test the integration of our parseGlobs function
  test("CLI should handle glob patterns in different formats", () => {
    // Test comma-separated globs
    const commaGlobs = parseGlobs("**/*.ts,**/*.js,*.md");
    expect(commaGlobs).toEqual(["**/*.ts", "**/*.js", "*.md"]);

    // Test JSON array format
    const jsonGlobs = parseGlobs('["**/*.ts", "**/*.js", "*.md"]');
    expect(jsonGlobs).toEqual(["**/*.ts", "**/*.js", "*.md"]);

    // Test undefined input
    const undefinedGlobs = parseGlobs(undefined);
    expect(undefinedGlobs).toBeUndefined();
  });
}); 
