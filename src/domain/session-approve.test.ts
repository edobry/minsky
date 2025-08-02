import { describe, test, expect, mock } from "bun:test";
import { approveSessionFromParams } from "./session";
import { ResourceNotFoundError, ValidationError } from "../errors/index";
import { createMock, createPartialMock } from "../utils/test-utils/mocking";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";

// Mock logger
const mockLog = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  cli: mock(() => {}),
};

mock.module("../utils/logger", () => ({
  log: mockLog,
}));

const TEST_VALUE = 123;

describe("Session Approve", () => {
  test("simple approval test with working mock", async () => {
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          prBranch: "pr/test-branch",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Verify mock works
    const session = await mockSessionDB.getSession("test-session");
    expect(session).not.toBeNull();

    // Now test with minimal deps
    const mockGitService = createMockGitService({
      execInRepository: () => Promise.resolve("abcdef123456"),
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.resolve(),
      getBackendForTask: () => Promise.resolve({ setTaskMetadata: () => Promise.resolve() }),
      getTask: () =>
        Promise.resolve({
          id: "265",
          title: "Test",
          status: "TODO",
          createdAt: new Date().toISOString(),
        }),
    });

    const simpleDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        getRepoWorkspace: () => "/test/workdir",
        getCurrentWorkingDirectory: () => "/test/workdir",
      }),
      resolveRepoPath: () => Promise.resolve("/test/repo"),
      createRepositoryBackendForSession: () =>
        Promise.resolve({
          getType: () => "test-backend",
          approvePullRequest: () =>
            Promise.resolve({
              reviewId: "test-review-123",
              approvedBy: "test-user",
              approvedAt: new Date().toISOString(),
              prNumber: "123",
            }),
        }),
    };

    // This should work since we know the mock has the right session
    try {
      const result = await approveSessionFromParams({ session: "test-session" }, simpleDeps);
      expect(result.sessionName).toBe("test-session");
    } catch (error) {
      console.log("Error details:", error);
      throw error;
    }
  });

  test("successfully approves and merges a PR branch", async () => {
    // Create trackable spies for methods we need to verify (simplified typing)
    let getSessionSpy = createMock();
    getSessionSpy = mock((name) =>
      Promise.resolve({
        session: name, // Fixed: use 'session' instead of '_session'
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "265",
        prBranch: "pr/test-branch",
        createdAt: new Date().toISOString(),
      })
    );

    let getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy = mock((taskId) => {
      if (taskId === "265") {
        return Promise.resolve({
          session: "test-session", // Fixed: use 'session' instead of '_session'
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          prBranch: "pr/test-branch",
          createdAt: new Date().toISOString(),
        });
      }
      return Promise.resolve(null);
    });

    let getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy = mock(() =>
      Promise.resolve("/test/workdir/test-repo/sessions/test-session")
    );

    let execInRepositorySpy = createMock();
    execInRepositorySpy = mock((_workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abcdef123456");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("Test User");
      }
      return Promise.resolve("");
    });

    let setTaskStatusSpy = createMock();
    setTaskStatusSpy = mock(() => Promise.resolve());

    let getBackendForTaskSpy = createMock();
    getBackendForTaskSpy = mock(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          prBranch: "pr/test-branch",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy,
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: setTaskStatusSpy,
      getBackendForTask: getBackendForTaskSpy,
      getTask: () =>
        Promise.resolve({
          id: "265",
          title: "Test Task",
          status: "IN-PROGRESS",
        }),
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
      createRepositoryBackend: createMock((sessionRecord: any) =>
        Promise.resolve({
          getType: () => "local",
          mergePullRequest: createMock(() =>
            Promise.resolve({
              commitHash: "abcdef123456",
              mergeDate: new Date(),
              mergedBy: "test-user",
            })
          ),
        })
      ),
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
    expect(setTaskStatusSpy).toHaveBeenCalledWith("265", "DONE");
    expect(resultBySession.commitHash).toBe("abcdef123456");
    expect(resultBySession.session).toBe("test-session"); // Fixed: expect 'session' property
    expect(resultBySession.taskId).toBe("265");

    // Test by task ID (reusing the same mocks, no .mockClear() needed with fresh spies)
    const resultByTask = await approveSessionFromParams(
      {
        task: "265",
      },
      testDeps
    );

    // Verify task ID path
    expect(getSessionByTaskIdSpy).toHaveBeenCalledWith("265");
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);
    expect(setTaskStatusSpy).toHaveBeenCalledWith("265", "DONE");
    expect(resultByTask.taskId).toBe("265");
  });

  test("detects current session when repo path is provided", async () => {
    // Create trackable spies for methods we need to verify
    let getSessionSpy = createMock();
    getSessionSpy = mock((name) => {
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

    let getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

    let getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy = mock((_sessionName) =>
      Promise.resolve("/test/workdir/test-repo/sessions/current-session")
    );

    let execInRepositorySpy = createMock();
    execInRepositorySpy = mock((_workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abcdef123456");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("Test User");
      }
      return Promise.resolve("");
    });

    let setTaskStatusSpy = createMock();
    setTaskStatusSpy = mock(() => Promise.resolve());

    let getBackendForTaskSpy = createMock();
    getBackendForTaskSpy = mock(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          prBranch: "pr/test-branch",
          createdAt: new Date().toISOString(),
        },
      ],
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
      createRepositoryBackend: createMock((sessionRecord: any) =>
        Promise.resolve({
          getType: () => "local",
          mergePullRequest: createMock(() =>
            Promise.resolve({
              commitHash: "abcdef123456",
              mergeDate: new Date(),
              mergedBy: "test-user",
            })
          ),
        })
      ),
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
    // Note: With repository backend architecture, git commands are handled by the backend, not directly
    expect(result.session).toBe("current-session");
    expect(result.commitHash).toBe("abcdef123456"); // Verify merge was successful
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
      expect((error as Error).message).toContain('Session "non-existent-session" not found');
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
          taskId: "265",
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
      createRepositoryBackend: createMock((sessionRecord: any) =>
        Promise.resolve({
          getType: () => "local",
          mergePullRequest: createMock(() =>
            Promise.resolve({
              commitHash: "abcdef123456",
              mergeDate: new Date(),
              mergedBy: "test-user",
            })
          ),
        })
      ),
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
    let getSessionSpy = createMock();
    getSessionSpy = mock((name) =>
      Promise.resolve({
        session: name, // Fixed: use 'session' instead of '_session'
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "265",
        createdAt: new Date().toISOString(),
      })
    );

    let getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

    let getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy = mock(() =>
      Promise.resolve("/test/workdir/test-repo/sessions/test-session")
    );

    const gitCommands: string[] = [];
    let execInRepositorySpy = createMock();
    execInRepositorySpy = mock((_workdir, command) => {
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

    let setTaskStatusSpy = createMock();
    setTaskStatusSpy = mock(() => Promise.resolve());

    let getBackendForTaskSpy = createMock();
    getBackendForTaskSpy = mock(() =>
      Promise.resolve({
        setTaskMetadata: createMock(() => Promise.resolve()),
      })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          prBranch: "pr/test-branch",
          createdAt: new Date().toISOString(),
        },
      ],
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
      createRepositoryBackend: createMock((sessionRecord: any) =>
        Promise.resolve({
          getType: () => "local",
          mergePullRequest: createMock(() =>
            Promise.resolve({
              commitHash: "abcdef123456",
              mergeDate: new Date(),
              mergedBy: "test-user",
            })
          ),
        })
      ),
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

    // With repository backend architecture, merge is handled by repositoryBackend.mergePullRequest()
    // and individual git commands are not directly called from session approval logic.
    // Instead, verify that branch cleanup was executed after successful merge.

    // Verify branch cleanup was attempted (this is the main behavior we care about)
    expect(gitCommands).toContain("git branch -d pr/test-session");

    // Should check what branches exist for cleanup
    expect(gitCommands).toContain('git branch --format="%(refname:short)"');
  });

  // Bug: Missing branch cleanup after successful merge
  // Current implementation doesn't clean up local branches after merge
  // Expected behavior: Delete both local PR branch and task branch after successful merge
  describe("branch cleanup after successful merge", () => {
    test("should delete local PR branch and task branch after successful merge", async () => {
      // Create trackable spies for methods we need to verify
      let getSessionSpy = createMock();
      getSessionSpy = mock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          createdAt: new Date().toISOString(),
        })
      );

      let getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

      let getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy = mock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      let execInRepositorySpy = createMock();
      execInRepositorySpy = mock((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes('git branch --format="%(refname:short)"')) {
          // Return task branch so cleanup logic can find and attempt to delete it
          return Promise.resolve("265\ntask#265\nmain\nother-branch");
        }
        // Simulate branch deletion failures
        if (command.includes("branch -d")) {
          throw new Error("branch deletion failed - branch not found or has unmerged changes");
        }
        return Promise.resolve("");
      });

      let setTaskStatusSpy = createMock();
      setTaskStatusSpy = mock(() => Promise.resolve());

      let getBackendForTaskSpy = createMock();
      getBackendForTaskSpy = mock(() =>
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
        getTask: () =>
          Promise.resolve({
            id: "265",
            title: "Test Task",
            status: "IN-PROGRESS",
          }),
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
        createRepositoryBackend: createMock((sessionRecord: any) =>
          Promise.resolve({
            getType: () => "local",
            mergePullRequest: createMock(() =>
              Promise.resolve({
                commitHash: "abcdef123456",
                mergeDate: new Date(),
                mergedBy: "test-user",
              })
            ),
          })
        ),
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
      let getSessionSpy = createMock();
      getSessionSpy = mock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          createdAt: new Date().toISOString(),
        })
      );

      let getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

      let getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy = mock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      let execInRepositorySpy = createMock();
      execInRepositorySpy = mock((_workdir, command) => {
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

      let setTaskStatusSpy = createMock();
      setTaskStatusSpy = mock(() => Promise.resolve());

      let getBackendForTaskSpy = createMock();
      getBackendForTaskSpy = mock(() =>
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
        getTask: () =>
          Promise.resolve({
            id: "265",
            title: "Test Task",
            status: "IN-PROGRESS",
          }),
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
        createRepositoryBackend: createMock((sessionRecord: any) =>
          Promise.resolve({
            getType: () => "local",
            mergePullRequest: createMock(() =>
              Promise.resolve({
                commitHash: "abcdef123456",
                mergeDate: new Date(),
                mergedBy: "test-user",
              })
            ),
          })
        ),
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
      // Note: Only PR branch is deleted, not the task branch
    });

    test("should not attempt branch cleanup for already approved sessions", async () => {
      // Create trackable spies for methods we need to verify
      let getSessionSpy = createMock();
      getSessionSpy = mock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          createdAt: new Date().toISOString(),
        })
      );

      let getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

      let getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy = mock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      let execInRepositorySpy = createMock();
      execInRepositorySpy = mock((_workdir, command) => {
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
          return Promise.resolve(""); // Success means it's already merged
        }
        return Promise.resolve("");
      });

      let setTaskStatusSpy = createMock();
      setTaskStatusSpy = mock(() => Promise.resolve());

      let getBackendForTaskSpy = createMock();
      getBackendForTaskSpy = mock(() =>
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
        getTaskStatus: createMock(() => Promise.resolve("DONE")), // Task is already completed
        getBackendForTask: getBackendForTaskSpy,
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
        createRepositoryBackend: createMock((sessionRecord: any) =>
          Promise.resolve({
            getType: () => "local",
            mergePullRequest: createMock(() =>
              Promise.resolve({
                commitHash: "abcdef123456",
                mergeDate: new Date(),
                mergedBy: "test-user",
              })
            ),
          })
        ),
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
      let getSessionSpy = createMock();
      getSessionSpy = mock((name) =>
        Promise.resolve({
          session: name,
          repoName: "test-repo",
          repoUrl: "/test/repo/path",
          taskId: "265",
          createdAt: new Date().toISOString(),
        })
      );

      let getSessionByTaskIdSpy = createMock();
      getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

      let getSessionWorkdirSpy = createMock();
      getSessionWorkdirSpy = mock(() =>
        Promise.resolve("/test/workdir/test-repo/sessions/test-session")
      );

      const gitCommands: string[] = [];
      let execInRepositorySpy = createMock();
      execInRepositorySpy = mock((_workdir, command) => {
        gitCommands.push(command);

        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        if (command.includes('git branch --format="%(refname:short)"')) {
          // Return task branch so cleanup logic can find and attempt to delete it
          return Promise.resolve("task#265\nmain\nother-branch");
        }
        // Simulate that task branch doesn't exist but PR branch cleanup succeeds
        if (command.includes("branch -d task#265")) {
          throw new Error("branch 'task#265' not found");
        }
        return Promise.resolve("");
      });

      let setTaskStatusSpy = createMock();
      setTaskStatusSpy = mock(() => Promise.resolve());

      let getBackendForTaskSpy = createMock();
      getBackendForTaskSpy = mock(() =>
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
        getTask: () =>
          Promise.resolve({
            id: "265",
            title: "Test Task",
            status: "IN-PROGRESS",
          }),
      });

      // Create test dependencies
      const testDeps = {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: {},
        createRepositoryBackend: createMock((sessionRecord: any) =>
          Promise.resolve({
            getType: () => "local",
            mergePullRequest: createMock(() =>
              Promise.resolve({
                commitHash: "abcdef123456",
                mergeDate: new Date(),
                mergedBy: "test-user",
              })
            ),
          })
        ),
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
