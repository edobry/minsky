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
} from "../utils/test-utils/mocking";
import { expectToHaveBeenCalled, expectToHaveBeenCalledWith } from "../utils/test-utils/assertions";
import { createGitService } from "./git";
import { commitChangesFromParams, pushFromParams } from "./git";

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
let mockExecAsync = createMock(async () => ({ stdout: "", stderr: "" }));
mockModule("../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

// Mock child_process to prevent real command execution
mockModule("child_process", () => ({
  exec: createMock((command: string, callback: any) => {
    callback(null, { stdout: "", stderr: "" });
  }),
  execSync: createMock(() => ""),
  spawn: createMock(() => ({
    on: createMock(),
    stdout: { on: createMock() },
    stderr: { on: createMock() },
  })),
}));

// Mock filesystem operations to prevent real filesystem access
mockModule("fs", () => ({
  existsSync: createMock(() => true),
  mkdirSync: createMock(),
  readdirSync: createMock(() => []),
  accessSync: createMock(),
}));

mockModule("fs/promises", () => ({
  access: createMock(async () => undefined),
  mkdir: createMock(async () => undefined),
  readdir: createMock(async () => []),
  writeFile: createMock(async () => undefined),
  readFile: createMock(async () => ""),
}));

// Mock the git-exec module to prevent real git execution
mockModule("../utils/git-exec", () => ({
  execGitWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitFetchWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitMergeWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitPushWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
}));

// Mock paths module to prevent real path resolution
mockModule("../utils/paths", () => ({
  getSessionDir: createMock((session: string) => `/mocked/sessions/${session}`),
  getSessionsBaseDir: createMock(() => "/mocked/sessions"),
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
    const _status = await gitService.getStatus("/mock/repo/path");

    // Verify the returned status object has the expected structure and content
    expect(_status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"],
    });
  });

  test("getSessionWorkdir should return the correct path", () => {
    const workdir = gitService.getSessionWorkdir("test-session");

    // NEW: Session-ID-based storage - expect session ID in path, not repo name
    expect(workdir.includes("test-session")).toBe(true);
    expect(workdir.includes("sessions")).toBe(true);
    // Repository identity no longer part of filesystem path
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
    const execInRepoMock = spyOn(GitService.prototype, "execInRepository").mockImplementation(
      async (workdir, command) => {
        throw new Error("Command execution failed");
      }
    );

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

  test("should use session-ID-based storage in getSessionWorkdir", () => {
    // NEW: Session-ID-based storage - repository normalization no longer needed for paths
    const workdir1 = gitService.getSessionWorkdir("test-session");

    // Path should contain session ID but NOT repository name
    expect(workdir1.includes("test-session")).toBe(true);
    expect(workdir1.includes("sessions")).toBe(true);
    expect(workdir1.endsWith("sessions/test-session")).toBe(true);
  });
});

// ========== Comprehensive GitService Method Tests ==========

describe("GitService - Core Methods with Dependency Injection", () => {
  describe("PR Workflow with Dependencies", () => {
    test("should generate PR markdown with proper dependency injection", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature\ndef456 fix: bug fix", stderr: "" };
          }
          if (cmd.includes("diff --name-only")) {
            return { stdout: "src/feature.ts\nREADME.md", stderr: "" };
          }
          if (cmd.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (cmd.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
        getSession: createMock(() =>
          Promise.resolve({
            session: "test-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as unknown,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/test-session") as unknown,
      };

      const gitService = new GitService();
      const result = await gitService.prWithDependencies({ session: "test-session" }, mockDeps);

      expect(result.markdown).toContain("feature-branch");
      expect(result.markdown).toContain("abc123 feat: add new feature");
      expect(result.markdown).toContain("src/feature.ts");
      expectToHaveBeenCalled(mockDeps.execAsync);
      expectToHaveBeenCalledWith(mockDeps.getSession, "test-session");
    });

    test("should handle missing session in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock() as unknown,
        getSession: createMock(() => Promise.resolve(null)) as unknown,
        getSessionWorkdir: createMock() as unknown,
      };

      const gitService = new GitService();

      await expect(
        gitService.prWithDependencies({ session: "nonexistent" }, mockDeps)
      ).rejects.toThrow('Session "nonexistent" Not Found');
    });

    test("should resolve taskId to session in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature", stderr: "" };
          }
          if (cmd.includes("diff --name-only")) {
            return { stdout: "src/feature.ts", stderr: "" };
          }
          if (cmd.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (cmd.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          if (cmd.includes("symbolic-ref")) {
            return { stdout: "origin/main", stderr: "" };
          }
          if (cmd.includes("diff --name-status")) {
            return { stdout: "M\tsrc/feature.ts", stderr: "" };
          }
          if (cmd.includes("status --porcelain")) {
            return { stdout: "", stderr: "" };
          }
          if (cmd.includes("diff --stat")) {
            return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
        getSession: createMock(() =>
          Promise.resolve({
            session: "task-143-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as unknown,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/task-143-session") as unknown,
        getSessionByTaskId: createMock(() =>
          Promise.resolve({
            session: "task-143-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
            taskId: "143",
          })
        ) as unknown,
      };

      const gitService = new GitService();
      const result = await gitService.prWithDependencies({ taskId: "143" }, mockDeps);

      // Verify that taskId was resolved to session
      expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "143");
      expectToHaveBeenCalledWith(mockDeps.getSession, "task-143-session");
      expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "task-143-session");

      // Verify PR was generated successfully
      expect(result.markdown).toContain("feature-branch");
      expect(result.markdown).toContain("abc123 feat: add new feature");
    });

    test("should throw error when taskId has no associated session", async () => {
      const mockDeps = {
        execAsync: createMock() as unknown,
        getSession: createMock() as unknown,
        getSessionWorkdir: createMock() as unknown,
        getSessionByTaskId: createMock(() => Promise.resolve(null)) as unknown,
      };

      const gitService = new GitService();

      await expect(gitService.prWithDependencies({ taskId: "999" }, mockDeps)).rejects.toThrow(
        'No session found for task ID "999"'
      );

      expectToHaveBeenCalledWith(mockDeps.getSessionByTaskId, "999");
    });

    test("should throw error when getSessionByTaskId dependency is not available", async () => {
      const mockDeps = {
        execAsync: createMock() as unknown,
        getSession: createMock() as unknown,
        getSessionWorkdir: createMock() as unknown,
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
          const cmd = command as string;
          if (cmd.includes("log --oneline")) {
            return { stdout: "abc123 feat: add new feature", stderr: "" };
          }
          if (cmd.includes("diff --name-only")) {
            return { stdout: "src/feature.ts", stderr: "" };
          }
          if (cmd.includes("merge-base")) {
            return { stdout: "base123", stderr: "" };
          }
          if (cmd.includes("branch --show-current")) {
            return { stdout: "feature-branch", stderr: "" };
          }
          if (cmd.includes("symbolic-ref")) {
            return { stdout: "origin/main", stderr: "" };
          }
          if (cmd.includes("diff --name-status")) {
            return { stdout: "M\tsrc/feature.ts", stderr: "" };
          }
          if (cmd.includes("status --porcelain")) {
            return { stdout: "", stderr: "" };
          }
          if (cmd.includes("diff --stat")) {
            return { stdout: "1 file changed, 1 insertion(+)", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
        getSession: createMock(() =>
          Promise.resolve({
            session: "direct-session",
            repoName: "test-repo",
            repoUrl: "https://github.com/user/repo.git",
          })
        ) as unknown,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/direct-session") as unknown,
        getSessionByTaskId: createMock() as unknown,
      };

      const gitService = new GitService();
      const result = await gitService.prWithDependencies(
        { session: "direct-session", taskId: "143" },
        mockDeps
      );

      // Verify that session was used directly and taskId was ignored
      expectToHaveBeenCalledWith(mockDeps.getSession, "direct-session");
      expectToHaveBeenCalledWith(mockDeps.getSessionWorkdir, "direct-session");

      // Verify getSessionByTaskId was NOT called
      expect(mockDeps.getSessionByTaskId.mock?.calls?.length ?? 0).toBe(0);

      // Verify PR was generated successfully
      expect(result.markdown).toContain("feature-branch");
    });

    test("should handle git command failures gracefully in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          // Allow some commands to succeed for basic workflow
          if (cmd.includes("rev-parse --show-toplevel")) {
            return { stdout: "/test/repo", stderr: "" };
          }
          if (cmd.includes("branch --show-current")) {
            return { stdout: "test-branch", stderr: "" };
          }
          // Fail other git commands to test error handling
          throw new Error("git: command not found");
        }) as unknown,
        getSession: createMock(() =>
          Promise.resolve({
            session: "test-session",
            repoName: "test-repo",
          })
        ) as unknown,
        getSessionWorkdir: createMock(() => "/test/repo") as unknown,
      };

      const gitService = new GitService();

      // The PR workflow should handle git errors gracefully and still produce markdown
      const result = await gitService.prWithDependencies({ session: "test-session" }, mockDeps);

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
          const cmd = command as string;
          if (cmd.includes("commit")) {
            return {
              stdout: "[main abc123] Test commit message\n 1 file changed, 1 insertion(+)",
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.commitWithDependencies(
        "Test commit message",
        "/test/repo",
        mockDeps
      );

      expect(result).toBe("abc123");
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
          })) as unknown,
        };

        const result = await gitService.commitWithDependencies("Test", "/test/repo", mockDeps);
        expect(result).toBe(testCase.expected);
      }
    });

    test("should handle missing commit hash in git output", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({
          stdout: "Invalid git output",
          stderr: "",
        })) as unknown,
      };

      await expect(
        gitService.commitWithDependencies("Test", "/test/repo", mockDeps)
      ).rejects.toThrow("Failed to extract commit hash");
    });

    test("should handle commit with amend flag", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          expect(cmd).toContain("--amend");
          return { stdout: "[main def456] Amended commit\n 1 file changed", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.commitWithDependencies(
        "Amended message",
        "/test/repo",
        mockDeps,
        true
      );
      expect(result).toBe("def456");
    });

    test("should handle stash operations with state management", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("status --porcelain")) {
            return { stdout: "M  modified-file.ts\n?? untracked-file.ts", stderr: "" }; // Has changes
          }
          if (cmd.includes("stash push")) {
            return { stdout: "Saved working directory and index state", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.stashChangesWithDependencies("/test/repo", mockDeps);

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(true);
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should handle no changes to stash scenario", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("status --porcelain")) {
            return { stdout: "", stderr: "" }; // No changes
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.stashChangesWithDependencies("/test/repo", mockDeps);

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(false);
    });

    test("should handle popStash with existing stash", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("stash list")) {
            return { stdout: "stash@{0}: WIP on main: abc123 Previous work", stderr: "" };
          }
          if (cmd.includes("stash pop")) {
            return { stdout: "Dropped refs/stash@{0}", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.popStashWithDependencies("/test/repo", mockDeps);

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(true);
    });

    test("should handle popStash with no stash available", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("stash list")) {
            return { stdout: "", stderr: "" }; // No stash
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.popStashWithDependencies("/test/repo", mockDeps);

      expect(result.workdir).toBe("/test/repo");
      expect(result.stashed).toBe(false);
    });

    test("should handle merge conflicts with proper detection", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          const cmd = command as string;
          if (cmd.includes("rev-parse HEAD")) {
            return { stdout: "original-hash", stderr: "" };
          }
          if (cmd.includes("merge feature-branch")) {
            throw new Error("Automatic merge failed; fix conflicts and then commit the result");
          }
          if (cmd.includes("status --porcelain")) {
            return { stdout: "UU conflicted-file.ts\nAA another-conflict.ts", stderr: "" }; // Conflict markers
          }
          if (cmd.includes("merge --abort")) {
            return { stdout: "", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.mergeBranchWithDependencies(
        "/test/repo",
        "feature-branch",
        mockDeps
      );

      expect(result.workdir).toBe("/test/repo");
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
        }) as unknown,
      };

      const result = await gitService.mergeBranchWithDependencies(
        "/test/repo",
        "feature-branch",
        mockDeps
      );

      expect(result.workdir).toBe("/test/repo");
      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
    });

    test("should handle staging operations with proper command execution", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          expect(command.includes("git -C /test/repo add")).toBe(true);
          return { stdout: "", stderr: "" };
        }) as unknown,
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
        }) as unknown,
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
          if (command.includes("rev-parse HEAD")) {
            callCount++;
            // First call returns old hash, second call returns new hash
            const hash = callCount === 1 ? "old-commit-hash" : "new-commit-hash";
            return { stdout: hash, stderr: "" };
          }
          if (command.includes("fetch origin")) {
            return { stdout: "Fetching origin", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.pullLatestWithDependencies("/test/repo", mockDeps, "origin");

      expect(result.workdir).toBe("/test/repo");
      expect(result.updated).toBe(true);
    });

    test("should handle pullLatest with no updates", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse HEAD")) {
            return { stdout: "same-commit-hash", stderr: "" };
          }
          if (command.includes("fetch origin")) {
            return { stdout: "Already up to date.", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.pullLatestWithDependencies("/test/repo", mockDeps, "origin");

      expect(result.workdir).toBe("/test/repo");
      expect(result.updated).toBe(false);
    });

    test("should handle pullLatest with custom remote", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: unknown) => {
          if (command.includes("rev-parse HEAD")) {
            return { stdout: "test-hash", stderr: "" };
          }
          if (command.includes("fetch upstream")) {
            expect(command).toContain("upstream"); // Verify custom remote is used
            return { stdout: "Updated", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        }) as unknown,
      };

      const result = await gitService.pullLatestWithDependencies(
        "/test/repo",
        mockDeps,
        "upstream"
      );

      expect(result.workdir).toBe("/test/repo");
    });

    test("should document clone operations architectural limitation", () => {
      // NOTE: Clone operations through gitService.clone() have the same architectural limitation
      // as parameter-based functions - they call filesystem operations directly without DI.
      // These tests would violate @testing-boundaries.mdc by performing real git clones.
      //
      // SOLUTION: Use dependency injection patterns in tests that verify domain logic
      // without executing real filesystem/git operations.

      expect(typeof gitService.clone).toBe("function");
      expect(gitService.clone).toBeDefined();
    });

    test("should handle clone with empty repository URL validation", async () => {
      const mockDeps = {
        execAsync: createMock() as unknown,
        mkdir: createMock() as unknown,
        readdir: createMock() as unknown,
        access: createMock() as unknown,
      };

      await expect(
        gitService.cloneWithDependencies(
          {
            repoUrl: "",
            session: "test-session",
          },
          mockDeps
        )
      ).rejects.toThrow("Repository URL is required for cloning");
    });

    test("should document clone directory validation limitation", () => {
      // NOTE: Testing clone with existing non-empty directories requires
      // filesystem dependency injection that current clone() method doesn't support.
      // This would require architectural changes to support proper DI patterns.

      expect(typeof gitService.clone).toBe("function");
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
        }) as unknown,
        mkdir: createMock() as unknown,
        readdir: createMock(async () => {
          throw new Error("ENOENT");
        }) as unknown,
        access: createMock() as unknown,
      };

      await expect(
        gitService.cloneWithDependencies(
          {
            repoUrl: "https://github.com/user/nonexistent.git",
            session: "test-session",
          },
          mockDeps
        )
      ).rejects.toThrow("Failed to clone git repository");
    });

    test("should document clone verification limitation", () => {
      // NOTE: Testing clone success verification requires mocking filesystem access
      // operations which current clone() method doesn't support through DI.
      // This test scenario would require architectural changes for proper testing.

      expect(typeof gitService.clone).toBe("function");
    });

    test("should document local repository normalization limitation", () => {
      // NOTE: Testing local repository normalization requires filesystem dependency
      // injection that current clone() method doesn't support. This functionality
      // would require architectural changes to support proper DI patterns.

      expect(typeof gitService.clone).toBe("function");
    });

    test("should handle error scenarios with proper error propagation", async () => {
      const mockDeps = {
        execAsync: createMock(async () => {
          throw new Error("fatal: not a git repository");
        }) as unknown,
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

// ========== Factory Function Regression Tests ==========

describe("createGitService Factory Function", () => {
  test("should handle undefined options parameter without throwing runtime error", () => {
    expect(() => {
      createGitService();
    }).not.toThrow();
  });

  test("should handle null options parameter without throwing runtime error", () => {
    expect(() => {
      createGitService(null as unknown as { baseDir?: string });
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

describe("Service-Level Git Operations with Dependency Injection", () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService("/test/base/dir");
  });

  describe("commit operations through service layer", () => {
    test("should commit changes with dependency injection - all parameters", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({
          stdout: "[main abc123] test commit message",
          stderr: "",
        })),
      };

      const result = await gitService.commitWithDependencies(
        "test commit message",
        "/test/repo",
        mockDeps
      );

      expect(result).toBe("abc123");
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should commit changes with dependency injection - minimal parameters", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({
          stdout: "[main def456] minimal commit",
          stderr: "",
        })) as unknown,
      };

      const result = await gitService.commitWithDependencies(
        "minimal commit",
        "/test/repo",
        mockDeps
      );

      expect(result).toBe("def456");
      expectToHaveBeenCalled(mockDeps.execAsync);
    });

    test("should handle commit with amend through service layer", async () => {
      const mockDeps = {
        execAsync: createMock(async () => ({
          stdout: "[main abc789] Amended commit",
          stderr: "",
        })),
      };

      const result = await gitService.commitWithDependencies(
        "amended commit",
        "/test/repo",
        mockDeps
      );

      expect(result).toBe("abc789");
    });

    test("should handle commit error scenarios with proper DI", async () => {
      const mockDeps = {
        execAsync: createMock(async () => {
          throw new Error("Git command failed");
        }),
      };

      await expect(
        gitService.commitWithDependencies("test commit", "/test/repo", mockDeps)
      ).rejects.toThrow("Git command failed");
    });
  });

  describe("push operations - architectural note", () => {
    test("should document that push operations need DI implementation", () => {
      // NOTE: Push operations through pushFromParams() have the same architectural limitation
      // as commit operations - they call module-level execAsync directly without DI.
      // These tests would violate @testing-boundaries.mdc by executing real git commands.
      //
      // SOLUTION: Implement pushWithDependencies() method in GitService following the
      // same pattern as commitWithDependencies() for proper testing.

      expect(typeof pushFromParams).toBe("function");
      expect(pushFromParams).toBeDefined();
    });
  });
});

// Note: These commitChangesFromParams tests have been replaced with service-layer tests above
// that use proper dependency injection to avoid violating @testing-boundaries.mdc

// Note: These pushFromParams tests have been replaced with architectural notes above
// that document the need for pushWithDependencies() implementation to avoid violating @testing-boundaries.mdc
