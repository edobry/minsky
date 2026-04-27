import { describe, test, expect, mock } from "bun:test";
import { approveSessionPr } from "./session/session-approval-operations";
import { ResourceNotFoundError } from "../errors/index";
import { log } from "../utils/logger";
import { FakeGitService } from "./git/fake-git-service";
import { FakeSessionProvider } from "./session/fake-session-provider";
import { FakeWorkspaceUtils } from "./workspace/fake-workspace-utils";
import { FakeTaskService } from "./tasks/fake-task-service";

// Mock logger
// Remove global module mock - use dependency injection instead

const _TEST_VALUE = 123;

// Test constants to avoid magic strings
const TEST_SESSION_NAME = "test-session";
const TEST_TASK_ID = "md#265";
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
    // Test-scoped constants removed - using module level TEST_PR_NUMBER

    const mockSessionDB = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: TEST_SESSION_NAME,
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
    const mockGitService = new FakeGitService();
    mockGitService.execInRepository = () => Promise.resolve(TEST_COMMIT_HASH);

    const mockTaskService = (() => {
      const svc = new FakeTaskService({
        initialTasks: [{ id: TEST_TASK_ID, title: TEST_TASK_TITLE, status: TEST_TASK_STATUS }],
      });
      svc.setTaskStatus = () => Promise.resolve();
      svc.getBackendForTask = (() =>
        Promise.resolve({ setTaskMetadata: () => Promise.resolve() })) as any;
      return svc;
    })();

    const simpleDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: Object.assign(new FakeWorkspaceUtils(), {
        getRepoWorkspace: () => TEST_WORKDIR,
        getCurrentWorkingDirectory: () => TEST_WORKDIR,
      }),
      resolveRepoPath: () => TEST_REPO_PATH,
      createRepositoryBackendForSession: (() =>
        Promise.resolve({
          getType: () => TEST_BACKEND_TYPE,
          review: {
            approve: () =>
              Promise.resolve({
                reviewId: TEST_REVIEW_ID,
                approvedBy: TEST_USER_NAME,
                approvedAt: new Date().toISOString(),
                prNumber: TEST_PR_NUMBER,
              }),
          },
        })) as any,
    };

    // This should work since we know the mock has the right session
    try {
      const result = await approveSessionPr({ session: TEST_SESSION_NAME }, simpleDeps);
      expect(result.session).toBe(TEST_SESSION_NAME);
    } catch (error) {
      log.debug(`Error details: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  test("successfully approves and merges a PR branch", async () => {
    // Clean DI approach - just mock data and verify results
    const mockSessionDB = new FakeSessionProvider({
      initialSessions: [
        {
          sessionId: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const mockGitService = new FakeGitService();
    mockGitService.execInRepository = () => Promise.resolve(TEST_COMMIT_HASH);

    const mockTaskService = (() => {
      const svc = new FakeTaskService({
        initialTasks: [{ id: TEST_TASK_ID, title: TEST_TASK_TITLE, status: TEST_TASK_STATUS }],
      });
      svc.setTaskStatus = () => Promise.resolve();
      svc.getBackendForTask = (() =>
        Promise.resolve({ setTaskMetadata: () => Promise.resolve() })) as any;
      return svc;
    })();

    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: Object.assign(new FakeWorkspaceUtils(), {
        getRepoWorkspace: () => TEST_WORKDIR,
        getCurrentWorkingDirectory: () => TEST_WORKDIR,
      }),
      resolveRepoPath: () => TEST_REPO_PATH,
      createRepositoryBackendForSession: () =>
        Promise.resolve({
          getType: () => TEST_BACKEND_TYPE,
          review: {
            approve: () =>
              Promise.resolve({
                reviewId: TEST_REVIEW_ID,
                approvedBy: TEST_USER_NAME,
                approvedAt: new Date().toISOString(),
                prNumber: TEST_PR_NUMBER,
              }),
          },
        }),
    };

    // Test by session ID
    const resultBySession = await approveSessionPr({ session: TEST_SESSION_NAME }, testDeps as any);
    expect(resultBySession.session).toBe(TEST_SESSION_NAME);
    expect(resultBySession.taskId).toBe(TEST_TASK_ID);

    // Test by task ID
    const resultByTask = await approveSessionPr({ task: TEST_TASK_ID }, testDeps as any);
    expect(resultByTask.session).toBe(TEST_SESSION_NAME);
    expect(resultByTask.taskId).toBe(TEST_TASK_ID);
  });

  test("throws error when session is not found", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = () => Promise.resolve(null);
    mockSessionDB.getSessionByTaskId = () => Promise.resolve(null);
    mockSessionDB.getSessionWorkdir = mock(() => Promise.resolve(""));

    const mockGitService = new FakeGitService();
    mockGitService.execInRepository = () => Promise.resolve("");

    const mockTaskService = (() => {
      const svc = new FakeTaskService();
      svc.setTaskStatus = () => Promise.resolve();
      svc.getBackendForTask = (() => Promise.resolve({})) as any;
      return svc;
    })();

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {
        getCurrentSession: mock(() => Promise.resolve(null)),
      },
    };

    // Test with non-existent session
    try {
      await approveSessionPr(
        { session: "non-existent" },
        testDeps as unknown as Parameters<typeof approveSessionPr>[1]
      );
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain('Session "non-existent" not found');
    }
  });
});
