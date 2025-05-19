/**
 * Tests for default branch detection in GitService
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { GitService } from "../git";

describe("GitService Default Branch Detection", () => {
  // Reference to the original method
  const originalExecInRepository = GitService.prototype.execInRepository;
  
  beforeEach(() => {
    // Mock execInRepository to avoid actual git commands
    GitService.prototype.execInRepository = mock.fn(() => Promise.resolve(""));
  });
  
  afterEach(() => {
    // Restore original method
    GitService.prototype.execInRepository = originalExecInRepository;
  });

  test("should detect default branch from origin HEAD ref", async () => {
    const execMock = GitService.prototype.execInRepository as any;
    
    // Mock to return a specific branch name
    execMock.mockResolvedValue("origin/develop\n");
    
    const gitService = new GitService();
    const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");
    
    // Verify command was called
    expect(execMock.mock.calls.length).toBe(1);
    expect(execMock.mock.calls[0][0]).toBe("/test/repo");
    expect(execMock.mock.calls[0][1]).toBe("git symbolic-ref refs/remotes/origin/HEAD --short");
    
    // Verify result
    expect(defaultBranch).toBe("develop");
  });

  test("should properly remove origin prefix from branch name", async () => {
    const execMock = GitService.prototype.execInRepository as any;
    
    // Mock to return a branch with extra whitespace
    execMock.mockResolvedValue("  origin/custom-main  \n");
    
    const gitService = new GitService();
    const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");
    
    // Verify result is trimmed and has prefix removed
    expect(defaultBranch).toBe("custom-main");
  });

  test("should fall back to 'main' when command fails", async () => {
    const execMock = GitService.prototype.execInRepository as any;
    
    // Mock to throw an error
    execMock.mockRejectedValue(new Error("Git command failed"));
    
    // Spy on console.error to verify it's called
    const originalConsoleError = console.error;
    console.error = mock.fn();
    
    try {
      const gitService = new GitService();
      const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");
      
      // Verify fallback branch
      expect(defaultBranch).toBe("main");
      
      // Verify error was logged
      expect((console.error as any).mock.calls.length).toBe(1);
    } finally {
      // Restore console.error
      console.error = originalConsoleError;
    }
  });
}); 
