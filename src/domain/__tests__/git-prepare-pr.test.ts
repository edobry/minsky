import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";
import { preparePrFromParams } from "../index";
import { MinskyError } from "../../errors";
import { createMock } from "../../utils/test-utils/mocking";

describe("Git Prepare PR Functionality", () => {
  // Create mocks for dependencies
  const mockExecAsync = createMock(() => Promise.resolve({ stdout: "", stderr: "" }));
  
  const mockSessionDB = {
    getSession: createMock((name) => 
      Promise.resolve({
        session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
        createdAt: new Date().toISOString(),
        taskId: "task025",
      })
    ),
  };
  
  // Reset mocks before each test
  beforeEach(() => {
    (mockExecAsync as any).mock.calls = [];
    (mockSessionDB.getSession as any).mock.calls = [];
  });

  test("preparePr creates a PR branch with a merge commit", async () => {
    // Override the execAsync mock for specific commands
    const originalExecAsync = mockExecAsync;
    
    // Create a function that returns different responses based on the command
    const mockCommandSpecificExec = createMock((command) => {
      if (command.includes("git rev-parse --abbrev-ref HEAD")) {
        return Promise.resolve({ stdout: "source-branch", stderr: "" });
      }
      if (command.includes("git rev-parse --verify")) {
        // Act like the branch doesn't exist
        return Promise.reject(new Error("not a valid object name"));
      }
      // Default response for other commands
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    const gitService = new GitService();
    // Replace dependencies with mocks
    (gitService as any).sessionDb = mockSessionDB;
    
    // Use our special command-specific mock
    (gitService as any).execAsync = mockCommandSpecificExec;
    
    // Test with a repo path directly
    const result = await gitService.preparePr({
      repoPath: "/test/repo/path",
      baseBranch: "main",
      title: "Test PR Title",
      branchName: "test-branch"
    });
    
    // Verify the result
    expect(result.prBranch).toBe("pr/test-branch");
    expect(result.baseBranch).toBe("main");
    expect(result.title).toBe("Test PR Title");
    
    // Check that the correct commands were executed
    const calls = (mockCommandSpecificExec as any).mock.calls;
    
    // Check for correct command sequence
    const commandSequence = calls.map((call: any) => call[0]);
    
    // Verify key operations were performed in the correct order
    expect(commandSequence.some((cmd: string) => cmd.includes("checkout -b pr/test-branch origin/main"))).toBe(true);
    expect(commandSequence.some((cmd: string) => cmd.includes("merge --no-ff"))).toBe(true);
    expect(commandSequence.some((cmd: string) => cmd.includes("push -f origin pr/test-branch"))).toBe(true);
    expect(commandSequence.some((cmd: string) => cmd.includes("checkout source-branch"))).toBe(true);
  });

  test("preparePr with session parameter works correctly", async () => {
    // Create command-specific mock
    const mockCommandSpecificExec = createMock((command) => {
      if (command.includes("git rev-parse --verify")) {
        // Act like the branch doesn't exist
        return Promise.reject(new Error("not a valid object name"));
      }
      // Default response for other commands
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    // Test the interface-agnostic function
    const result = await preparePrFromParams({
      session: "test-session",
      baseBranch: "main",
      title: "Test PR from Session",
      branchName: "test-session-pr"
    }, {
      execAsync: mockCommandSpecificExec,
      getSession: mockSessionDB.getSession,
      getSessionWorkdir: () => "/test/session/path"
    });
    
    // Verify the result
    expect(result.prBranch).toBe("pr/test-session-pr");
    expect(result.baseBranch).toBe("main");
    expect(result.title).toBe("Test PR from Session");
    
    // Verify session was looked up
    expect((mockSessionDB.getSession as any).mock.calls.length).toBe(1);
    expect((mockSessionDB.getSession as any).mock.calls[0][0]).toBe("test-session");
  });

  test("preparePr handles branch name generation from title", async () => {
    const gitService = new GitService();
    
    // Test the private titleToBranchName method 
    const result = (gitService as any).titleToBranchName("feat: Add new Feature #123");
    
    // Verify the branch name is properly formatted
    expect(result).toBe("feat-add-new-feature-123");
  });

  test("preparePr throws error when session is not found", async () => {
    // Override getSession to return null
    const notFoundMockSessionDB = {
      getSession: createMock(() => Promise.resolve(null))
    };

    const gitService = new GitService();
    (gitService as any).sessionDb = notFoundMockSessionDB;
    
    // Test with non-existent session
    await expect(gitService.preparePr({
      session: "non-existent-session",
      title: "This should fail"
    })).rejects.toBeInstanceOf(MinskyError);
    
    // Verify session lookup was attempted
    expect((notFoundMockSessionDB.getSession as any).mock.calls.length).toBe(1);
  });
}); 
