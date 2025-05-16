import { describe, test, expect, mock, spyOn } from "bun:test";
import { GitService, MergePrResult, PreparePrResult } from "../git";
import { MinskyError } from "../../errors";

// Create mocks
const mockExec = mock(() => Promise.resolve({ stdout: "", stderr: "" }));
const mockGetSession = mock((name: string) => Promise.resolve({ 
  session: name,
  repoName: "test-repo",
  repoUrl: "/test/repo/path"
}));
const mockGetSessionWorkdir = mock((repoName: string, session: string) => 
  `/test/workdir/${repoName}/sessions/${session}`
);

// Common test dependencies
const testDeps = {
  execAsync: mockExec,
  getSession: mockGetSession,
  getSessionWorkdir: mockGetSessionWorkdir,
  getSessionByTaskId: mock((taskId: string) => Promise.resolve(null)),
};

describe("Git PR Workflow", () => {
  // Reset mocks before each test
  beforeEach(() => {
    mockExec.mockClear();
    mockGetSession.mockClear();
    mockGetSessionWorkdir.mockClear();
  });

  describe("summary", () => {
    test("generates PR summary markdown", async () => {
      // Mock implementation for getting commits and files
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("log")) {
          return Promise.resolve({ stdout: "abc123 First commit\ndef456 Second commit", stderr: "" });
        }
        if (cmd.includes("diff --name-only")) {
          return Promise.resolve({ stdout: "file1.ts\nfile2.ts", stderr: "" });
        }
        if (cmd.includes("diff --stat")) {
          return Promise.resolve({ stdout: "2 files changed, 10 insertions(+), 5 deletions(-)", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      const spyPrWithDeps = spyOn(gitService, "prWithDependencies");
      spyPrWithDeps.mockImplementation(() => Promise.resolve({
        markdown: "# Test PR\n\n## Commits\nabc123 Test commit\n\n## Files\nfile1.ts\nfile2.ts"
      }));

      const result = await gitService.summary({
        repoPath: "/test/repo",
        branch: "feature-branch"
      });

      expect(spyPrWithDeps).toHaveBeenCalled();
      expect(result.markdown).toContain("# Test PR");
      expect(result.markdown).toContain("Test commit");
    });

    test("updates task status when taskId is provided", async () => {
      const gitService = new GitService();
      const spyPrWithDeps = spyOn(gitService, "prWithDependencies");
      spyPrWithDeps.mockImplementation(() => Promise.resolve({
        markdown: "# Test PR"
      }));

      // Mock task service methods
      const mockTaskService = {
        getTaskStatus: mock(() => Promise.resolve("TODO")),
        setTaskStatus: mock(() => Promise.resolve())
      };

      // @ts-ignore - We're mocking the constructor
      spyOn(global, "TaskService").mockImplementation(() => mockTaskService);

      const result = await gitService.summary({
        repoPath: "/test/repo",
        branch: "feature-branch",
        taskId: "#123"
      });

      expect(result.statusUpdateResult).toBeDefined();
      expect(mockTaskService.setTaskStatus).toHaveBeenCalled();
    });
  });

  describe("preparePr", () => {
    test("creates PR branch with merge commit", async () => {
      // Setup mocks
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("branch --show-current")) {
          return Promise.resolve({ stdout: "feature-branch", stderr: "" });
        }
        if (cmd.includes("diff-index")) {
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        if (cmd.includes("symbolic-ref")) {
          return Promise.resolve({ stdout: "origin/main", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      // Mock filesystem operations
      const originalWriteFile = global.fs.writeFile;
      spyOn(global.fs, "writeFile").mockImplementation(() => Promise.resolve());

      // Mock the summary method
      const spySummary = spyOn(gitService, "summary");
      spySummary.mockImplementation(() => Promise.resolve({
        markdown: "# Test PR Description"
      }));

      const result = await gitService.preparePr({
        repoPath: "/test/repo",
        baseBranch: "main"
      });

      expect(result.prBranch).toBe("pr/feature-branch");
      expect(result.baseBranch).toBe("main");
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo switch -C pr/feature-branch origin/main"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo merge --no-ff"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo push -u origin pr/feature-branch"));

      // Restore original
      global.fs.writeFile = originalWriteFile;
    });

    test("throws error when working directory has uncommitted changes", async () => {
      // Mock uncommitted changes
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("diff-index")) {
          return Promise.reject(new Error("Working directory not clean"));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      await expect(gitService.preparePr({
        repoPath: "/test/repo"
      })).rejects.toThrow(MinskyError);
    });

    test("handles merge conflicts", async () => {
      // Setup mocks for merge conflict
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("branch --show-current")) {
          return Promise.resolve({ stdout: "feature-branch", stderr: "" });
        }
        if (cmd.includes("diff-index")) {
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        if (cmd.includes("symbolic-ref")) {
          return Promise.resolve({ stdout: "origin/main", stderr: "" });
        }
        if (cmd.includes("merge --no-ff")) {
          return Promise.reject(new Error("Merge conflict"));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      // Mock filesystem operations
      const originalWriteFile = global.fs.writeFile;
      spyOn(global.fs, "writeFile").mockImplementation(() => Promise.resolve());

      // Mock the summary method
      const spySummary = spyOn(gitService, "summary");
      spySummary.mockImplementation(() => Promise.resolve({
        markdown: "# Test PR Description"
      }));

      await expect(gitService.preparePr({
        repoPath: "/test/repo"
      })).rejects.toThrow(MinskyError);

      // Verify cleanup was attempted
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo merge --abort"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo checkout"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo branch -D pr/feature-branch"));

      // Restore original
      global.fs.writeFile = originalWriteFile;
    });
  });

  describe("mergePr", () => {
    test("merges PR branch using fast-forward", async () => {
      // Setup mocks
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("symbolic-ref")) {
          return Promise.resolve({ stdout: "origin/main", stderr: "" });
        }
        if (cmd.includes("rev-parse HEAD")) {
          return Promise.resolve({ stdout: "abcdef123456", stderr: "" });
        }
        if (cmd.includes("config user.name")) {
          return Promise.resolve({ stdout: "Test User", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      const result = await gitService.mergePr({
        prBranch: "pr/feature-branch",
        repoPath: "/test/repo"
      });

      expect(result.commitHash).toBe("abcdef123456");
      expect(result.mergedBy).toBe("Test User");
      expect(result.baseBranch).toBe("main");
      expect(result.prBranch).toBe("pr/feature-branch");
      
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo checkout main"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo merge --ff-only origin/pr/feature-branch"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo push origin main"));
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("git -C /test/repo push origin --delete pr/feature-branch"));
    });

    test("throws error when fast-forward merge is not possible", async () => {
      // Setup mocks for failed fast-forward
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("symbolic-ref")) {
          return Promise.resolve({ stdout: "origin/main", stderr: "" });
        }
        if (cmd.includes("merge --ff-only")) {
          return Promise.reject(new Error("Cannot fast-forward merge"));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      await expect(gitService.mergePr({
        prBranch: "pr/feature-branch",
        repoPath: "/test/repo"
      })).rejects.toThrow(MinskyError);
    });

    test("continues even if PR branch deletion fails", async () => {
      // Setup mocks
      mockExec.mockImplementation((cmd: string) => {
        if (cmd.includes("symbolic-ref")) {
          return Promise.resolve({ stdout: "origin/main", stderr: "" });
        }
        if (cmd.includes("rev-parse HEAD")) {
          return Promise.resolve({ stdout: "abcdef123456", stderr: "" });
        }
        if (cmd.includes("config user.name")) {
          return Promise.resolve({ stdout: "Test User", stderr: "" });
        }
        if (cmd.includes("push origin --delete")) {
          return Promise.reject(new Error("Failed to delete branch"));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const gitService = new GitService();
      
      // Should not throw error
      const result = await gitService.mergePr({
        prBranch: "pr/feature-branch",
        repoPath: "/test/repo"
      });

      expect(result.commitHash).toBe("abcdef123456");
    });
  });
}); 
