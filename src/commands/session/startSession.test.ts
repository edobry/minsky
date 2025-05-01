// bun:test does not support mocking dependencies like vitest.
// For full business logic testing, refactor startSession for dependency injection or use a compatible test runner.
import { describe, it, expect, mock } from "bun:test";
import { startSession, StartSessionOptions, StartSessionResult } from "./startSession";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";
import { TaskService } from "../../domain/tasks";
import { resolveRepoPath } from "../../domain/repo-utils";
import { join } from "path";

describe("startSession", () => {
  const TEST_GIT_DIR = "/tmp/minsky-test/minsky/git";

  it("creates a session with explicit repo", async () => {
    // Mock dependencies
    const originalSessionDB = SessionDB;
    const originalGitService = GitService;
    const originalTaskService = TaskService;
    
    // Mock SessionDB
    const mockGetSession = mock(() => Promise.resolve(undefined));
    const mockAddSession = mock(() => Promise.resolve());
    const mockGetSessionByTaskId = mock(() => Promise.resolve(undefined));
    
    mock.module("../../domain/session", () => ({
      SessionDB: class {
        getSession = mockGetSession;
        addSession = mockAddSession;
        getSessionByTaskId = mockGetSessionByTaskId;
      }
    }));
    
    // Mock GitService
    const mockClone = mock(() => Promise.resolve("/path/to/repo"));
    mock.module("../../domain/git", () => ({
      GitService: class {
        clone = mockClone;
      }
    }));

    // Mock TaskService
    const mockGetTask = mock(() => Promise.resolve({ id: "#123", title: "Test Task" }));
    mock.module("../../domain/tasks", () => ({
      TaskService: class {
        getTask = mockGetTask;
      }
    }));
    
    // Import the startSession function after mocking
    const { startSession } = await import("./startSession");
    
    try {
    const result = await startSession({
        repo: "https://github.com/org/repo",
        session: "test-session"
      });
    
      expect(result).toBe("/path/to/repo");
    } finally {
      // Clean up mocks if needed
    }
  });

  it("throws if session already exists", async () => {
    // Mock SessionDB to return an existing session
    mock.module("../../domain/session", () => ({
      SessionDB: class {
        getSession = mock(() => Promise.resolve({
          session: "test-session",
          repoUrl: "https://github.com/org/repo",
          repoName: "org/repo",
          createdAt: "2024-01-01"
        }));
        getSessionByTaskId = mock(() => Promise.resolve(undefined));
      }
    }));
    
    // Import the startSession function after mocking
    const { startSession } = await import("./startSession");

    await expect(startSession({
      repo: "https://github.com/org/repo",
      session: "test-session"
    })).rejects.toThrow("Session 'test-session' already exists");
  });

  it("converts local path to file:// URL", async () => {
    const result = await startSession({
      repo: "/local/path/to/repo",
      session: "test-session"
    });

    expect(result).toBe("/path/to/repo");
    const mockClone = (global as any).GitService.prototype.clone;
    expect(mockClone).toHaveBeenCalledWith({
      repoUrl: "file:///local/path/to/repo",
      session: "test-session",
      branch: undefined,
      taskId: undefined
    });
  });

  it("uses resolveRepoPath when no repo is provided", async () => {
    const result = await startSession({
      session: "test-session"
    });

    expect(result).toBe("/path/to/repo");
    const mockClone = (global as any).GitService.prototype.clone;
    expect(mockClone).toHaveBeenCalledWith({
      repoUrl: expect.stringContaining("file://"),
      session: "test-session",
      branch: undefined,
      taskId: undefined
    });
  });

  it("throws if resolveRepoPath fails and no repo is provided", async () => {
    // Mock GitService to throw an error
    (global as any).GitService = class {
      clone = mock(() => Promise.reject(new Error("Not in a git repository")));
    };
    
    await expect(startSession({
      session: "test-session"
    })).rejects.toThrow("Not in a git repository");
  });

  it("creates a session with task ID", async () => {
    const result = await startSession({
      repo: "https://github.com/org/repo",
      session: "test-session",
      taskId: "#123"
    });

    expect(result).toBe("/path/to/repo");
    const mockClone = (global as any).GitService.prototype.clone;
    expect(mockClone).toHaveBeenCalledWith({
      repoUrl: "https://github.com/org/repo",
      session: "test-session",
      branch: undefined,
      taskId: "#123"
    });
  });

  it("creates a session with just taskId", async () => {
    const result = await startSession({
      repo: "https://github.com/org/repo",
      taskId: "#123"
    });
    
    expect(result).toBe("/path/to/repo");
    const mockClone = (global as any).GitService.prototype.clone;
    expect(mockClone).toHaveBeenCalledWith({
      repoUrl: "https://github.com/org/repo",
      session: expect.stringMatching(/^session-[a-z0-9]{6}$/),
      branch: undefined,
      taskId: "#123"
    });
  });

  it("throws if a session for the task already exists", async () => {
    // Mock SessionDB to return an existing session for the task
    (global as any).SessionDB = class {
      getSessionByTaskId = mock(() => Promise.resolve({
        session: "existing-session",
        repoUrl: "https://github.com/org/repo",
        repoName: "org/repo",
        createdAt: "2024-01-01",
        taskId: "#123"
      }));
    };

    await expect(startSession({
      repo: "https://github.com/org/repo",
      taskId: "#123"
    })).rejects.toThrow("A session for task '#123' already exists: existing-session");
  });

  it("adds session to database before clone and branch operations", async () => {
    const mockAddSession = mock(() => Promise.resolve());
    (global as any).SessionDB = class {
      getSession = mock(() => Promise.resolve(undefined));
      addSession = mockAddSession;
    };

    const result = await startSession({
      repo: "https://github.com/org/repo",
      session: "test-session"
    });

    expect(result).toBe("/path/to/repo");
    expect(mockAddSession).toHaveBeenCalledWith({
      session: "test-session",
      repoUrl: "https://github.com/org/repo",
      repoName: "github.com/org/repo",
      createdAt: expect.any(String),
      branch: undefined,
      taskId: undefined
    });
  });
}); 
