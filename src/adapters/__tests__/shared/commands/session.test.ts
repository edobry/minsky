/**
 * Shared Session Commands Tests
 * @migrated Migrated to native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as sessionDomain from "../../../../domain/session.js";
import {
  expectToHaveBeenCalled,
  getMockCallArg,
  expectToHaveLength,
} from "../../../../utils/test-utils/assertions.js";
import { setupTestMocks } from "../../../../utils/test-utils/mocking.js";
import { sharedCommandRegistry, CommandCategory } from "../../../shared/command-registry.js";
import { registerSessionCommands } from "../../../shared/commands/session.js";

// Set up automatic mock cleanup
setupTestMocks();

describe("Shared Session Commands", () => {
  // Set up spies for domain functions
  let getSessionSpy: ReturnType<typeof spyOn>;
  let listSessionsSpy: ReturnType<typeof spyOn>;
  let startSessionSpy: ReturnType<typeof spyOn>;
  let deleteSessionSpy: ReturnType<typeof spyOn>;
  let getSessionDirSpy: ReturnType<typeof spyOn>;
  let updateSessionSpy: ReturnType<typeof spyOn>;
  let approveSessionSpy: ReturnType<typeof spyOn>;
  let sessionPrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Set up spies
    getSessionSpy = spyOn(sessionDomain, "getSessionFromParams").mockImplementation(() =>
      Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "123",
        branch: "test-branch",
      })
    );

    listSessionsSpy = spyOn(sessionDomain, "listSessionsFromParams").mockImplementation(() =>
      Promise.resolve([
        {
          session: "test-session-1",
          repoName: "test-repo-1",
          repoUrl: "https://github.com/test/repo1",
          createdAt: new Date().toISOString(),
          taskId: "123",
          branch: "test-branch-1",
        },
        {
          session: "test-session-2",
          repoName: "test-repo-2",
          repoUrl: "https://github.com/test/repo2",
          createdAt: new Date().toISOString(),
          taskId: "456",
          branch: "test-branch-2",
        },
      ])
    );

    startSessionSpy = spyOn(sessionDomain, "startSessionFromParams").mockImplementation(() =>
      Promise.resolve({
        session: "new-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "789",
        branch: "new-branch",
      })
    );

    deleteSessionSpy = spyOn(sessionDomain, "deleteSessionFromParams").mockImplementation(() =>
      Promise.resolve(true)
    );

    getSessionDirSpy = spyOn(sessionDomain, "getSessionDirFromParams").mockImplementation(() =>
      Promise.resolve("/test/dir/test-session")
    );

    updateSessionSpy = spyOn(sessionDomain, "updateSessionFromParams").mockImplementation(() =>
      Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        branch: "test-branch",
        createdAt: new Date().toISOString(),
        taskId: "123",
        repoPath: "/mock/session/workdir",
      })
    );

    approveSessionSpy = spyOn(sessionDomain, "approveSessionFromParams").mockImplementation(() =>
      Promise.resolve({
        session: "test-session",
        commitHash: "abc123",
        mergeDate: new Date().toISOString(),
        mergedBy: "test-user",
        baseBranch: "main",
        prBranch: "pr/test-branch",
        taskId: "123",
      })
    );

    sessionPrSpy = spyOn(sessionDomain, "sessionPrFromParams").mockImplementation(() =>
      Promise.resolve({
        prBranch: "pr/test-branch",
        baseBranch: "main",
        title: "Test PR",
        body: "Test PR body",
      })
    );

    // Clear the registry for testing
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Restore all mocks for clean tests
    mock.restore();
  });

  test("registerSessionCommands should register session commands in registry", () => {
    // Register commands
    registerSessionCommands();

    // Verify commands were registered
    const sessionCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION);
    expectToHaveLength(sessionCommands, 9);

    // Verify individual commands
    const expectedCommands = [
      "session.list",
      "session.get",
      "session.start",
      "session.dir",
      "session.delete",
      "session.update",
      "session.approve",
      "session.pr",
    ];

    expectedCommands.forEach((cmdId) => {
      const command = sharedCommandRegistry.getCommand(cmdId);
      expect(command).toBeDefined();
      expect(command?.category).toBe(CommandCategory.SESSION);
    });
  });

  test("session.list command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const listCommand = sharedCommandRegistry.getCommand("session.list");
    expect(listCommand).toBeDefined();

    // Execute command
    const params = {
      repo: "/test/repo",
      json: true,
    };
    const context = { interface: "test" };
    const result = await listCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(listSessionsSpy);
    expect(getMockCallArg(listSessionsSpy, 0, 0)).toEqual({
      repo: "/test/repo",
      json: true,
    });

    // Verify result
    expect(result.success).toBe(true);
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0].session).toBe("test-session-1");
    expect(result.sessions[0].repoName).toBe("test-repo-1");
    expect(result.sessions[1].session).toBe("test-session-2");
    expect(result.sessions[1].repoName).toBe("test-repo-2");
  });

  test("session.get command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const getCommand = sharedCommandRegistry.getCommand("session.get");
    expect(getCommand).toBeDefined();

    // Execute command
    const params = {
      name: "test-session",
      repo: "/test/repo",
      json: true,
    };
    const context = { interface: "test" };
    const result = await getCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(getSessionSpy);
    expect(getMockCallArg(getSessionSpy, 0, 0)).toEqual({
      name: "test-session",
      task: undefined,
      repo: "/test/repo",
      json: true,
    });

    // Verify result
    expect(result.success).toBe(true);
    expect(result.session.session).toBe("test-session");
    expect(result.session.taskId).toBe("123");
  });

  test("session.start command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const startCommand = sharedCommandRegistry.getCommand("session.start");
    expect(startCommand).toBeDefined();

    // Execute command
    const params = {
      name: "custom-session",
      task: "123",
      branch: "feature-branch",
      repo: "/test/repo",
      quiet: true,
      noStatusUpdate: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await startCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(startSessionSpy);
    expect(getMockCallArg(startSessionSpy, 0, 0)).toEqual({
      name: "custom-session",
      task: "123",
      branch: "feature-branch",
      repo: "/test/repo",
      session: undefined,
      quiet: true,
      noStatusUpdate: true,
      json: true,
      skipInstall: undefined,
      packageManager: undefined,
    });

    // Verify result
    expect(result.success).toBe(true);
    expect(result.session.session).toBe("new-session");
    expect(result.session.taskId).toBe("789");
  });

  test("session.dir command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const dirCommand = sharedCommandRegistry.getCommand("session.dir");
    expect(dirCommand).toBeDefined();

    // Execute command
    const params = {
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true,
    };
    const context = { interface: "test" };
    const result = await dirCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(getSessionDirSpy);
    expect(getMockCallArg(getSessionDirSpy, 0, 0)).toEqual({
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true,
    });

    // Verify result
    expect(result).toEqual({
      success: true,
      directory: "/test/dir/test-session",
    });
  });

  test("session.delete command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const deleteCommand = sharedCommandRegistry.getCommand("session.delete");
    expect(deleteCommand).toBeDefined();

    // Execute command
    const params = {
      name: "test-session",
      repo: "/test/repo",
      force: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await deleteCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(deleteSessionSpy);
    expect(getMockCallArg(deleteSessionSpy, 0, 0)).toEqual({
      name: "test-session",
      task: undefined,
      force: true,
      repo: "/test/repo",
      json: true,
    });

    // Verify result
    expect(result).toEqual({
      success: true,
      session: "test-session",
    });
  });

  test("session.update command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const updateCommand = sharedCommandRegistry.getCommand("session.update");
    expect(updateCommand).toBeDefined();

    // Execute command
    const params = {
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      branch: "update-branch",
      noStash: true,
      noPush: true,
      force: false,
      json: true,
    };
    const context = { interface: "test" };
    const result = await updateCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(updateSessionSpy);
    expect(getMockCallArg(updateSessionSpy, 0, 0)).toEqual({
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      branch: "update-branch",
      noStash: true,
      noPush: true,
      force: false,
      json: true,
    });

    // Verify result
    expect(result).toEqual({
      success: true,
      session: "test-session",
    });
  });

  test("session.approve command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const approveCommand = sharedCommandRegistry.getCommand("session.approve");
    expect(approveCommand).toBeDefined();

    // Execute command
    const params = {
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true,
    };
    const context = { interface: "test" };
    const result = await approveCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(approveSessionSpy);
    expect(getMockCallArg(approveSessionSpy, 0, 0)).toEqual({
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true,
    });

    // Verify result
    expect(result).toEqual({
      success: true,
      result: {
        session: "test-session",
        commitHash: "abc123",
        mergeDate: expect.any(String),
        mergedBy: "test-user",
        baseBranch: "main",
        prBranch: "pr/test-branch",
        taskId: "123",
      },
    });
  });

  test("session.pr command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();

    // Get command
    const prCommand = sharedCommandRegistry.getCommand("session.pr");
    expect(prCommand).toBeDefined();

    // Execute command
    const params = {
      title: "Test PR",
      body: "Test PR body",
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      noStatusUpdate: true,
      debug: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await prCommand!.execute(params, context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(sessionPrSpy);
    expect(getMockCallArg(sessionPrSpy, 0, 0)).toEqual({
      title: "Test PR",
      body: "Test PR body",
      bodyPath: undefined,
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      noStatusUpdate: true,
      debug: true,
    });

    // Verify result
    expect(result).toEqual({
      success: true,
      prBranch: "pr/test-branch",
      baseBranch: "main",
      title: "Test PR",
      body: "Test PR body",
    });
  });
});
