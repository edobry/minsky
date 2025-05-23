import { describe, test, expect } from "bun:test";
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers.ts";

// Test to verify the helper functions work correctly
describe("Rules CLI Helper Functions Integration", () => {
  test("parseGlobs handles different format patterns", () => {
    // Test comma-separated globs
    const commaGlobs = parseGlobs("**/*.ts,**/*.js,*.md");
    expect(commaGlobs).toEqual(["**/*.ts", "**/*.js", "*.md"]);

    // Test JSON array format
    const jsonGlobs = parseGlobs("[\"**/*.ts\", \"**/*.js\", \"*.md\"]");
    expect(jsonGlobs).toEqual(["**/*.ts", "**/*.js", "*.md"]);

    // Test undefined input
    const undefinedGlobs = parseGlobs(undefined);
    expect(undefinedGlobs).toBeUndefined();

    // Test empty string
    const emptyGlobs = parseGlobs("");
    expect(emptyGlobs).toBeUndefined();
  });

  // Test direct path content handling
  test("readContentFromFileIfExists returns input when not a file", async () => {
    const nonFilePath = "This is just content, not a file path";
    const result = await readContentFromFileIfExists(nonFilePath);
    expect(result).toBe(nonFilePath);
  });
});
