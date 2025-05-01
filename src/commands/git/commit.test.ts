import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Mock } from "bun:test";
import type { SessionDB, SessionRecord } from "../../domain/session";
import { createGitCommitCommand } from "./commit";
import { GitService } from "../../domain/git";
import type { GitStatus } from "../../domain/git";

// Mock dependencies
const mockGitServiceInstance = {
  getStatus: mock.fn<() => Promise<GitStatus>>(),
  stageAll: mock.fn<() => Promise<void>>(),
  stageModified: mock.fn<() => Promise<void>>(),
  commit: mock.fn<(message: string, amend?: boolean) => Promise<string>>()
};

type MockGitService = typeof mockGitServiceInstance;

mock.module("../../domain/git", () => ({
  GitService: mock.fn(() => mockGitServiceInstance)
}));

mock.module("../../domain/session", () => ({
  SessionDB: mock.fn(),
  getSession: mock.fn<() => Promise<SessionRecord | null>>()
}));

// Mock resolveRepoPath function
const resolveRepoPath = mock.fn<(path: string) => Promise<string>>();
mock.module("../../utils/repo", () => ({
  resolveRepoPath
}));

describe("git commit command", () => {
  let command: ReturnType<typeof createGitCommitCommand>;
  let mockGitService: MockGitService;
  let mockSessionService: { getSession: Mock<() => Promise<SessionRecord | null>> };
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalProcessExit: typeof process.exit;
  let mockConsoleLog: Mock<typeof console.log>;
  let mockConsoleError: Mock<typeof console.error>;
  let mockProcessExit: Mock<typeof process.exit>;

  beforeEach(() => {
    command = createGitCommitCommand();
    mockGitService = mockGitServiceInstance;
    mockSessionService = { getSession: mock.fn<() => Promise<SessionRecord | null>>() };

    // Save original console methods
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalProcessExit = process.exit;

    // Create mock functions
    mockConsoleLog = mock.fn<typeof console.log>();
    mockConsoleError = mock.fn<typeof console.error>();
    mockProcessExit = mock.fn<typeof process.exit>();

    // Mock console methods
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    process.exit = mockProcessExit;

    // Reset mocks
    mock.restoreAll();
  });

  afterEach(() => {
    // Restore original console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
  });

  test("requires commit message unless amending", async () => {
    await command.parseAsync(["node", "minsky", "commit"]);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Commit message is required"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  test("stages and commits changes with message", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    mockGitService.getStatus.mockResolvedValue(mockStatus);
    mockGitService.commit.mockResolvedValue(mockCommitHash);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    expect(mockGitService.stageModified).toHaveBeenCalled();
    expect(mockGitService.commit).toHaveBeenCalledWith("test commit", false);
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(mockCommitHash));
  });

  test("adds task ID prefix when in session", async () => {
    const mockStatus: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    const mockCommitHash = "abc123";
    const mockSession: SessionRecord = {
      session: "test-session",
      repoUrl: "https://github.com/test/repo",
      repoName: "test/repo",
      taskId: "123",
      repoPath: "/path/to/repo",
      createdAt: new Date().toISOString()
    };
    mockGitService.getStatus.mockResolvedValue(mockStatus);
    mockGitService.commit.mockResolvedValue(mockCommitHash);
    mockSessionService.getSession.mockResolvedValue(mockSession);

    await command.parseAsync(["node", "minsky", "commit", "-s", "test-session", "-m", "test commit"]);

    expect(mockGitService.commit).toHaveBeenCalledWith("task#123: test commit", false);
  });

  test("uses --all flag to stage all changes", async () => {
    const mockStatusAll: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusAll);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-a", "-m", "test commit"]);

    expect(mockGitService.stageAll).toHaveBeenCalled();
    expect(mockGitService.stageModified).not.toHaveBeenCalled();
  });

  test("skips staging with --no-stage", async () => {
    const mockStatusNoStage: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusNoStage);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--no-stage", "-m", "test commit"]);

    expect(mockGitService.stageAll).not.toHaveBeenCalled();
    expect(mockGitService.stageModified).not.toHaveBeenCalled();
  });

  test("amends previous commit", async () => {
    const mockStatusAmend: GitStatus = { modified: ["file1"], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusAmend);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "--amend", "-m", "amended commit"]);

    expect(mockGitService.commit).toHaveBeenCalledWith("amended commit", true);
  });

  test("errors when no changes to commit", async () => {
    const mockStatusEmpty: GitStatus = { modified: [], untracked: [], deleted: [] };
    mockGitService.getStatus.mockResolvedValue(mockStatusEmpty);
    resolveRepoPath.mockResolvedValue("/path/to/repo");

    await command.parseAsync(["node", "minsky", "commit", "-m", "test commit"]);

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("No changes to commit"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  test("errors when session not found", async () => {
    mockSessionService.getSession.mockResolvedValue(null);

    await command.parseAsync(["node", "minsky", "commit", "-s", "nonexistent", "-m", "test commit"]);

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Session 'nonexistent' not found"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
}); 
