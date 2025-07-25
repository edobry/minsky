/**
 * SESSION APPROVAL WORKFLOW TESTS
 *
 * What this file tests:
 * - Session approval workflow via approveSessionFromParams function
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
import { approveSessionFromParams } from "./session";

import { createMock, createPartialMock, setupTestMocks } from "../utils/test-utils/mocking";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";
import { expectToHaveBeenCalled, expectToHaveBeenCalledWith } from "../utils/test-utils/assertions";

// Module-level mocks for git utilities to prevent real command execution
mock.module("../utils/git-exec", () => ({
  execGitWithTimeout: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
  gitFetchWithTimeout: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
  gitPushWithTimeout: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
}));

mock.module("../utils/exec", () => ({
  execAsync: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
}));

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
        session: name, // Fixed: use 'session' instead of '_session'
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
        createdAt: new Date().toISOString(),
        taskId: "task025",
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
    mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy,
      getSessionByTaskId: getSessionByTaskIdSpy,
    });

    // Add getSessionWorkdir method not covered by centralized factory
    (mockSessionDB as any).getSessionWorkdir = getSessionWorkdirSpy;

    mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy,
    });

    mockTaskService = createMockTaskService({
      setTaskStatus: setTaskStatusSpy,
    });

    // Add getTask method not covered by centralized factory
    (mockTaskService as any).getTask = getTaskSpy;

    mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isWorkspace: () => Promise.resolve(true),
      isSessionWorkspace: () => false,
      getCurrentSession: () => Promise.resolve(undefined),
      getSessionFromWorkspace: () => Promise.resolve(undefined),
      resolveWorkspacePath: () => Promise.resolve("/mock/workspace"),
    });
  });

  test("successfully approves and merges a PR branch with task ID", async () => {
    const result = await approveSessionFromParams(
      { session: "test-session" }, // Fixed: use 'session' instead of '_session'
      {
        gitService: mockGitService,
        taskService: mockTaskService,
        sessionDB: mockSessionDB,
        workspaceUtils: mockWorkspaceUtils,
      }
    );

    // Verify results (fixed interface expectations)
    expect(result.session).toBe("test-session"); // Fixed: expect 'session' property
    expect(result.commitHash).toBe("abc123");
    expect(result.mergeDate).toBeDefined();
    expect(result.mergedBy).toBe("test-user");
    expect(result.taskId).toBe("task025");

    // Verify methods were called with expected parameters using our helpers
    expectToHaveBeenCalledWith(getSessionSpy, "test-session");
    expectToHaveBeenCalledWith(setTaskStatusSpy, "task025", "DONE");

    // Verify methods were called
    expectToHaveBeenCalled(execInRepositorySpy);
    expectToHaveBeenCalled(setTaskStatusSpy);
  });

  test("throws ValidationError when session parameter is missing", async () => {
    await expect(
      approveSessionFromParams(
        {},
        {
          gitService: mockGitService,
          taskService: mockTaskService,
          sessionDB: mockSessionDB,
          workspaceUtils: mockWorkspaceUtils,
        }
      )
    ).rejects.toThrow();
  });

  test("handles git command failures gracefully", async () => {
    // Override execInRepository to simulate failure
    let failingExecSpy = mock(() => {});
    failingExecSpy = mock(() => Promise.reject(new Error("Git command failed")));

    const failingGitService = createMockGitService({
      execInRepository: failingExecSpy,
    });

    await expect(
      approveSessionFromParams(
        { session: "test-session" }, // Fixed: use 'session' instead of '_session'
        {
          gitService: failingGitService,
          taskService: mockTaskService,
          sessionDB: mockSessionDB,
          workspaceUtils: mockWorkspaceUtils,
        }
      )
    ).rejects.toThrow("Git command failed");

    // Verify the failing method was called
    expectToHaveBeenCalled(failingExecSpy);
  });
});
