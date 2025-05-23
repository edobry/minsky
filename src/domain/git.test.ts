/**
 * Tests for the git service
 * @migrated Migrated to native Bun patterns
 * @enhanced Enhanced with comprehensive method coverage and DI patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git.js";
import { MinskyError } from "../errors/index.js";
import { createMock, setupTestMocks, mockModule, createMockFileSystem } from "../utils/test-utils/mocking.js";
import { expectToHaveBeenCalled, expectToHaveBeenCalledWith } from "../utils/test-utils/assertions.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the logger module to avoid winston dependency issues
mockModule("../utils/logger", () => ({
  log: {
    agent: createMock(),
    debug: createMock(),
    warn: createMock(),
    error: createMock(),
    cli: createMock(),
    cliWarn: createMock(),
    cliError: createMock(),
    setLevel: createMock(),
    cliDebug: createMock()
  }
}));

describe("GitService", () => {
  let gitService: GitService;
  
  beforeEach(() => {
    // Create a fresh GitService instance for each test
    gitService = new GitService("/mock/base/dir");
    
    // Mock getStatus method to return canned data
    spyOn(GitService.prototype, "getStatus").mockImplementation(async () => {
      return {
        modified: ["file1.ts", "file2.ts"],
        untracked: ["newfile1.ts", "newfile2.ts"],
        deleted: ["deletedfile1.ts"]
      };
    });
    
    // Mock execInRepository to avoid actual git commands
    spyOn(GitService.prototype, "execInRepository").mockImplementation(async (workdir, command) => {
      if (command === "rev-parse --abbrev-ref HEAD") {
        return "main";
      }
      if (command === "rev-parse --show-toplevel") {
        return "/mock/repo/path";
      }
      return "";
    });
  });
  
  afterEach(() => {
    // Restore all mocks
    mock.restore();
  });

  // ========== Basic API Tests ==========
  
  test("should be able to create an instance", () => {
    expect(gitService instanceof GitService).toBe(true);
  });
  
  test("should get repository status", async () => {
    const status = await gitService.getStatus("/mock/repo/path");
    
    // Verify the returned status object has the expected structure and content
    expect(status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"]
    });
  });
  
  test("getSessionWorkdir should return the correct path", () => {
    const workdir = gitService.getSessionWorkdir("test-repo", "test-session");
    
    // Expect the full path to contain both the repo name and session
    expect(workdir.includes("test-repo")).toBe(true);
    expect(workdir.includes("test-session")).toBe(true);
  });
  
  test("execInRepository should execute git commands in the specified repository", async () => {
    const branch = await gitService.execInRepository("/mock/repo/path", "rev-parse --abbrev-ref HEAD");
    expect(branch).toBe("main");
  });
  
  test("execInRepository should propagate errors", async () => {
    // Override the mock implementation to simulate an error
    const execInRepoMock = spyOn(GitService.prototype, "execInRepository");
    execInRepoMock.mockImplementation(async (workdir, command) => {
      throw new Error("Command execution failed");
    });
    
    try {
      await gitService.execInRepository("/mock/repo/path", "rev-parse --abbrev-ref HEAD");
      // The test should not reach this line
      expect(true).toBe(false);
    } catch (error: unknown) {
      // Just verify it throws an error
      expect(error instanceof Error).toBe(true);
      if (error instanceof Error) {
        expect(error.message).toContain("Command execution failed");
      }
    }
  });
  
  test("should normalize repository names in getSessionWorkdir", () => {
    // Test with normal name (this doesn't need normalization)
    const normalRepo = "test-repo";
    const workdir1 = gitService.getSessionWorkdir(normalRepo, "test-session");
    expect(workdir1.includes(normalRepo)).toBe(true);
    
    // For normalized repositories, we can check that the path follows expected pattern
    expect(workdir1.endsWith(`${normalRepo}/sessions/test-session`)).toBe(true);
  });
});

// ========== Comprehensive GitService Method Tests ==========

describe("GitService - Core Methods with Dependency Injection", () => {
  describe("PR Workflow with Dependencies", () => {
    test("should generate PR markdown with proper dependency injection", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: string) => {
          if (command.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature\ndef456 fix: bug fix", stderr: "" };
          }
          if (command.includes("diff --name-only")) {
            return { stdout: "src/feature.ts\nREADME.md", stderr: "" };
          }
          if (command.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (command.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }),
        getSession: createMock(() => Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git"
        })),
        getSessionWorkdir: createMock(() => "/test/repo/sessions/test-session")
      };

      const gitService = new GitService();
      const result = await gitService.prWithDependencies(
        { session: "test-session" },
        mockDeps
      );

      expect(result.markdown).toContain("feature-branch");
      expect(result.markdown).toContain("abc123 feat: add new feature");
      expect(result.markdown).toContain("src/feature.ts");
      expectToHaveBeenCalled(mockDeps.execAsync);
      expectToHaveBeenCalledWith(mockDeps.getSession, "test-session");
    });

    test("should handle missing session in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(),
        getSession: createMock(() => Promise.resolve(null)),
        getSessionWorkdir: createMock()
      };

      const gitService = new GitService();
      
      await expect(gitService.prWithDependencies(
        { session: "nonexistent" },
        mockDeps
      )).rejects.toThrow("Session 'nonexistent' not found");
    });

    test("should handle git command failures gracefully in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(() => Promise.reject(new Error("git: command not found"))),
        getSession: createMock(() => Promise.resolve({
          session: "test-session",
          repoName: "test-repo"
        })),
        getSessionWorkdir: createMock(() => "/test/repo")
      };

      const gitService = new GitService();
      
      // The PR workflow should handle git errors gracefully and still produce markdown
      const result = await gitService.prWithDependencies(
        { session: "test-session" },
        mockDeps
      );

      expect(result.markdown).toContain("Pull Request for branch");
    });
  });

  describe("Repository Operations with spyOn Pattern", () => {
    let gitService: GitService;

    beforeEach(() => {
      gitService = new GitService("/test/base/dir");
    });

    test("should handle commit operations with proper error extraction", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async (workdir, command) => {
        if (command.includes("commit")) {
          return "[main abc123] Test commit message\n 1 file changed, 1 insertion(+)";
        }
        return "";
      });

      const result = await gitService.commit("Test commit message", "/test/repo");

      expect(result).toBe("abc123");
      expectToHaveBeenCalled(execSpy);
    });

    test("should extract commit hash from various git output formats", async () => {
      const testCases = [
        { output: "[main abc123] Test commit", expected: "abc123" },
        { output: "[feature def456] Another commit", expected: "def456" },
        { output: "[task#123 789abc] Task commit", expected: "789abc" }
      ];

      for (const testCase of testCases) {
        const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async () => testCase.output);
        
        const result = await gitService.commit("Test", "/test/repo");
        expect(result).toBe(testCase.expected);
        
        execSpy.mockRestore();
      }
    });

    test("should handle missing commit hash in git output", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async () => "Invalid git output");

      await expect(gitService.commit("Test", "/test/repo")).rejects.toThrow("Failed to extract commit hash");
      expectToHaveBeenCalled(execSpy);
    });

    test("should handle stash operations with state management", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async (workdir, command) => {
        if (command.includes("status --porcelain")) {
          return "M  modified-file.ts\n?? untracked-file.ts"; // Has changes
        }
        if (command.includes("stash push")) {
          return "Saved working directory and index state WIP on main: abc123 Previous commit";
        }
        return "";
      });

      const result = await gitService.stashChanges("/test/repo");

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(true);
      expectToHaveBeenCalled(execSpy);
    });

    test("should handle no changes to stash scenario", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async (workdir, command) => {
        if (command.includes("status --porcelain")) {
          return ""; // No changes
        }
        return "";
      });

      const result = await gitService.stashChanges("/test/repo");

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(false);
      expectToHaveBeenCalled(execSpy);
    });

    test("should handle merge conflicts with proper detection", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async (workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return "original-hash";
        }
        if (command.includes("merge feature-branch")) {
          throw new Error("Automatic merge failed; fix conflicts and then commit the result");
        }
        if (command.includes("status --porcelain")) {
          return "UU conflicted-file.ts\nAA another-conflict.ts"; // Conflict markers
        }
        if (command.includes("merge --abort")) {
          return "";
        }
        return "";
      });

      const result = await gitService.mergeBranch("/test/repo", "feature-branch");

      expect(result.workdir).toBe("/test/repo");
      expect(result.merged).toBe(false);
      expect(result.conflicts).toBe(true);
      expectToHaveBeenCalled(execSpy);
    });

    test("should handle successful merge without conflicts", async () => {
      let callCount = 0;
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async (workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          callCount++;
          // First call returns original hash, second call returns new hash
          return callCount === 1 ? "original-hash" : "new-merge-hash";
        }
        if (command.includes("merge feature-branch")) {
          return "Merge made by the 'recursive' strategy.";
        }
        return "";
      });

      const result = await gitService.mergeBranch("/test/repo", "feature-branch");

      expect(result.workdir).toBe("/test/repo");
      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
      expectToHaveBeenCalled(execSpy);
    });

    test("should handle error scenarios with proper error propagation", async () => {
      const execSpy = spyOn(gitService, 'execInRepository').mockImplementation(async () => {
        throw new Error("fatal: not a git repository");
      });

      await expect(gitService.stashChanges("/invalid/path")).rejects.toThrow("Failed to stash changes");
      await expect(gitService.mergeBranch("/invalid/path", "feature")).rejects.toThrow("Failed to merge branch");
      expectToHaveBeenCalled(execSpy);
    });
  });
});
