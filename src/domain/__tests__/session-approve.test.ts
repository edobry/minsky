import { describe, test, expect } from "bun:test";
import { approveSessionFromParams } from "../session";
import { ResourceNotFoundError, ValidationError } from "../../errors";
import { createMock } from "../../utils/test-utils/mocking";
import * as WorkspaceUtils from "../workspace";

describe("Session Approve", () => {
  test("successfully approves and merges a PR branch", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((_name) =>
        Promise.resolve({
          session: _name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#123",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock((taskId) => {
        if (taskId === "#123") {
          return Promise.resolve({
            session: "test-session",
            repoName: "test-repo",
            repoUrl: "/test/repo/path",
            taskId: "#123",
            createdAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      }),
      getSessionWorkdir: createMock((_sessionName) =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
    };

    const mockGitService = {
      execInRepository: createMock((_workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock((_id, _status) => Promise.resolve()),
      getBackendForTask: createMock((_id) =>
        Promise.resolve({
          setTaskMetadata: createMock((_id, _metadata) => Promise.resolve()),
        })
      ),
    };

    const mockWorkspaceUtils = {
      getCurrentSession: createMock(() => Promise.resolve(null)),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
    };

    // Test by session name
    const resultBySession = await approveSessionFromParams(
      {
        session: "test-session",
      },
      testDeps
    );

    // Verify
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
    // BUG FIX: No longer expect getSessionWorkdir to be called since we use originalRepoPath
    expect(mockGitService.execInRepository.mock.calls.length).toBeGreaterThan(0);
    expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", "DONE");
    expect(resultBySession.commitHash).toBe("abcdef123456");
    expect(resultBySession.session).toBe("test-session");
    expect(resultBySession.taskId).toBe("#123");

    // Clear mocks
    mockSessionDB.getSession.mockClear();
    mockSessionDB.getSessionByTaskId.mockClear();
    mockSessionDB.getSessionWorkdir.mockClear();
    mockGitService.execInRepository.mockClear();
    mockTaskService.setTaskStatus.mockClear();
    mockTaskService.getBackendForTask.mockClear();

    // Test by task ID
    const resultByTask = await approveSessionFromParams(
      {
        task: "#123",
      },
      testDeps
    );

    // Verify
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#123");
    expect(mockGitService.execInRepository.mock.calls.length).toBeGreaterThan(0);
    expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", "DONE");
    expect(resultByTask.taskId).toBe("#123");
  });

  test("detects current session when repo path is provided", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name) => {
        if (name === "current-session") {
          return Promise.resolve({
            session: name,
            repoName: "test-repo",
            repoUrl: "/test/repo/path",
            createdAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      }),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock((sessionName) =>
        Promise.resolve("/test/workdir/test-repo/sessions/current-session")
      ),
    };

    const mockGitService = {
      execInRepository: createMock((workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.resolve()),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create a mock getCurrentSession function that returns a valid session
    const repoPath = "/test/repo/path";
    const mockGetCurrentSession = createMock(() => Promise.resolve("current-session"));

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: WorkspaceUtils,
      getCurrentSession: mockGetCurrentSession,
    };

    // Test auto detection
    const result = await approveSessionFromParams(
      {
        repo: repoPath,
      },
      testDeps
    );

    // Verify
    expect(mockGetCurrentSession).toHaveBeenCalledWith(repoPath);
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("current-session");
    expect(mockGitService.execInRepository.mock.calls.length).toBeGreaterThan(0);
    expect(result.session).toBe("current-session");
  });

  test("throws error when session is not found", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock(() => Promise.resolve(null)),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() => Promise.resolve("")),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: {
        execInRepository: createMock(() => Promise.resolve("")),
      },
      taskService: {
        setTaskStatus: createMock(() => Promise.resolve()),
        getBackendForTask: createMock(() => Promise.resolve({})),
      },
      workspaceUtils: {},
    };

    // Test with non-existent session
    try {
      await approveSessionFromParams(
        {
          session: "non-existent-session",
        },
        testDeps
      );
      // Should not reach this point
      expect(false).toBe(true);
    } catch (___error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain('Session "non-existent-session" not found');
    }
  });

  test("throws error when no session or task is provided", async () => {
    // Create test dependencies with required properties
    const testDeps = {
      sessionDB: {
        getSession: createMock(() => Promise.resolve(null)),
        getSessionByTaskId: createMock(() => Promise.resolve(null)),
        getSessionWorkdir: createMock(() => Promise.resolve("")),
      },
      gitService: {
        execInRepository: createMock(() => Promise.resolve("")),
      },
      taskService: {
        setTaskStatus: createMock(() => Promise.resolve()),
        getBackendForTask: createMock(() => Promise.resolve({})),
      },
      workspaceUtils: {
        getCurrentSession: createMock(() => Promise.resolve(null)),
      },
    };

    // Test with no arguments
    try {
      await approveSessionFromParams(
        {
          repo: "/test/repo/path",
        },
        testDeps
      );
      // Should not reach this point
      expect(false).toBe(true);
    } catch (___error) {
      expect(error instanceof ValidationError).toBe(true);
      expect((error as Error).message).toContain("No session detected");
    }
  });

  test("handles errors during task metadata update", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#123",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
    };

    const mockGitService = {
      execInRepository: createMock((workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.reject(new Error("Task update failed"))),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
    };

    // Should still succeed even if task update fails
    const result = await approveSessionFromParams(
      {
        session: "test-session",
      },
      testDeps
    );

    // Verify
    expect(result.commitHash).toBe("abcdef123456");
    expect(result.session).toBe("test-session");
  });

  test("merges from local PR branch and handles missing remote branch gracefully", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: createMock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#123",
          createdAt: new Date().toISOString(),
        })
      ),
      getSessionByTaskId: createMock(() => Promise.resolve(null)),
      getSessionWorkdir: createMock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      ),
    };

    const gitCommands: string[] = [];
    const mockGitService = {
      execInRepository: createMock((workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate remote branch check failure (branch doesn't exist on remote)
        if (command.includes("show-ref --verify --quiet refs/remotes/origin/pr/test-session")) {
          throw new Error("Command failed: git show-ref");
        }
        return Promise.resolve("");
      }),
    };

    const mockTaskService = {
      setTaskStatus: createMock(() => Promise.resolve()),
      getBackendForTask: createMock(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      ),
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
    };

    // Test the approval
    const result = await approveSessionFromParams(
      {
        session: "test-session",
      },
      testDeps
    );

    // Verify the result
    expect(result.commitHash).toBe("abcdef123456");
    expect(result.session).toBe("test-session");
    expect(result.prBranch).toBe("pr/test-session");

    // Verify git commands were called correctly
    expect(gitCommands).toContain("git checkout main");
    expect(gitCommands).toContain("git fetch origin");
    // CRITICAL: Should merge from LOCAL PR branch, not remote
    expect(gitCommands).toContain("git merge --ff-only pr/test-session");
    // Should NOT contain merge from remote branch
    expect(gitCommands).not.toContain("git merge --ff-only origin/pr/test-session");

    // Should try to push main branch
    expect(gitCommands).toContain("git push origin main");

    // Should try to check for remote branch existence
    expect(gitCommands).toContain(
      "git show-ref --verify --quiet refs/remotes/origin/pr/test-session"
    );

    // Should NOT try to delete remote branch since it doesn't exist
    expect(gitCommands).not.toContain("git push origin --delete pr/test-session");
  });
});
