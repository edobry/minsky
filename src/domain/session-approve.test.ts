import { describe, test, expect } from "bun:test";
import { approveSessionFromParams } from "./session";
import { ResourceNotFoundError, ValidationError } from "../errors/index";
import { createMock, createPartialMock } from "../utils/test-utils/mocking";
import { createMockSessionProvider, createMockGitService, createMockTaskService } from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";

const TEST_VALUE = 123;

describe("Session Approve", () => {
  test("successfully approves and merges a PR branch", async () => {
    // Create trackable spies for methods we need to verify (simplified typing)
    const getSessionSpy = createMock();
    getSessionSpy.mockImplementation((name) =>
      Promise.resolve({
        session: name, // Fixed: use 'session' instead of '_session' 
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "#TEST_VALUE",
        createdAt: new Date().toISOString(),
      })
    );

    const getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy.mockImplementation((taskId) => {
      if (taskId === "#TEST_VALUE") {
        return Promise.resolve({
          session: "test-session", // Fixed: use 'session' instead of '_session'
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#TEST_VALUE",
          createdAt: new Date().toISOString(),
        });
      }
      return Promise.resolve(null);
    });

    const getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy.mockImplementation(() =>
      Promise.resolve("/test/workdir/test-repo/sessions/test-session")
    );

    const execInRepositorySpy = createMock();
    execInRepositorySpy.mockImplementation((_workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abcdef123456");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("Test User");
      }
      return Promise.resolve("");
    });

    const setTaskStatusSpy = createMock();
    setTaskStatusSpy.mockImplementation(() => Promise.resolve());

    const getBackendForTaskSpy = createMock();
    getBackendForTaskSpy.mockImplementation(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy,
      getSessionByTaskId: getSessionByTaskIdSpy,
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy,
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: setTaskStatusSpy,
      getBackendForTask: getBackendForTaskSpy,
    });

    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isWorkspace: () => Promise.resolve(true),
      isSessionWorkspace: () => false,
      getCurrentSession: () => Promise.resolve(undefined),
      getSessionFromWorkspace: () => Promise.resolve(undefined),
      resolveWorkspacePath: () => Promise.resolve("/mock/workspace"),
    });

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
        session: "test-session", // Fixed: use 'session' instead of '_session'
      },
      testDeps
    );

    // Verify calls with individual spies
    expect(getSessionSpy).toHaveBeenCalledWith("test-session");
    // BUG FIX: No longer expect getSessionWorkdir to be called since we use originalRepoPath
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);
    expect(setTaskStatusSpy).toHaveBeenCalledWith("#TEST_VALUE", "DONE");
    expect(resultBySession.commitHash).toBe("abcdef123456");
    expect(resultBySession.session).toBe("test-session"); // Fixed: expect 'session' property
    expect(resultBySession.taskId).toBe("#TEST_VALUE");

    // Test by task ID (reusing the same mocks, no .mockClear() needed with fresh spies)
    const resultByTask = await approveSessionFromParams(
      {
        task: "#TEST_VALUE",
      },
      testDeps
    );

    // Verify task ID path
    expect(getSessionByTaskIdSpy).toHaveBeenCalledWith("#TEST_VALUE");
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);
    expect(setTaskStatusSpy).toHaveBeenCalledWith("#TEST_VALUE", "DONE");
    expect(resultByTask.taskId).toBe("#TEST_VALUE");
  });

  test("detects current session when repo path is provided", async () => {
    // Create trackable spies for methods we need to verify
    const getSessionSpy = createMock();
    getSessionSpy.mockImplementation((name) => {
      if (name === "current-session") {
        return Promise.resolve({
          session: name, // Fixed: use 'session' instead of '_session'
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          createdAt: new Date().toISOString(),
        });
      }
      return Promise.resolve(null);
    });

    const getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

    const getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy.mockImplementation((_sessionName) =>
      Promise.resolve("/test/workdir/test-repo/sessions/current-session")
    );

    const execInRepositorySpy = createMock();
    execInRepositorySpy.mockImplementation((_workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abcdef123456");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("Test User");
      }
      return Promise.resolve("");
    });

    const setTaskStatusSpy = createMock();
    setTaskStatusSpy.mockImplementation(() => Promise.resolve());

    const getBackendForTaskSpy = createMock();
    getBackendForTaskSpy.mockImplementation(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy,
      getSessionByTaskId: getSessionByTaskIdSpy,
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy,
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: setTaskStatusSpy,
      getBackendForTask: getBackendForTaskSpy,
    });

    // Create a mock getCurrentSession function that returns a valid session
    const repoPath = "/test/repo/path";
    const mockGetCurrentSession = createMock(() => Promise.resolve("current-session"));

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {},
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
    expect(getSessionSpy).toHaveBeenCalledWith("current-session");
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);
    expect(result.session).toBe("current-session");
  });

  test("throws error when session is not found", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      getSessionByTaskId: () => Promise.resolve(null),
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = createMock(() => Promise.resolve(""));

    const mockGitService = createMockGitService({
      execInRepository: () => Promise.resolve(""),
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.resolve(),
      getBackendForTask: () => Promise.resolve({}),
    });

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
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
    } catch (error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain("Session \"non-existent-session\" not found");
    }
  });

  test("throws error when no session or task is provided", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      getSessionByTaskId: () => Promise.resolve(null),
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = createMock(() => Promise.resolve(""));

    const mockGitService = createMockGitService({
      execInRepository: () => Promise.resolve(""),
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.resolve(),
      getBackendForTask: () => Promise.resolve({}),
    });

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
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
    } catch (error) {
      expect(error instanceof ValidationError).toBe(true);
      expect((error as Error).message).toContain("No session detected");
    }
  });

  test("handles errors during task metadata update", async () => {
    // Create centralized mocks
    const mockSessionDB = createMockSessionProvider({
      getSession: (name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#TEST_VALUE",
          createdAt: new Date().toISOString(),
        }),
      getSessionByTaskId: () => Promise.resolve(null),
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = createMock(() =>
      Promise.resolve("/test/workdir/test-repo/sessions/test-session")
    );

    const mockGitService = createMockGitService({
      execInRepository: (_workdir, command) => {
        if (typeof command === "string") {
          if (command.includes("rev-parse HEAD")) {
            return Promise.resolve("abcdef123456");
          }
          if (command.includes("config user.name")) {
            return Promise.resolve("Test User");
          }
        }
        return Promise.resolve("");
      },
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.reject(new Error("Task update failed")),
    });

    // Add getBackendForTask method not covered by centralized factory
    (mockTaskService as any).getBackendForTask = createMock(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

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
    // Create trackable spies for methods we need to verify
    const getSessionSpy = createMock();
    getSessionSpy.mockImplementation((name) =>
      Promise.resolve({
        session: name, // Fixed: use 'session' instead of '_session'
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "#TEST_VALUE",
        createdAt: new Date().toISOString(),
      })
    );

    const getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

    const getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy.mockImplementation(() =>
      Promise.resolve("/test/workdir/test-repo/sessions/test-session")
    );

    const gitCommands: string[] = [];
    const execInRepositorySpy = createMock();
    execInRepositorySpy.mockImplementation((_workdir, command) => {
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
    });

    const setTaskStatusSpy = createMock();
    setTaskStatusSpy.mockImplementation(() => Promise.resolve());

    const getBackendForTaskSpy = createMock();
    getBackendForTaskSpy.mockImplementation(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy,
      getSessionByTaskId: getSessionByTaskIdSpy,
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy,
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: setTaskStatusSpy,
      getBackendForTask: getBackendForTaskSpy,
    });

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
      "git show-ref --verify --quiet refs/heads/pr/test-session"
    );

    // Should NOT try to delete remote branch since it doesn't exist
    expect(gitCommands).not.toContain("git push origin --delete pr/test-session");
  });

  // Bug: Missing branch cleanup after successful merge
  // Current implementation doesn't clean up local branches after merge
  // Expected behavior: Delete both local PR branch and task branch after successful merge
  describe("branch cleanup after successful merge", () => {
    test("should delete local PR branch and task branch after successful merge", async () => {
      // Create trackable spies for methods we need to verify
      const getSessionSpy = createMock();
      getSessionSpy.mockImplementation((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      );

      const getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

      const getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy.mockImplementation(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      const execInRepositorySpy = createMock();
      execInRepositorySpy.mockImplementation((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate successful branch operations
        return Promise.resolve("");
      });

      const setTaskStatusSpy = createMock();
      setTaskStatusSpy.mockImplementation(() => Promise.resolve());

      const getBackendForTaskSpy = createMock();
      getBackendForTaskSpy.mockImplementation(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      );

      // Create mocks using centralized factories with spy integration
      const mockSessionDB = createMockSessionProvider({
        getSession: getSessionSpy,
        getSessionByTaskId: getSessionByTaskIdSpy,
      });

      // Add getSessionWorkdir method not covered by centralized factory
      (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

      const mockGitService = createMockGitService({
        execInRepository: execInRepositorySpy,
      });

      const mockTaskService = createMockTaskService({
        setTaskStatus: setTaskStatusSpy,
        getBackendForTask: getBackendForTaskSpy,
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
      };

      // Test the approval with newly approved session
      const result = await approveSessionFromParams(
        {
          session: "task#265",
        },
        testDeps
      );

      // Verify the merge was successful
      expect(result.commitHash).toBe("abcdef123456");
      expect(result.session).toBe("task#265");
      expect(result.isNewlyApproved).toBe(true);

      // BUG: These branch cleanup commands should be called but currently aren't
      // Should delete the local PR branch after successful merge
      expect(gitCommands).toContain("git branch -d pr/task#265");

      // Should delete the local task branch if it exists
      expect(gitCommands).toContain("git branch -d task#265");
    });

    test("should handle branch cleanup failures gracefully without failing the operation", async () => {
      // Create trackable spies for methods we need to verify
      const getSessionSpy = createMock();
      getSessionSpy.mockImplementation((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      );

      const getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

      const getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy.mockImplementation(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      const execInRepositorySpy = createMock();
      execInRepositorySpy.mockImplementation((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate branch deletion failures
        if (command.includes("branch -d")) {
          throw new Error("branch deletion failed - branch not found or has unmerged changes");
        }
        return Promise.resolve("");
      });

      const setTaskStatusSpy = createMock();
      setTaskStatusSpy.mockImplementation(() => Promise.resolve());

      const getBackendForTaskSpy = createMock();
      getBackendForTaskSpy.mockImplementation(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      );

      // Create mocks using centralized factories with spy integration
      const mockSessionDB = createMockSessionProvider({
        getSession: getSessionSpy,
        getSessionByTaskId: getSessionByTaskIdSpy,
      });

      // Add getSessionWorkdir method not covered by centralized factory
      (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

      const mockGitService = createMockGitService({
        execInRepository: execInRepositorySpy,
      });

      const mockTaskService = createMockTaskService({
        setTaskStatus: setTaskStatusSpy,
        getBackendForTask: getBackendForTaskSpy,
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
      };

      // Test the approval - should not fail even if branch cleanup fails
      const result = await approveSessionFromParams(
        {
          session: "task#265",
        },
        testDeps
      );

      // Verify the merge was still successful despite cleanup failures
      expect(result.commitHash).toBe("abcdef123456");
      expect(result.session).toBe("task#265");
      expect(result.isNewlyApproved).toBe(true);

      // Verify cleanup was attempted
      expect(gitCommands).toContain("git branch -d pr/task#265");
      expect(gitCommands).toContain("git branch -d task#265");
    });

    test("should not attempt branch cleanup for already approved sessions", async () => {
      // Create trackable spies for methods we need to verify
      const getSessionSpy = createMock();
      getSessionSpy.mockImplementation((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      );

      const getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

      const getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy.mockImplementation(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      const execInRepositorySpy = createMock();
      execInRepositorySpy.mockImplementation((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate that PR branch doesn't exist (already cleaned up)
        if (command.includes("show-ref --verify --quiet refs/heads/pr/task#265")) {
          throw new Error("branch doesn't exist");
        }
        // Simulate merge-base check shows branch is already merged
        if (command.includes("merge-base --is-ancestor")) {
          return Promise.resolve("");  // Success means it's already merged
        }
        return Promise.resolve("");
      });

      const setTaskStatusSpy = createMock();
      setTaskStatusSpy.mockImplementation(() => Promise.resolve());

      const getBackendForTaskSpy = createMock();
      getBackendForTaskSpy.mockImplementation(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      );

      // Create mocks using centralized factories with spy integration
      const mockSessionDB = createMockSessionProvider({
        getSession: getSessionSpy,
        getSessionByTaskId: getSessionByTaskIdSpy,
      });

      // Add getSessionWorkdir method not covered by centralized factory
      (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

      const mockGitService = createMockGitService({
        execInRepository: execInRepositorySpy,
      });

      const mockTaskService = createMockTaskService({
        setTaskStatus: setTaskStatusSpy,
        getBackendForTask: getBackendForTaskSpy,
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
      };

      // Test the approval of already approved session
      const result = await approveSessionFromParams(
        {
          session: "task#265",
        },
        testDeps
      );

      // Verify this was detected as already approved
      expect(result.session).toBe("task#265");
      expect(result.isNewlyApproved).toBe(false);

      // Should NOT attempt branch cleanup for already approved sessions
      expect(gitCommands).not.toContain("git branch -d pr/task#265");
      expect(gitCommands).not.toContain("git branch -d task#265");
    });

    test("should handle case where task branch doesn't exist but PR branch does", async () => {
      // Create trackable spies for methods we need to verify
      const getSessionSpy = createMock();
      getSessionSpy.mockImplementation((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "#265",
          createdAt: new Date().toISOString(),
        })
      );

      const getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy.mockImplementation(() => Promise.resolve(null));

      const getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy.mockImplementation(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      const execInRepositorySpy = createMock();
      execInRepositorySpy.mockImplementation((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        // Simulate that task branch doesn't exist but PR branch cleanup succeeds
        if (command.includes("branch -d task#265")) {
          throw new Error("branch 'task#265' not found");
        }
        return Promise.resolve("");
      });

      const setTaskStatusSpy = createMock();
      setTaskStatusSpy.mockImplementation(() => Promise.resolve());

      const getBackendForTaskSpy = createMock();
      getBackendForTaskSpy.mockImplementation(() =>
        Promise.resolve({
          setTaskMetadata: createMock(() => Promise.resolve()),
        })
      );

      // Create mocks using centralized factories with spy integration
      const mockSessionDB = createMockSessionProvider({
        getSession: getSessionSpy,
        getSessionByTaskId: getSessionByTaskIdSpy,
      });

      // Add getSessionWorkdir method not covered by centralized factory
      (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

      const mockGitService = createMockGitService({
        execInRepository: execInRepositorySpy,
      });

      const mockTaskService = createMockTaskService({
        setTaskStatus: setTaskStatusSpy,
        getBackendForTask: getBackendForTaskSpy,
      });

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
          session: "task#265",
        },
        testDeps
      );

      // Verify the merge was successful
      expect(result.commitHash).toBe("abcdef123456");
      expect(result.session).toBe("task#265");
      expect(result.isNewlyApproved).toBe(true);

      // Should attempt to clean up both branches, even if one fails
      expect(gitCommands).toContain("git branch -d pr/task#265");
      expect(gitCommands).toContain("git branch -d task#265");
    });
  });
});
