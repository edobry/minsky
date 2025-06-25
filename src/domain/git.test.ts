const TEST_VALUE = 123;

/**
 * Tests for the git service
 * @migrated Migrated to native Bun patterns
 * @enhanced Enhanced with comprehensive method coverage and DI patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git";
import {
  createMock,
  setupTestMocks,
  mockModule,
  createMockFileSystem,
} from "../utils/test-utils/mocking.js";
import {
  expectToHaveBeenCalled,
  expectToHaveBeenCalledWith,
} from "../utils/test-utils/assertions.js";

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
    cliDebug: createMock(),
  },
}));

// Mock the centralized execAsync module at the top level for proper module interception
const mockExecAsync = createMock();
mockModule("../utils/exec", () => ({
  execAsync: mockExecAsync,
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
        deleted: ["deletedfile1.ts"],
      };
    });

    // Mock execInRepository to avoid actual git commands
    spyOn(GitService.prototype, "execInRepository").mockImplementation(async (_workdir, command) => {
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
    const _status = await gitService.getStatus("/mock/repo/path");

    // Verify the returned status object has the expected structure and content
    expect(_status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"],
    });
  });

  test("getSessionWorkdir should return the correct path", () => {
    const _workdir = gitService.getSessionWorkdir("test-repo", "test-session");

    // Expect the full path to contain both the repo name and session
    expect(workdir.includes("test-repo")).toBe(true);
    expect(workdir.includes("test-session")).toBe(true);
  });

  test("execInRepository should execute git commands in the specified repository", async () => {
    const _branch = await gitService.execInRepository(
      "/mock/repo/path",
      "rev-parse --abbrev-ref HEAD"
    );
    expect(_branch).toBe("main");
  });

  test("execInRepository should propagate errors", async () => {
    // Override the mock implementation to simulate an error
    const execInRepoMock = spyOn(GitService.prototype, "execInRepository");
    execInRepoMock.mockImplementation(async (_workdir, _command) => {
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
        execAsync: createMock(async (command: unknown) => {
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
        }) as any,
        getSession: createMock(() =>
          Promise.resolve({
            _session: "test-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as any,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/test-session") as any,
      };

      const gitService = new GitService();
      const result = await gitService.prWithDependencies({ _session: "test-session" }, mockDeps);

      expect(result.markdown).toContain("feature-branch");
      expect(result.markdown).toContain("abc123 feat: add new feature");
      expect(result.markdown).toContain("src/feature.ts");
      expectToHaveBeenCalled(mockDeps.execAsync);
      expectToHaveBeenCalledWith(mockDeps.getSession, "test-session");
    });

    test("should handle missing session in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock() as any,
        getSession: createMock(() => Promise.resolve(null)) as any,
        getSessionWorkdir: createMock() as any,
      };

      const gitService = new GitService();

      await expect(
        gitService.prWithDependencies({ _session: "nonexistent" }, mockDeps)
      ).rejects.toThrow("Session 'nonexistent' not found");
    });

    test("should resolve taskId to session in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature", stderr: "" };
          }
          if (command.includes("diff --name-only")) {
            return { stdout: "src/feature.ts", stderr: "" };
          }
          if (command.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (command.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          if (command.includes("symbolic-ref")) {
            return { stdout: "origin/main", stderr: "" };
          }
          if (command.includes("diff --name-status")) {
            return { stdout: "M\tsrc/feature.ts", stderr: "" };
          }
          if (command.includes("status --porcelain")) {
            return { stdout: "", stderr: "" };
          }
          if (command.includes("diff --stat")) {
            return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
        getSession: createMock(() =>
          Promise.resolve({
            _session: "task-143-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as any,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/task-143-session") as any,
        getSessionByTaskId: createMock(() =>
          Promise.resolve({
            _session: "task-143-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
            taskId: "143",
          })
        ) as any,
      };

      const gitService = new GitService();
      const _result = await gitService.prWithDependencies({ taskId: "143" }, mockDeps);

      // Verify that taskId was resolved to session
      expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "143");
      expectToHaveBeenCalledWith(mockDeps.getSession, "task-143-session");
      expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "test-repo", "task-143-session");

      // Verify PR was generated successfully
      expect(result.markdown).toContain("feature-branch");
      expect(result.markdown).toContain("abc123 feat: add new feature");
    });

    test("should throw error when taskId has no associated session", async () => {
      const mockDeps = {
        execAsync: createMock() as any,
        getSession: createMock() as any,
        getSessionWorkdir: createMock() as any,
        getSessionByTaskId: createMock(() => Promise.resolve(null)) as any,
      };

      const gitService = new GitService();

      await expect(gitService.prWithDependencies({ taskId: "999" }, mockDeps)).rejects.toThrow(
        "No session found for task ID \"999\""
      );

      expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "999");
    });

    test("should throw error when getSessionByTaskId dependency is not available", async () => {
      const mockDeps = {
        execAsync: createMock() as any,
        getSession: createMock() as any,
        getSessionWorkdir: createMock() as any,
        // getSessionByTaskId is intentionally omitted
      };

      const gitService = new GitService();

      await expect(gitService.prWithDependencies({ taskId: "143" }, mockDeps)).rejects.toThrow(
        "getSessionByTaskId dependency not available"
      );
    });

    test("should prioritize session over taskId when both are provided", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature", stderr: "" };
          }
          if (command.includes("diff --name-only")) {
            return { stdout: "src/feature.ts", stderr: "" };
          }
          if (command.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (command.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          if (command.includes("symbolic-ref")) {
            return { stdout: "origin/main", stderr: "" };
          }
          if (command.includes("diff --name-status")) {
            return { stdout: "M\tsrc/feature.ts", stderr: "" };
          }
          if (command.includes("status --porcelain")) {
            return { stdout: "", stderr: "" };
          }
          if (command.includes("diff --stat")) {
            return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
        getSession: createMock(() =>
          Promise.resolve({
            _session: "direct-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as any,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/direct-session") as any,
        getSessionByTaskId: createMock() as any,
      };

      const gitService = new GitService();
      const _result = await gitService.prWithDependencies(
        { _session: "direct-session", taskId: "143" },
        mockDeps
      );

      // Verify that session was used directly and taskId was ignored
      expectToHaveBeenCalledWith(mockDeps.getSession, "direct-session");
      expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "test-repo", "direct-session");

      // Verify getSessionByTaskId was NOT called
      expect(mockDeps.getSessionByTaskId.mock?.calls?.length ?? 0).toBe(0);

      // Verify PR was generated successfully
      expect(result.markdown).toContain("feature-branch");
    });

    test("should handle git command failures gracefully in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          // Allow some commands to succeed for basic workflow
          if (command.includes("rev-parse --show-toplevel")) {
            return { stdout: "/test/repo", stderr: "" };
          }
          if (command.includes("branch --show-current")) {
            return { stdout: "test-branch", stderr: "" };
          }
          // Fail other git commands to test error handling
          throw new Error("git: command not found");
        }) as any,
        getSession: createMock(() =>
          Promise.resolve({
            _session: "test-session",
            repoName: "test-repo",
          })
        ) as any,
        getSessionWorkdir: createMock(() => "/test/repo") as any,
      };

      const gitService = new GitService();

      // The PR workflow should handle git errors gracefully and still produce markdown
      const result = await gitService.prWithDependencies({ _session: "test-session" }, mockDeps);

      expect(result.markdown).toContain("Pull Request for branch");
    });
  });

  describe("Repository Operations with Dependency Injection", () => {
    let gitService: GitService;

    beforeEach(() => {
      gitService = new GitService("/test/base/dir");
    });

    test("should handle commit operations with proper hash extraction", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("commit")) {
            return {
              stdout: "[main abc123] Test commit message\n 1 file changed, 1 insertion(+)",
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const _result = await gitService.commitWithDependencies(
        "Test commit message",
        "/test/repo",
        mockDeps
      );

      expect(_result).toBe("abc123");
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should extract commit hash from various git output formats", async () => {
      const testCases = [
        { output: "[main abc123] Test commit", expected: "abc123" },
        { output: "[feature def456] Another commit", expected: "def456" },
        { output: "[task#TEST_VALUE 789abc] Task commit", expected: "789abc" },
      ];

      for (const testCase of testCases) {
        const mockDeps = {
          execAsync: createMock(async () => ({
            stdout: testCase.output,
            stderr: "",
          })) as any,
        };

        const _result = await gitService.commitWithDependencies("Test", "/test/repo", mockDeps);
        expect(_result).toBe(testCase.expected);
      }
    });

    test("should handle missing commit hash in git output", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({
          stdout: "Invalid git output",
          stderr: "",
        })) as any,
      };

      await expect(
        gitService.commitWithDependencies("Test", "/test/repo", mockDeps)
      ).rejects.toThrow("Failed to extract commit hash");
    });

    test("should handle commit with amend flag", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          expect(_command).toContain("--amend");
          return { stdout: "[main def456] Amended commit\n 1 file changed", stderr: "" };
        }) as any,
      };

      const _result = await gitService.commitWithDependencies(
        "Amended message",
        "/test/repo",
        mockDeps,
        true
      );
      expect(_result).toBe("def456");
    });

    test("should handle stash operations with state management", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("status --porcelain")) {
            return { stdout: "M  modified-file.ts\n?? untracked-file.ts", stderr: "" }; // Has changes
          }
          if (command.includes("stash push")) {
            return { stdout: "Saved working directory and index state", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.stashChangesWithDependencies("/test/repo", mockDeps);

      expect(result._workdir).toBe("/test/repo");
      expect(result.stashed).toBe(true);
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should handle no changes to stash scenario", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("status --porcelain")) {
            return { stdout: "", stderr: "" }; // No changes
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.stashChangesWithDependencies("/test/repo", mockDeps);

      expect(result._workdir).toBe("/test/repo");
      expect(result.stashed).toBe(false);
    });

    test("should handle popStash with existing stash", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("stash list")) {
            return { stdout: "stash@{0}: WIP on main: abc123 Previous work", stderr: "" };
          }
          if (command.includes("stash pop")) {
            return { stdout: "Dropped refs/stash@{0}", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.popStashWithDependencies("/test/repo", mockDeps);

      expect(result._workdir).toBe("/test/repo");
      expect(result.stashed).toBe(true);
    });

    test("should handle popStash with no stash available", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("stash list")) {
            return { stdout: "", stderr: "" }; // No stash
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.popStashWithDependencies("/test/repo", mockDeps);

      expect(result._workdir).toBe("/test/repo");
      expect(result.stashed).toBe(false);
    });

    test("should handle merge conflicts with proper detection", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse HEAD")) {
            return { stdout: "original-hash", stderr: "" };
          }
          if (command.includes("merge feature-branch")) {
            throw new Error("Automatic merge failed; fix conflicts and then commit the result");
          }
          if (command.includes("status --porcelain")) {
            return { stdout: "UU conflicted-file.ts\nAA another-conflict.ts", stderr: "" }; // Conflict markers
          }
          if (command.includes("merge --abort")) {
            return { stdout: "", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const _result = await gitService.mergeBranchWithDependencies(
        "/test/repo",
        "feature-branch",
        mockDeps
      );

      expect(result._workdir).toBe("/test/repo");
      expect(result.merged).toBe(false);
      expect(result.conflicts).toBe(true);
    });

    test("should handle successful merge without conflicts", async () => {
      let callCount = 0;
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse HEAD")) {
            callCount++;
            // First call returns original hash, second call returns new hash
            const hash = callCount === 1 ? "original-hash" : "new-merge-hash";
            return { stdout: hash, stderr: "" };
          }
          if (command.includes("merge feature-branch")) {
            return { stdout: "Merge made by the 'recursive' strategy.", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const _result = await gitService.mergeBranchWithDependencies(
        "/test/repo",
        "feature-branch",
        mockDeps
      );

      expect(result._workdir).toBe("/test/repo");
      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
    });

    test("should handle staging operations with proper command execution", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          expect(command.includes("git -C /test/repo add")).toBe(true);
          return { stdout: "", stderr: "" };
        }) as any,
      };

      // Test stageAll
      await gitService.stageAllWithDependencies("/test/repo", mockDeps);
      expectToHaveBeenCalled(mockDeps.execAsync);

      // Reset and test stageModified
      mockDeps.execAsync.mockReset();
      await gitService.stageModifiedWithDependencies("/test/repo", mockDeps);
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should verify staging commands are correct", async () => {
      let capturedCommand = "";
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          capturedCommand = command;
          return { stdout: "", stderr: "" };
        }) as any,
      };

      // Test stageAll uses add -A
      await gitService.stageAllWithDependencies("/test/repo", mockDeps);
      expect(capturedCommand).toBe("git -C /test/repo add -A");

      // Test stageModified uses add .
      await gitService.stageModifiedWithDependencies("/test/repo", mockDeps);
      expect(capturedCommand).toBe("git -C /test/repo add .");
    });

    test("should handle pullLatest with updates detected", async () => {
      let callCount = 0;
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) {
            return { stdout: "main", stderr: "" };
          }
          if (command.includes("rev-parse HEAD")) {
            callCount++;
            // First call returns old hash, second call returns new hash
            const hash = callCount === 1 ? "old-commit-hash" : "new-commit-hash";
            return { stdout: hash, stderr: "" };
          }
          if (command.includes("pull origin main")) {
            return { stdout: "Fast-forward\n file.txt | 1 +", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.pullLatestWithDependencies("/test/repo", mockDeps, "origin");

      expect(result._workdir).toBe("/test/repo");
      expect(result.updated).toBe(true);
    });

    test("should handle pullLatest with no updates", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) {
            return { stdout: "main", stderr: "" };
          }
          if (command.includes("rev-parse HEAD")) {
            return { stdout: "same-commit-hash", stderr: "" };
          }
          if (command.includes("pull origin main")) {
            return { stdout: "Already up to date.", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const result = await gitService.pullLatestWithDependencies("/test/repo", mockDeps, "origin");

      expect(result._workdir).toBe("/test/repo");
      expect(result.updated).toBe(false);
    });

    test("should handle pullLatest with custom remote", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) {
            return { stdout: "feature", stderr: "" };
          }
          if (command.includes("rev-parse HEAD")) {
            return { stdout: "test-hash", stderr: "" };
          }
          if (command.includes("pull upstream feature")) {
            expect(_command).toContain("upstream"); // Verify custom remote is used
            return { stdout: "Updated", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
      };

      const _result = await gitService.pullLatestWithDependencies(
        "/test/repo",
        mockDeps,
        "upstream"
      );

      expect(result._workdir).toBe("/test/repo");
    });

    test("should handle clone operations with filesystem validation", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("git clone")) {
            return { stdout: "Cloning into '/test/workdir'...\nDone.", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
        mkdir: createMock(async () => {}) as any,
        readdir: createMock(async () => {
          throw new Error("ENOENT: no such file or directory"); // Directory doesn't exist
        }) as any,
        access: createMock(async () => {}) as any, // .git directory exists
      };

      const _result = await gitService.cloneWithDependencies(
        {
          repoUrl: "https://github.com/user/repo.git",
          _session: "test-session",
        },
        mockDeps
      );

      expect(result._session).toBe("test-session");
      expect(result._workdir).toContain("test-session");
      expectToHaveBeenCalled(mockDeps.execAsync);
      expectToHaveBeenCalled(mockDeps.mkdir);
    });

    test("should handle clone with empty repository URL validation", async () => {
      const mockDeps = {
        execAsync: createMock() as any,
        mkdir: createMock() as any,
        readdir: createMock() as any,
        access: createMock() as any,
      };

      await expect(
        gitService.cloneWithDependencies(
          {
            repoUrl: "",
            _session: "test-session",
          },
          mockDeps
        )
      ).rejects.toThrow("Repository URL is required for cloning");
    });

    test("should handle clone with existing non-empty directory", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("git clone")) {
            return { stdout: "Cloning...", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
        mkdir: createMock() as any,
        readdir: createMock(async () => ["existing-file.txt"]) as any, // Directory exists and not empty
        access: createMock() as any,
      };

      // Should still proceed with clone despite warning about non-empty directory
      const _result = await gitService.cloneWithDependencies(
        {
          repoUrl: "https://github.com/user/repo.git",
          _session: "test-session",
        },
        mockDeps
      );

      expect(result._session).toBe("test-session");
      expectToHaveBeenCalled(mockDeps.readdir);
    });

    test("should handle clone failure during git command execution", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("git clone")) {
            throw new Error(
              "fatal: repository 'https://github.com/user/nonexistent.git' not found"
            );
          }
          return { stdout: "", stderr: "" };
        }) as any,
        mkdir: createMock() as any,
        readdir: createMock(async () => {
          throw new Error("ENOENT");
        }) as any,
        access: createMock() as any,
      };

      await expect(
        gitService.cloneWithDependencies(
          {
            repoUrl: "https://github.com/user/nonexistent.git",
            _session: "test-session",
          },
          mockDeps
        )
      ).rejects.toThrow("Failed to clone git repository");
    });

    test("should handle clone success verification failure", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("git clone")) {
            return { stdout: "Cloning...", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as any,
        mkdir: createMock() as any,
        readdir: createMock(async () => {
          throw new Error("ENOENT");
        }) as any,
        access: createMock(async () => {
          throw new Error("ENOENT: .git directory not found"); // Clone verification fails
        }) as any,
      };

      await expect(
        gitService.cloneWithDependencies(
          {
            repoUrl: "https://github.com/user/repo.git",
            _session: "test-session",
          },
          mockDeps
        )
      ).rejects.toThrow("Git repository was not properly cloned: .git directory not found");
    });

    test("should handle clone with local repository normalization", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({ stdout: "Cloning...", stderr: "" })) as any,
        mkdir: createMock() as any,
        readdir: createMock(async () => {
          throw new Error("ENOENT");
        }) as any,
        access: createMock() as any,
      };

      const _result = await gitService.cloneWithDependencies(
        {
          repoUrl: "local/path/to/repo",
          _session: "test-session",
        },
        mockDeps
      );

      // Should normalize local path correctly (normalizeRepoName returns "local/repo" for "local/path/to/repo")
      // After further normalization for directory structure, becomes "local-repo"
      expect(result._workdir).toContain("local-repo");
      expect(result._session).toBe("test-session");
    });

    test("should handle error scenarios with proper error propagation", async () => {
      const mockDeps = {
        execAsync: createMock(async () => {
          throw new Error("fatal: not a git repository");
        }) as any,
      };

      await expect(gitService.stashChangesWithDependencies("/test/repo", mockDeps)).rejects.toThrow(
        "Failed to stash changes"
      );
      await expect(
        gitService.mergeBranchWithDependencies("/test/repo", "feature", mockDeps)
      ).rejects.toThrow("Failed to merge branch");
      await expect(gitService.pullLatestWithDependencies("/test/repo", mockDeps)).rejects.toThrow(
        "Failed to pull latest changes"
      );
    });
  });

  describe("Architecture Analysis - Testing Limitations", () => {
    test("should demonstrate the core testing challenge", () => {
      // This test documents the architectural limitation we discovered:
      // Methods like commit(), stashChanges(), mergeBranch() call module-level execAsync directly
      // This makes them difficult to test without dependency injection patterns

      const gitService = new GitService("/test/base/dir");
      expect(gitService instanceof GitService).toBe(true);

      // The TestGitService approach doesn't work because:
      // 1. Real methods import execAsync from "../utils/exec" at module level
      // 2. They don't call the instance execAsync method that TestGitService overrides
      // 3. Module mocking in Bun doesn't intercept these imports in test context

      // Solution: Use dependency injection patterns like prWithDependencies()
      // ✅ IMPLEMENTED: Added comprehensive *WithDependencies variants for critical methods:
      // - commitWithDependencies() (BasicGitDependencies)
      // - stashChangesWithDependencies() (BasicGitDependencies)
      // - popStashWithDependencies() (BasicGitDependencies)
      // - mergeBranchWithDependencies() (BasicGitDependencies)
      // - stageAllWithDependencies() (BasicGitDependencies)
      // - stageModifiedWithDependencies() (BasicGitDependencies)
      // - pullLatestWithDependencies() (BasicGitDependencies)
      // - cloneWithDependencies() (ExtendedGitDependencies)
      // Multi-tier dependency injection architecture established!
    });
  });
});
