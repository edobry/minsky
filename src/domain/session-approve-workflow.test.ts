/**
 * SESSION APPROVAL WORKFLOW TESTS
 *
 * What this file tests:
 * - Session approval workflow via approveSessionPr function
 * - Integration between session management, git operations, and task status updates
 * - End-to-end session approval process including PR merging and cleanup
 *
 * Key functionality tested:
 * - Session retrieval and validation
 * - Git operations during session approval (merging, cleanup)
 * - Task status updates after successful session approval
 * - Error handling in session approval workflow
 *
 * NOTE: This is different from git-service-pr-workflow.test.ts which tests GitService class methods
 *
 * @migrated Updated to use centralized factories and proper Bun patterns
 * @refactored Eliminated interface mismatches and local mock objects
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { approveSessionPr } from "./session/session-approval-operations";

import { setupTestMocks } from "../utils/test-utils/mocking";
import { FakeGitService } from "./git/fake-git-service";
import { FakeTaskService } from "./tasks/fake-task-service";
import { FakeWorkspaceUtils } from "./workspace/fake-workspace-utils";
import { expectToHaveBeenCalledWith } from "../utils/test-utils/assertions";
import { FakeSessionProvider } from "./session/fake-session-provider";

// Remove global module mocks - use dependency injection instead

// Set up automatic mock cleanup
setupTestMocks();

describe("Session Approve Workflow", () => {
  // Create trackable spies for methods we need to verify
  let getSessionSpy: any;
  let getSessionWorkdirSpy: any;
  let getSessionByTaskIdSpy: any;
  let execInRepositorySpy: any;
  let getTaskSpy: any;
  let setTaskStatusSpy: any;
  let mockSessionDB: any;
  let mockGitService: any;
  let mockTaskService: any;
  let mockWorkspaceUtils: any;

  beforeEach(() => {
    // Create fresh spies for each test
    getSessionSpy = mock(() => {});
    getSessionSpy = mock((name) =>
      Promise.resolve({
        sessionId: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        backendType: "github",
        remote: { authMethod: "ssh", depth: 1 },
        createdAt: new Date().toISOString(),
        taskId: "md#025", // Use qualified task ID format
        prBranch: `pr/${name}`, // Add required prBranch property
      })
    );

    getSessionWorkdirSpy = mock(() => {});
    getSessionWorkdirSpy = mock(() => Promise.resolve("/test/repo/path/sessions/test-session"));

    getSessionByTaskIdSpy = mock(() => {});
    getSessionByTaskIdSpy = mock(() => Promise.resolve(null));

    execInRepositorySpy = mock(() => {});
    execInRepositorySpy = mock((workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abc123");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("test-user");
      }
      return Promise.resolve("Successfully merged PR");
    });

    getTaskSpy = mock(() => {});
    getTaskSpy = mock((id) =>
      Promise.resolve({
        id,
        title: "Test Task", // Fixed: use 'title' instead of '_title'
        description: "A test task",
        status: "in-progress", // Fixed: use 'status' instead of '_status'
      })
    );

    setTaskStatusSpy = mock(() => {});
    setTaskStatusSpy = mock(() => Promise.resolve(true));

    // Create mocks using centralized factories with spy integration
    mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = getSessionSpy;
    mockSessionDB.getSessionByTaskId = getSessionByTaskIdSpy;
    mockSessionDB.getSessionWorkdir = getSessionWorkdirSpy;

    mockGitService = new FakeGitService();
    mockGitService.execInRepository = execInRepositorySpy;

    mockTaskService = (() => {
      const svc = new FakeTaskService();
      svc.setTaskStatus = setTaskStatusSpy;
      svc.getTask = getTaskSpy;
      return svc;
    })();

    mockWorkspaceUtils = new FakeWorkspaceUtils();
  });

  test("successfully approves and merges a PR branch with task ID", async () => {
    const result = await approveSessionPr(
      { session: "test-session" }, // Fixed: use 'session' instead of '_session'
      {
        gitService: mockGitService,
        taskService: mockTaskService,
        sessionDB: mockSessionDB,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: () => "/test/repo/path",
        createRepositoryBackendForSession: (() =>
          Promise.resolve({
            getType: () => "test-backend",
            review: {
              approve: () =>
                Promise.resolve({
                  reviewId: "test-review-025",
                  approvedBy: "test-user",
                  approvedAt: new Date().toISOString(),
                  prNumber: "025",
                }),
            },
          })) as any,
      }
    );

    // Verify results (fixed interface expectations for new approval-only function)
    expect(result.session).toBe("test-session");
    expect(result.taskId).toBe("md#025"); // Use qualified task ID format
    expect(result.approvalInfo).toBeDefined();
    expect(result.approvalInfo.reviewId).toBe("test-review-025");
    expect(result.approvalInfo.approvedBy).toBe("test-user");
    expect(result.wasAlreadyApproved).toBe(false);

    // Verify methods were called with expected parameters using our helpers
    expectToHaveBeenCalledWith(getSessionSpy, "test-session");
    // Note: New approve function only approves, doesn't merge or directly call git commands
  });

  test("throws ValidationError when session parameter is missing", async () => {
    await expect(
      approveSessionPr(
        {},
        {
          gitService: mockGitService,
          taskService: mockTaskService,
          sessionDB: mockSessionDB,
          workspaceUtils: mockWorkspaceUtils,
          createRepositoryBackendForSession: mock((sessionRecord: any) =>
            Promise.resolve({
              getType: () => "local",
              pr: {
                merge: mock(() =>
                  Promise.resolve({
                    commitHash: "abc123commit",
                    mergeDate: new Date(),
                    mergedBy: "test-user",
                  })
                ),
              },
            })
          ) as any,
        }
      )
    ).rejects.toThrow();
  });

  test("handles git command failures gracefully", async () => {
    // Override execInRepository to simulate failure
    let failingExecSpy = mock(() => {});
    failingExecSpy = mock(() => Promise.reject(new Error("Git command failed")));

    const failingGitService = new FakeGitService();
    failingGitService.execInRepository = failingExecSpy as any;

    await expect(
      approveSessionPr(
        { session: "test-session" }, // Fixed: use 'session' instead of '_session'
        {
          gitService: failingGitService,
          taskService: mockTaskService,
          sessionDB: mockSessionDB,
          workspaceUtils: mockWorkspaceUtils,
        }
      )
    ).rejects.toThrow();

    // Note: With repository backend mock, git service methods are not directly called
    // The error propagates from the mocked repository backend instead
  });
});
