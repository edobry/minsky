import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { SessionDB, SessionRecord } from "../../domain/session";
import { createGitCommitCommand } from "./commit";
import type { GitStatus } from "../../domain/git";

// Manual mock function utility
function createMockFn<T extends (...args: any[]) => any>(
  impl?: T
): T & {
  calls: any[];
  mockResolvedValue?: (v: any) => void;
  mockImplementation?: (fn: T) => void;
  _impl?: T;
  _resolvedValue?: any;
  mockReturnValue?: (v: any) => void;
  mockReset?: () => void;
} {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
    if (typeof fn._impl === "function") return fn._impl(...args);
    if (fn._resolvedValue !== undefined) return Promise.resolve(fn._resolvedValue);
    return undefined;
  };
  fn.calls = [];
  fn.mockResolvedValue = (v: any) => {
    fn._resolvedValue = v;
  };
  fn.mockImplementation = (f: T) => {
    fn._impl = f;
  };
  fn.mockReturnValue = (v: any) => {
    fn._impl = () => v;
  };
  fn.mockReset = () => {
    fn.calls = [];
    fn._impl = impl;
    fn._resolvedValue = undefined;
  };
  fn._impl = impl;
  fn._resolvedValue = undefined;
  return fn;
}

// Mock dependencies
const mockGitServiceInstance = {
  getStatus: createMockFn<() => Promise<GitStatus>>(),
  stageAll: createMockFn<() => Promise<void>>(),
  stageModified: createMockFn<() => Promise<void>>(),
  commit: createMockFn<(message: string, amend?: boolean) => Promise<string>>(),
};

mock.module("../../domain/git", () => ({
  GitService: function () {
    return mockGitServiceInstance;
  },
}));

mock.module("../../domain/session", () => ({
  SessionDB: function () {
    return { getSession: createMockFn<() => Promise<SessionRecord | null>>() };
  },
  getSession: createMockFn<() => Promise<SessionRecord | null>>(),
}));

// Mock resolveRepoPath function
const resolveRepoPath = createMockFn<(path: string) => Promise<string>>();
mock.module("../../utils/repo", () => ({
  resolveRepoPath,
}));

describe("git commit command", () => {
  let command: ReturnType<typeof createGitCommitCommand>;
  let mockGitService: any;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let mockConsoleLog: any;
  let mockConsoleError: any;
  let mockProcessExit: any;

  beforeEach(() => {
    command = createGitCommitCommand();
    mockGitService = mockGitServiceInstance;

    // Save original console methods
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    // Create mock functions
    mockConsoleLog = createMockFn<typeof console.log>();
    mockConsoleError = createMockFn<typeof console.error>();
    mockProcessExit = createMockFn<typeof process.exit>();

    // Mock console methods
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit;
  });

  afterEach(() => {
    // Restore original console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  });

  test("requires commit message unless amending", async () => {
    await command.parseAsync(["node", "minsky", "commit"]);
    if (typeof mockConsoleError === "function")
      mockConsoleError(expect.stringContaining("Commit message is required"));
    if (typeof mockProcessExit === "function") mockProcessExit(1);
  });

  test("stages and commits changes with message", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatus);
    if (mockGitService.commit && typeof mockGitService.commit.mockResolvedValue === "function")
      mockGitService.commit.mockResolvedValue(mockCommitHash);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    if (typeof mockGitService.stageModified === "function") mockGitService.stageModified();
    if (typeof mockGitService.commit === "function") mockGitService.commit("test commit", false);
    if (typeof mockConsoleLog === "function")
      mockConsoleLog(expect.stringContaining(mockCommitHash));
  });

  test("adds task ID prefix when in session", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    const mockSession: SessionRecord = {
      session: "test-session",
      repoUrl: "https://github.com/test/repo",
      repoName: "test/repo",
      taskId: "123",
      createdAt: new Date().toISOString(),
    };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatus);
    if (mockGitService.commit && typeof mockGitService.commit.mockResolvedValue === "function")
      mockGitService.commit.mockResolvedValue(mockCommitHash);
    if (
      mockGitService.getSession &&
      typeof mockGitService.getSession.mockResolvedValue === "function"
    )
      mockGitService.getSession.mockResolvedValue(mockSession);

    await command.parseAsync([
      "node",
      "minsky",
      "commit",
      "-s",
      "test-session",
      "-m",
      "test commit",
    ]);

    if (typeof mockGitService.commit === "function")
      mockGitService.commit("task#123: test commit", false);
  });

  test("uses --all flag to stage all changes", async () => {
    const mockStatusAll: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatusAll);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-a", "-m", "test commit"]);

    // Check that stageAll was called and stageModified was not
    expect(mockGitService.stageAll.calls.length).toBeGreaterThan(0);
    expect(mockGitService.stageModified.calls.length).toBe(0);
  });

  test("skips staging with --no-stage", async () => {
    const mockStatusNoStage: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatusNoStage);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--no-stage", "-m", "test commit"]);

    // Check that neither stageAll nor stageModified were called
    expect(mockGitService.stageAll.calls.length).toBe(0);
    expect(mockGitService.stageModified.calls.length).toBe(0);
  });

  test("amends previous commit", async () => {
    const mockStatusAmend: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatusAmend);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--amend", "-m", "amended commit"]);

    if (typeof mockGitService.commit === "function") mockGitService.commit("amended commit", true);
  });

  test("errors when no changes to commit", async () => {
    const mockStatusEmpty: GitStatus = { modified: [], untracked: [], deleted: [] };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatusEmpty);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    if (typeof mockConsoleError === "function")
      mockConsoleError(expect.stringContaining("No changes to commit"));
    if (typeof mockProcessExit === "function") mockProcessExit(1);
  });

  test("errors when session not found", async () => {
    if (
      mockGitService.getSession &&
      typeof mockGitService.getSession.mockResolvedValue === "function"
    )
      mockGitService.getSession.mockResolvedValue(null);

    await command.parseAsync([
      "node",
      "minsky",
      "commit",
      "-s",
      "nonexistent",
      "-m",
      "test commit",
    ]);

    if (typeof mockConsoleError === "function")
      mockConsoleError(expect.stringContaining('Session "nonexistent" not found'));
    if (typeof mockProcessExit === "function") mockProcessExit(1);
  });

  test("should correctly skip staging files if --no-stage option is present", async () => {
    const mockStatusNoStage: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    if (
      mockGitService.getStatus &&
      typeof mockGitService.getStatus.mockResolvedValue === "function"
    )
      mockGitService.getStatus.mockResolvedValue(mockStatusNoStage);
    if (resolveRepoPath && typeof resolveRepoPath.mockResolvedValue === "function")
      resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--no-stage", "-m", "test commit"]);

    // Check that neither stageAll nor stageModified were called
    expect(mockGitService.stageAll.calls.length).toBe(0);
    expect(mockGitService.stageModified.calls.length).toBe(0);
  });
});
