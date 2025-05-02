import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { SessionRecord } from "../../domain/session";
import { createGitCommitCommand } from "./commit";
import type { GitStatus } from "../../domain/git";

// Manual mock function factory
function createMockFn(impl?: any) {
  const fn: any = (...args: any[]) => {
    fn.calls.push(args);
    if (fn._impl) return fn._impl(...args);
    if (impl) return impl(...args);
  };
  fn.calls = [];
  fn.mockImplementation = (f: any) => { fn._impl = f; };
  fn._impl = null;
  fn.mockResolvedValue = (v: any) => { fn._impl = () => Promise.resolve(v); };
  fn.mockReturnValue = (v: any) => { fn._impl = () => v; };
  fn.toHaveBeenCalledWith = (...expected: any[]) => {
    expect(fn.calls.some((call: any) => JSON.stringify(call) === JSON.stringify(expected))).toBe(true);
  };
  return fn;
}

const mockGitServiceInstance = {
  getStatus: createMockFn(async () => ({})),
  stageAll: createMockFn(async () => {}),
  stageModified: createMockFn(async () => {}),
  commit: createMockFn(async (message: string, amend?: boolean) => "commit-sha")
};

const GitService = createMockFn(() => mockGitServiceInstance);
const SessionDB = createMockFn();
const getSession = createMockFn(async () => null);
const resolveRepoPath = createMockFn(async (path: string) => "/mock/repo/path");

let mockSessionService: { getSession: any };

const mockConsoleLog = createMockFn();
const mockConsoleError = createMockFn();
const mockProcessExit = createMockFn();

describe("git commit command", () => {
  let command: ReturnType<typeof createGitCommitCommand>;
  let mockGitService: typeof mockGitServiceInstance;
  let mockSessionService: { getSession: any };
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let mockConsoleLog: any;
  let mockConsoleError: any;
  let mockProcessExit: any;

  beforeEach(() => {
    command = createGitCommitCommand();
    mockGitService = mockGitServiceInstance;
    mockSessionService = { getSession: createMockFn(async () => null) };

    // Save original console methods
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    // Create mock functions
    mockConsoleLog = createMockFn();
    mockConsoleError = createMockFn();
    mockProcessExit = createMockFn();

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
    expect(mockConsoleError.calls.some((args: any[]) => args[0]?.includes("Commit message is required"))).toBe(true);
    expect(mockProcessExit.calls.some((args: any[]) => args[0] === 1)).toBe(true);
  });

  test("stages and commits changes with message", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    mockGitService.getStatus.mockResolvedValue(mockStatus);
    mockGitService.commit.mockResolvedValue(mockCommitHash);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    expect(mockGitService.stageModified.calls.length > 0).toBe(true);
    expect(mockGitService.commit.calls.some((args: any[]) => args[0] === "test commit" && args[1] === false)).toBe(true);
    expect(mockConsoleLog.calls.some((args: any[]) => (args[0] || "").includes(mockCommitHash))).toBe(true);
  });

  test("adds task ID prefix when in session", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    const mockSession: SessionRecord = {
      session: "test-session",
      repoUrl: "https://github.com/test/repo",
      repoName: "test/repo",
      taskId: "123",
      createdAt: new Date().toISOString()
    };
    mockGitService.getStatus.mockResolvedValue(mockStatus);
    mockGitService.commit.mockResolvedValue(mockCommitHash);
    mockSessionService.getSession.mockResolvedValue(mockSession);

    await command.parseAsync(["node", "minsky", "commit", "-s", "test-session", "-m", "test commit"]);

    expect(mockGitService.commit.calls.some((args: any[]) => args[0] === "task#123: test commit" && args[1] === false)).toBe(true);
  });

  test("uses --all flag to stage all changes", async () => {
    const mockStatusAll: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusAll);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-a", "-m", "test commit"]);

    expect(mockGitService.stageAll.calls.length > 0).toBe(true);
    expect(mockGitService.stageModified.calls.length).toBe(0);
  });

  test("skips staging with --no-stage", async () => {
    const mockStatusNoStage: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusNoStage);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--no-stage", "-m", "test commit"]);

    expect(mockGitService.stageAll.calls.length).toBe(0);
    expect(mockGitService.stageModified.calls.length).toBe(0);
  });

  test("amends previous commit", async () => {
    const mockStatusAmend: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusAmend);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--amend", "-m", "amended commit"]);

    expect(mockGitService.commit.calls.some((args: any[]) => args[0] === "amended commit" && args[1] === true)).toBe(true);
  });

  test("errors when no changes to commit", async () => {
    const mockStatusEmpty: GitStatus = { modified: [], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusEmpty);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    expect(mockConsoleError.calls.some((args: any[]) => args[0]?.includes("No changes to commit"))).toBe(true);
    expect(mockProcessExit.calls.some((args: any[]) => args[0] === 1)).toBe(true);
  });

  test("errors when session not found", async () => {
    mockSessionService.getSession.mockResolvedValue(null);

    await command.parseAsync(["node", "minsky", "commit", "-s", "nonexistent", "-m", "test commit"]);

    expect(mockConsoleError.calls.some((args: any[]) => args[0]?.includes("Session 'nonexistent' not found"))).toBe(true);
    expect(mockProcessExit.calls.some((args: any[]) => args[0] === 1)).toBe(true);
  });
}); 
