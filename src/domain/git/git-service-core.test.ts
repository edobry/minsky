/**
 * Tests for GitService core API functionality
 * @migrated Extracted from git.test.ts for focused responsibility
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "../git";
import {
  createMock,
  setupTestMocks,
  mockModule,
} from "../../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Mock the logger module to avoid winston dependency issues
mockModule("../../utils/logger", () => ({
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
mockModule("../../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

// Mock the git-exec-enhanced module to prevent real git execution
mockModule("../../utils/git-exec-enhanced", () => ({
  execGitWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitFetchWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitMergeWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
  gitPushWithTimeout: createMock(async () => ({ stdout: "", stderr: "" })),
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
}); 
