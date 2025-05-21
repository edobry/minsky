/**
 * Shared Session Commands Tests
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registerSessionCommands } from "../../../../adapters/shared/commands/session.js";
import { sharedCommandRegistry, CommandCategory } from "../../../../adapters/shared/command-registry.js";
import * as sessionDomain from "../../../../domain/session.js";

// Custom matcher helper functions
const arrayContaining = (arr: any[]) => ({
  asymmetricMatch: (actual: any[]) => 
    Array.isArray(actual) && 
    arr.every(item => 
      actual.some(actualItem => 
        JSON.stringify(actualItem).includes(JSON.stringify(item))
      )
    )
});

const objectContaining = (obj: Record<string, any>) => ({
  asymmetricMatch: (actual: Record<string, any>) => 
    typeof actual === 'object' && 
    Object.entries(obj).every(([key, value]) => 
      key in actual && JSON.stringify(actual[key]).includes(JSON.stringify(value))
    )
});

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
        branch: "test-branch"
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
          branch: "test-branch-1"
        },
        {
          session: "test-session-2",
          repoName: "test-repo-2",
          repoUrl: "https://github.com/test/repo2",
          createdAt: new Date().toISOString(),
          taskId: "456",
          branch: "test-branch-2"
        }
      ])
    );
    
    startSessionSpy = spyOn(sessionDomain, "startSessionFromParams").mockImplementation(() => 
      Promise.resolve({
        session: "new-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: new Date().toISOString(),
        taskId: "789",
        branch: "new-branch"
      })
    );
    
    deleteSessionSpy = spyOn(sessionDomain, "deleteSessionFromParams").mockImplementation(() => 
      Promise.resolve(true)
    );
    
    getSessionDirSpy = spyOn(sessionDomain, "getSessionDirFromParams").mockImplementation(() => 
      Promise.resolve("/test/dir/test-session")
    );
    
    updateSessionSpy = spyOn(sessionDomain, "updateSessionFromParams").mockImplementation(() => 
      Promise.resolve()
    );
    
    approveSessionSpy = spyOn(sessionDomain, "approveSessionFromParams").mockImplementation(() => 
      Promise.resolve({
        session: "test-session",
        commitHash: "abc123",
        mergeDate: new Date().toISOString(),
        mergedBy: "test-user",
        baseBranch: "main",
        prBranch: "pr/test-branch",
        taskId: "123"
      })
    );
    
    sessionPrSpy = spyOn(sessionDomain, "sessionPrFromParams").mockImplementation(() => 
      Promise.resolve({
        prBranch: "pr/test-branch",
        baseBranch: "main",
        title: "Test PR",
        body: "Test PR body"
      })
    );
    
    // Clear the registry for testing
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Restore original functions
    getSessionSpy.mockRestore();
    listSessionsSpy.mockRestore();
    startSessionSpy.mockRestore();
    deleteSessionSpy.mockRestore();
    getSessionDirSpy.mockRestore();
    updateSessionSpy.mockRestore();
    approveSessionSpy.mockRestore();
    sessionPrSpy.mockRestore();
  });

  test("registerSessionCommands should register session commands in registry", () => {
    // Register commands
    registerSessionCommands();
    
    // Verify commands were registered
    const sessionCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION);
    expect(sessionCommands.length).toBe(8);
    
    // Verify individual commands
    const expectedCommands = [
      "session.list",
      "session.get",
      "session.start",
      "session.dir",
      "session.delete",
      "session.update",
      "session.approve",
      "session.pr"
    ];
    
    expectedCommands.forEach(cmdId => {
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
      json: true
    };
    const context = { interface: "test" };
    const result = await listCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(listSessionsSpy).toHaveBeenCalledWith({
      repo: "/test/repo",
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      sessions: arrayContaining([
        objectContaining({
          session: "test-session-1",
          repoName: "test-repo-1"
        }),
        objectContaining({
          session: "test-session-2",
          repoName: "test-repo-2"
        })
      ])
    });
  });

  test("session.get command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get command
    const getCommand = sharedCommandRegistry.getCommand("session.get");
    expect(getCommand).toBeDefined();
    
    // Execute command
    const params = {
      session: "test-session",
      repo: "/test/repo",
      json: true
    };
    const context = { interface: "test" };
    const result = await getCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(getSessionSpy).toHaveBeenCalledWith({
      name: "test-session",
      repo: "/test/repo",
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      session: objectContaining({
        session: "test-session",
        taskId: "123"
      })
    });
  });

  test("session.start command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get command
    const startCommand = sharedCommandRegistry.getCommand("session.start");
    expect(startCommand).toBeDefined();
    
    // Execute command
    const params = {
      task: "123",
      branch: "feature-branch",
      repo: "/test/repo",
      session: "custom-session",
      quiet: true,
      noStatusUpdate: true,
      json: true
    };
    const context = { interface: "test" };
    const result = await startCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(startSessionSpy).toHaveBeenCalledWith({
      task: "123",
      branch: "feature-branch",
      repo: "/test/repo",
      name: "custom-session",
      quiet: true,
      noStatusUpdate: true,
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      session: objectContaining({
        session: "new-session",
        taskId: "789"
      })
    });
  });

  test("session.dir command should call domain function with correct params", async () => {
    // Register commands
    registerSessionCommands();
    
    // Get command
    const dirCommand = sharedCommandRegistry.getCommand("session.dir");
    expect(dirCommand).toBeDefined();
    
    // Execute command
    const params = {
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true
    };
    const context = { interface: "test" };
    const result = await dirCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(getSessionDirSpy).toHaveBeenCalledWith({
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      directory: "/test/dir/test-session"
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
      session: "test-session",
      repo: "/test/repo",
      force: true,
      json: true
    };
    const context = { interface: "test" };
    const result = await deleteCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(deleteSessionSpy).toHaveBeenCalledWith({
      name: "test-session",
      repo: "/test/repo",
      force: true,
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      session: "test-session"
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
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      branch: "update-branch",
      noStash: true,
      noPush: true,
      json: true
    };
    const context = { interface: "test" };
    const result = await updateCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(updateSessionSpy).toHaveBeenCalledWith({
      name: "test-session",
      task: "123",
      repo: "/test/repo",
      branch: "update-branch",
      noStash: true,
      noPush: true,
      json: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      session: "test-session"
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
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true
    };
    const context = { interface: "test" };
    const result = await approveCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(approveSessionSpy).toHaveBeenCalledWith({
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      json: true
    });
    
    // Verify result contains expected fields
    expect(result).toEqual({
      success: true,
      session: "test-session",
      commitHash: expect.any(String),
      mergeDate: expect.any(String),
      mergedBy: expect.any(String),
      baseBranch: expect.any(String),
      prBranch: expect.any(String),
      taskId: expect.any(String)
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
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      noStatusUpdate: true,
      debug: true
    };
    const context = { interface: "test" };
    const result = await prCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(sessionPrSpy).toHaveBeenCalledWith({
      title: "Test PR",
      body: "Test PR body",
      session: "test-session",
      task: "123",
      repo: "/test/repo",
      noStatusUpdate: true,
      debug: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      prBranch: "pr/test-branch",
      baseBranch: "main",
      title: "Test PR",
      body: "Test PR body"
    });
  });
}); 
