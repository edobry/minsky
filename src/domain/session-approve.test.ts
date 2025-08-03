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
// Remove global module mock - use dependency injection instead

const TEST_VALUE = 123;

// Test constants to avoid magic strings
const TEST_SESSION_NAME = "test-session";
const TEST_TASK_ID = "265";
const TEST_REPO_NAME = "test-repo";
const TEST_REPO_PATH = "/test/repo/path";
const TEST_WORKDIR = "/test/workdir";
const TEST_BACKEND_TYPE = "test-backend";
const TEST_USER_NAME = "test-user";
const TEST_COMMIT_HASH = "abcdef123456";
const TEST_TASK_TITLE = "Test";
const TEST_TASK_STATUS = "TODO";

// Derived constants to eliminate duplication
const TEST_PR_BRANCH = `pr/${TEST_SESSION_NAME}`;
const TEST_REVIEW_ID = `test-review-${TEST_TASK_ID}`;
const TEST_PR_NUMBER = TEST_TASK_ID;

describe("Session Approve", () => {
  test("simple approval test with working mock", async () => {
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Verify mock works
    const session = await mockSessionDB.getSession(TEST_SESSION_NAME);
    expect(session).not.toBeNull();

    // Now test with minimal deps
    const mockGitService = createMockGitService({
      execInRepository: () => Promise.resolve(TEST_COMMIT_HASH),
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.resolve(),
      getBackendForTask: () => Promise.resolve({ setTaskMetadata: () => Promise.resolve() }),
      getTask: () =>
        Promise.resolve({
          id: TEST_TASK_ID,
          title: TEST_TASK_TITLE,
          status: TEST_TASK_STATUS,
          createdAt: new Date().toISOString(),
        }),
    });

    const simpleDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        getRepoWorkspace: () => TEST_WORKDIR,
        getCurrentWorkingDirectory: () => TEST_WORKDIR,
      }),
      resolveRepoPath: () => Promise.resolve(TEST_REPO_PATH),
      createRepositoryBackendForSession: () =>
        Promise.resolve({
          getType: () => TEST_BACKEND_TYPE,
          approvePullRequest: () =>
            Promise.resolve({
              reviewId: TEST_REVIEW_ID,
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: TEST_PR_NUMBER,
            }),
        }),
    };

    // This should work since we know the mock has the right session
    try {
      const result = await approveSessionFromParams({ session: TEST_SESSION_NAME }, simpleDeps);
      expect(result.sessionName).toBe(TEST_SESSION_NAME);
    } catch (error) {
      console.log("Error details:", error);
      throw error;
    }
  });

  test("successfully approves and merges a PR branch", async () => {
    // Clean DI approach - just mock data and verify results
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const mockGitService = createMockGitService({
      execInRepository: () => Promise.resolve(TEST_COMMIT_HASH),
    });

    const mockTaskService = createMockTaskService({
      setTaskStatus: () => Promise.resolve(),
      getBackendForTask: () => Promise.resolve({ setTaskMetadata: () => Promise.resolve() }),
      getTask: () =>
        Promise.resolve({
          id: TEST_TASK_ID,
          title: TEST_TASK_TITLE,
          status: TEST_TASK_STATUS,
          createdAt: new Date().toISOString(),
        }),
    });

    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        getRepoWorkspace: () => TEST_WORKDIR,
        getCurrentWorkingDirectory: () => TEST_WORKDIR,
      }),
      resolveRepoPath: () => Promise.resolve(TEST_REPO_PATH),
      createRepositoryBackendForSession: () =>
        Promise.resolve({
          getType: () => TEST_BACKEND_TYPE,
          approvePullRequest: () =>
            Promise.resolve({
              reviewId: TEST_REVIEW_ID,
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: TEST_PR_NUMBER,
            }),
        }),
    };

    // Test by session name
    const resultBySession = await approveSessionFromParams(
      { session: TEST_SESSION_NAME },
      testDeps
    );
    expect(resultBySession.sessionName).toBe(TEST_SESSION_NAME);
    expect(resultBySession.taskId).toBe(TEST_TASK_ID);

    // Test by task ID
    const resultByTask = await approveSessionFromParams({ task: TEST_TASK_ID }, testDeps);
    expect(resultByTask.sessionName).toBe(TEST_SESSION_NAME);
    expect(resultByTask.taskId).toBe(TEST_TASK_ID);
  });

  test("detects current session when repo path is provided", async () => {
    // Clean DI approach - mock a detectable session
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: "current-session",
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: "456",
          prBranch: "pr/current-session",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: createMockGitService({
        execInRepository: () => Promise.resolve(TEST_COMMIT_HASH),
      }),
      taskService: createMockTaskService({
        setTaskStatus: () => Promise.resolve(),
        getBackendForTask: () => Promise.resolve({ setTaskMetadata: () => Promise.resolve() }),
        getTask: () =>
          Promise.resolve({
            id: "456",
            title: TEST_TASK_TITLE,
            status: TEST_TASK_STATUS,
            createdAt: new Date().toISOString(),
          }),
      }),
      workspaceUtils: createPartialMock<WorkspaceUtilsInterface>({
        getRepoWorkspace: () => TEST_WORKDIR,
        getCurrentWorkingDirectory: () => TEST_WORKDIR,
      }),
      resolveRepoPath: () => Promise.resolve(TEST_REPO_PATH),
      createRepositoryBackendForSession: () =>
        Promise.resolve({
          getType: () => TEST_BACKEND_TYPE,
          approvePullRequest: () =>
            Promise.resolve({
              reviewId: "test-review-456",
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: "456",
            }),
        }),
      getCurrentSession: () => Promise.resolve("current-session"), // Mock session detection
    };

    // Test session detection by repo path
    const result = await approveSessionFromParams({ repo: TEST_REPO_PATH }, testDeps);
    expect(result.sessionName).toBe("current-session");
    expect(result.taskId).toBe("456");
  });

  test("throws error when session is not found", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      getSessionByTaskId: () => Promise.resolve(null),
    });

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

    // Test with non-existent session
    try {
      await approveSessionFromParams({ session: "non-existent" }, testDeps);
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain('Session "non-existent" not found');
    }
  });
});
