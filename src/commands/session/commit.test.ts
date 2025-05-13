import { describe, test, expect, beforeEach } from "bun:test";
import { createCommitCommand } from "./commit.js";
import { Command } from "commander";
import type { SessionDB, SessionRecord } from "../../domain/session.js";
import type { GitService } from "../../domain/git.js";

describe("session commit command", () => {
  // Create mock objects with explicit typing
  const mockCommit = (message: string) => Promise.resolve("abc123");
  const mockPush = () => Promise.resolve({ pushed: true, workdir: "/test" });
  const mockGetStatus = () =>
    Promise.resolve({ modified: ["test.ts"], untracked: [], deleted: [] });
  const mockStageAll = () => Promise.resolve();
  const mockGetSessionWorkdir = () => "/test/workdir";

  const mockGitService = {
    commit: mockCommit,
    push: mockPush,
    getStatus: mockGetStatus,
    stageAll: mockStageAll,
    getSessionWorkdir: mockGetSessionWorkdir,
  };

  const mockGetSession = () =>
    Promise.resolve({
      session: "test-session",
      taskId: "037",
      repoName: "test-repo",
    });

  const mockSessionDb = {
    getSession: mockGetSession,
    getSessionByTaskId: () => Promise.resolve({ taskId: "037" } as SessionRecord),
  };

  const mockGetCurrentSession = () => Promise.resolve("test-session");

  // Mock prompt to avoid hanging in tests
  const mockPromptForMessage = () => Promise.resolve("mocked prompt message");

  // Spy on function calls
  let commitCalls: string[] = [];
  let pushCalls: boolean = false;
  let stageAllCalls: boolean = false;

  beforeEach(() => {
    // Reset tracking variables
    commitCalls = [];
    pushCalls = false;
    stageAllCalls = false;

    // Override mock implementations to track calls
    mockGitService.commit = (message: string) => {
      commitCalls.push(message);
      return Promise.resolve("abc123");
    };

    mockGitService.push = () => {
      pushCalls = true;
      return Promise.resolve({ pushed: true, workdir: "/test" });
    };

    mockGitService.stageAll = () => {
      stageAllCalls = true;
      return Promise.resolve();
    };

    mockGitService.getStatus = () => {
      return Promise.resolve({ modified: ["test.ts"], untracked: [], deleted: [] });
    };
  });

  test("uses prompted message when no message option provided", async () => {
    // Setup command with mocked dependencies
    const command = createCommitCommand({
      gitService: mockGitService as unknown as GitService,
      sessionDb: mockSessionDb as unknown as SessionDB,
      getCurrentSession: async () => mockGetCurrentSession(),
      promptForMessage: mockPromptForMessage,
      isTestEnvironment: true,
    });

    const program = new Command();
    program.addCommand(command);

    // No -m option, should use the prompt (which is mocked)
    await program.parseAsync(["node", "test", "commit"]);

    // The commit should happen with the prompted message (with task ID prefix)
    expect(commitCalls.length).toBe(1);
    expect(commitCalls[0]).toBe("[#037] mocked prompt message");
  });

  test("stages and commits changes with message", async () => {
    const command = createCommitCommand({
      gitService: mockGitService as unknown as GitService,
      sessionDb: mockSessionDb as unknown as SessionDB,
      getCurrentSession: async () => mockGetCurrentSession(),
      promptForMessage: mockPromptForMessage,
      isTestEnvironment: true,
    });

    const program = new Command();
    program.addCommand(command);

    await program.parseAsync(["node", "test", "commit", "-m", "test commit"]);

    // Verify the mocks were called with expected arguments
    expect(stageAllCalls).toBe(true);
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls[0]).toBe("[#037] test commit"); // With task ID prefix
    expect(pushCalls).toBe(true);
  });

  test("skips push with --no-push flag", async () => {
    const command = createCommitCommand({
      gitService: mockGitService as unknown as GitService,
      sessionDb: mockSessionDb as unknown as SessionDB,
      getCurrentSession: async () => mockGetCurrentSession(),
      promptForMessage: mockPromptForMessage,
      isTestEnvironment: true,
    });

    const program = new Command();
    program.addCommand(command);

    await program.parseAsync(["node", "test", "commit", "-m", "test commit", "--no-push"]);

    // Verify stageAll and commit were called, but push was not
    expect(stageAllCalls).toBe(true);
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(pushCalls).toBe(false);
  });

  test("adds task ID prefix when in session", async () => {
    const currentSession = "task#037";

    const command = createCommitCommand({
      gitService: mockGitService as unknown as GitService,
      sessionDb: mockSessionDb as unknown as SessionDB,
      getCurrentSession: async () => currentSession,
      promptForMessage: mockPromptForMessage,
      isTestEnvironment: true,
    });

    const program = new Command();
    program.addCommand(command);

    await program.parseAsync(["node", "test", "commit", "-m", "test commit"]);

    // Verify commit was called with task ID prefix
    expect(commitCalls.length).toBeGreaterThan(0);
    expect(commitCalls[0]).toContain("[#037]");
  });

  test("errors when no changes to commit", async () => {
    // Override getStatus to return no changes
    mockGitService.getStatus = () => Promise.resolve({ modified: [], untracked: [], deleted: [] });

    const command = createCommitCommand({
      gitService: mockGitService as unknown as GitService,
      sessionDb: mockSessionDb as unknown as SessionDB,
      getCurrentSession: async () => mockGetCurrentSession(),
      promptForMessage: mockPromptForMessage,
      isTestEnvironment: true,
    });

    const program = new Command();
    program.addCommand(command);

    let error;
    try {
      await program.parseAsync(["node", "test", "commit", "-m", "test commit"]);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(commitCalls.length).toBe(0);
  });
});
