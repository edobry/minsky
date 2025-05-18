import { describe, test, expect, beforeEach, jest } from "bun:test";
import { GitService } from "../git";
import { preparePrFromParams } from "../index";
import { MinskyError } from "../../errors";

// Create a completely isolated test that doesn't try to run real git commands
describe("Git Prepare PR Functionality", () => {
  // Mock execAsync to return success for all git commands
  const mockExecAsync = jest.fn().mockImplementation(() => Promise.resolve({ stdout: "", stderr: "" }));
  
  test("preparePr creates a PR branch with a merge commit", async () => {
    // Override GitService prototype to mock all methods that would run git commands
    const originalExecAsync = GitService.prototype.execAsync;
    GitService.prototype.execAsync = mockExecAsync;
    
    // Mock current branch detection
    mockExecAsync.mockImplementationOnce(() => Promise.resolve({ stdout: "source-branch", stderr: "" }));
    
    const gitService = new GitService("/fake/base/dir");
    
    // Mock the session DB to avoid database calls
    (gitService as any).sessionDb = {
      getSession: jest.fn().mockResolvedValue({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/test/repo/path"
      })
    };
    
    // Test with explicit PR parameters 
    const result = await gitService.preparePr({
      repoPath: "/test/repo/path",
      baseBranch: "main",
      title: "Test PR Title",
      branchName: "test-branch"
    });
    
    // Verify the result object
    expect(result.prBranch).toBe("pr/test-branch");
    expect(result.baseBranch).toBe("main");
    expect(result.title).toBe("Test PR Title");
    
    // Verify the git commands that would have been run
    const commands = mockExecAsync.mock.calls.map(call => call[0]);
    
    // Verify key commands were called in the right sequence
    expect(commands.some(cmd => cmd.includes("merge --no-ff"))).toBe(true);
    
    // Find the merge command specifically
    const mergeCommand = commands.find(cmd => cmd.includes("merge --no-ff"));
    expect(mergeCommand).toBeDefined();
    
    // Verify merge commit message contains the PR title
    if (mergeCommand) {
      expect(mergeCommand.includes("Test PR Title")).toBe(true);
    }
    
    // Restore original method
    GitService.prototype.execAsync = originalExecAsync;
  });

  test("titleToBranchName formats PR titles correctly", async () => {
    const gitService = new GitService();
    
    // Test the private titleToBranchName method 
    const result = (gitService as any).titleToBranchName("feat: Add new Feature #123");
    
    // Verify the branch name is properly formatted
    expect(result).toBe("feat-add-new-feature-123");
  });
  
  test("preparePr throws error when session not found", async () => {
    // Mock execAsync to avoid git commands
    const originalExecAsync = GitService.prototype.execAsync;
    GitService.prototype.execAsync = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
    
    const gitService = new GitService();
    
    // Mock session DB to return null (session not found)
    (gitService as any).sessionDb = {
      getSession: jest.fn().mockResolvedValue(null)
    };
    
    // Expect error when session not found
    try {
      await gitService.preparePr({
        session: "non-existent-session",
        title: "Test Title"
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error instanceof MinskyError).toBe(true);
      if (error instanceof MinskyError) {
        expect(error.message.includes("not found")).toBe(true);
      }
    }
    
    // Restore original method
    GitService.prototype.execAsync = originalExecAsync;
  });
}); 
