/**
 * Tests for GitService factory function
 * @migrated Extracted from git.test.ts for focused responsibility
 */
import { describe, test, expect } from "bun:test";
import { createGitService } from "../git";

// ========== Factory Function Regression Tests ==========

describe("createGitService Factory Function", () => {
  test("should handle undefined options parameter without throwing runtime error", () => {
    expect(() => {
      createGitService();
    }).not.toThrow();
  });

  test("should handle null options parameter without throwing runtime error", () => {
    expect(() => {
      createGitService(null);
    }).not.toThrow();
  });

  test("should handle options with undefined baseDir property", () => {
    expect(() => {
      createGitService({ baseDir: undefined });
    }).not.toThrow();
  });

  test("should create GitService with custom baseDir when provided", () => {
    const customBaseDir = "/custom/path";
    const gitService = createGitService({ baseDir: customBaseDir });
    expect(gitService).toBeDefined();
  });

  test("should create GitService with default baseDir when no options provided", () => {
    const gitService = createGitService();
    expect(gitService).toBeDefined();
  });
}); 
