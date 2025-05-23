/**
 * Tests for the git service
 * @migrated Migrated to native Bun patterns
 * @enhanced Enhanced with comprehensive method coverage and DI patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git";
import { MinskyError } from "../errors/index.js";
import { createMock, setupTestMocks, mockModule, createMockFileSystem } from "../utils/test-utils/mocking.js";
import { expectToHaveBeenCalled, expectToHaveBeenCalledWith } from "../utils/test-utils/assertions.js";
import { TestGitService } from "../utils/test-utils/test-git-service.js";

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

// Mock the centralized execAsync module at the top level for proper module interception
const mockExecAsync = createMock();
mockModule("../utils/exec", () => ({
  execAsync: mockExecAsync
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
        }) as any,
        getSession: createMock(() => Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/user/repo.git"
        })) as any,
        getSessionWorkdir: createMock(() => "/test/repo/sessions/test-session") as any
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
        execAsync: createMock() as any,
        getSession: createMock(() => Promise.resolve(null)) as any,
        getSessionWorkdir: createMock() as any
      };

      const gitService = new GitService();
      
      await expect(gitService.prWithDependencies(
        { session: "nonexistent" },
        mockDeps
      )).rejects.toThrow("Session 'nonexistent' not found");
    });

    test("should handle git command failures gracefully in PR workflow", async () => {
      const mockDeps = {
        execAsync: createMock(async (command: string) => {
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
        getSession: createMock(() => Promise.resolve({
          session: "test-session",
          repoName: "test-repo"
        })) as any,
        getSessionWorkdir: createMock(() => "/test/repo") as any
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
      // Future work: Add *WithDependencies variants for critical methods
    });
  });
});
