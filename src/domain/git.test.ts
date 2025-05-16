/**
 * Tests for the git service
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitService } from "./git";

// Mock child_process.execAsync to prevent actual git commands from running
mock.module("child_process", () => {
  return {
    execAsync: async (command: string) => {
      // Return empty results for git commands
      return { stdout: "", stderr: "" };
    }
  };
});

describe("GitService", () => {
  beforeEach(() => {
    mock.restore();
  });
  
  test("should be able to create an instance", () => {
    const gitService = new GitService();
    expect(gitService instanceof GitService).toBe(true);
  });
  
  // TODO: Task #079: Revisit GitService testing strategy
  // This test was previously testing only the API shape, not actual behavior.
  // We need to refactor to use proper mocking at the service level rather than
  // mocking low-level execAsync.
  /* Disabled test:
  test("getStatus should return proper git status information", () => {
    // Implement a proper test for GitService.getStatus() that verifies
    // the behavior rather than just checking if it returns a Promise
  });
  */
});
