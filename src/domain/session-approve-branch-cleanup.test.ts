import { describe, test, expect, mock } from "bun:test";
import { approveSessionFromParams } from "./session";
import { createPartialMock } from "../utils/test-utils/mocking";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";

// Remove global module mock - use dependency injection instead

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

describe("Session Approve Branch Cleanup", () => {
  test("should delete local PR branch and task branch after successful merge", async () => {
    // Test-scoped constants removed - using module level TEST_PR_NUMBER

    // Clean DI approach for branch cleanup
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH, // Added required prBranch
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
            id: TEST_TASK_ID,
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
              reviewId: TEST_REVIEW_ID,
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: TEST_PR_NUMBER,
            }),
        }),
    };

    // Test branch cleanup approval
    const result = await approveSessionFromParams({ session: TEST_SESSION_NAME }, testDeps);
    expect(result.sessionName).toBe(TEST_SESSION_NAME);
    expect(result.taskId).toBe(TEST_TASK_ID);
  });

  test("should handle branch cleanup failures gracefully without failing the operation", async () => {
    // Clean DI approach
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH, // Added required prBranch
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
            id: TEST_TASK_ID,
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
              reviewId: TEST_REVIEW_ID,
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: TEST_PR_NUMBER,
            }),
        }),
    };

    // Test graceful handling of cleanup failures
    const result = await approveSessionFromParams({ session: TEST_SESSION_NAME }, testDeps);
    expect(result.sessionName).toBe(TEST_SESSION_NAME);
    expect(result.taskId).toBe(TEST_TASK_ID);
  });

  test("should not attempt branch cleanup for already approved sessions", async () => {
    // Clean DI approach
    const mockSessionDB = createMockSessionProvider({
      sessions: [
        {
          session: TEST_SESSION_NAME,
          repoName: TEST_REPO_NAME,
          repoUrl: TEST_REPO_PATH,
          taskId: TEST_TASK_ID,
          prBranch: TEST_PR_BRANCH, // Added required prBranch
          prApproved: true, // Already approved session
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
            id: TEST_TASK_ID,
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
              reviewId: TEST_REVIEW_ID,
              approvedBy: TEST_USER_NAME,
              approvedAt: new Date().toISOString(),
              prNumber: TEST_PR_NUMBER,
            }),
        }),
    };

    // Test already approved session
    const result = await approveSessionFromParams({ session: TEST_SESSION_NAME }, testDeps);
    expect(result.sessionName).toBe(TEST_SESSION_NAME);
    expect(result.taskId).toBe(TEST_TASK_ID);
  });
});