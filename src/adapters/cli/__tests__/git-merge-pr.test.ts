import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GitService } from "../../../domain/git";
import { createMock, setupTestMocks } from "../../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Since mergePrFromParams is not exported from git.ts, we need to test it indirectly
// We'll test the dynamic branch detection functionality through the GitService

describe("GitService Default Branch Detection", () => {
  // Save original methods for restoration
  let originalExecInRepository: any;
  let execMock: any;
  
  // Mock dependencies
  beforeEach(() => {
    // Use project's test utilities for mocking
    originalExecInRepository = GitService.prototype.execInRepository;
    GitService.prototype.execInRepository = createMock(() => Promise.resolve(""));
    execMock = GitService.prototype.execInRepository;
  });
  
  // Restore original methods
  afterEach(() => {
    GitService.prototype.execInRepository = originalExecInRepository;
  });

  test("should attempt to detect default branch when merging PRs", async () => {
    // Create a GitService instance
    const gitService = new GitService();
    
    // First mock call will be for the symbolic-ref command to detect default branch
    execMock.mockImplementation((workdir: string, cmd: string) => {
      if (cmd.includes("symbolic-ref")) {
        return Promise.resolve("origin/custom-main\n");
      }
      return Promise.resolve("");
    });
    
    // We'll test by calling methods on gitService directly 
    // that would trigger the default branch detection
    await gitService.fetchDefaultBranch("/test/repo");
    
    // Verify the symbolic-ref command was called
    expect(execMock.mock.calls.length).toBeGreaterThan(0);
    expect(execMock.mock.calls[0][0]).toBe("/test/repo");
    expect(execMock.mock.calls[0][1]).toBe("git symbolic-ref refs/remotes/origin/HEAD --short");
  });

  test("should handle errors when detecting default branch", async () => {
    // Create a GitService instance
    const gitService = new GitService();
    
    // Mock symbolic-ref to throw an error
    execMock.mockImplementation((workdir: string, cmd: string) => {
      if (cmd.includes("symbolic-ref")) {
        return Promise.reject(new Error("Git command failed"));
      }
      return Promise.resolve("");
    });
    
    // This should handle the error and fall back
    const result = await gitService.fetchDefaultBranch("/test/repo");
    
    // Should fall back to main
    expect(result).toBe("main");
  });
}); 
