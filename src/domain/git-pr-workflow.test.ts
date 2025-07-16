/**
 * Git PR Workflow Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { approveSessionFromParams } from "./session";

import { createMock, setupTestMocks } from "../utils/test-utils/mocking";
import {
  expectToHaveBeenCalled,
  expectToHaveBeenCalledWith,
} from "../utils/test-utils/assertions";
import * as WorkspaceUtils from "./workspace";
// Set up automatic mock cleanup
setupTestMocks();

describe("Session Approve Workflow", () => {
  // Create mocks for dependencies
  const mockGitService = {
    execInRepository: createMock((_workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abc123");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("test-user");
      }
      return Promise.resolve("Successfully merged PR");
    }),
  };

  const mockTaskService = {
    getTask: createMock((id) =>
      Promise.resolve({
        id,
        _title: "Test Task",
        description: "A test task",
        _status: "in-progress",
      })
    ),
    setTaskStatus: createMock(() => Promise.resolve(true)),
  };

  const mockSessionDB = {
    getSession: createMock((name) =>
      Promise.resolve({
        _session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
        createdAt: new Date().toISOString(),
        taskId: "task025",
      })
    ),
    getSessionWorkdir: createMock(() => Promise.resolve("/test/repo/path/sessions/test-session")),
    getSessionByTaskId: createMock(() => Promise.resolve(null)),
  };

  // Reset mocks before each test is handled by setupTestMocks()
  beforeEach(() => {
    // Additional test-specific setup can go here if needed
  });

  test("successfully approves and merges a PR branch with task ID", async () => {
    const result = await approveSessionFromParams(
      { _session: "test-session" },
      {
        gitService: mockGitService as unknown,
        taskService: mockTaskService as unknown,
        sessionDB: mockSessionDB as unknown,
        workspaceUtils: WorkspaceUtils,
      }
    );

    // Verify results
    expect(result._session).toBe("test-session");
    expect(result.commitHash).toBe("abc123");
    expect(result.mergeDate).toBeDefined();
    expect(result.mergedBy).toBe("test-user");
    expect(result.taskId).toBe("task025");

    // Verify methods were called with expected parameters using our helpers
    expectToHaveBeenCalledWith(mockSessionDB.getSession, "test-session");
    expectToHaveBeenCalledWith(mockTaskService.setTaskStatus, "task025", "DONE");

    // Verify methods were called
    expectToHaveBeenCalled(mockGitService.execInRepository);
    expectToHaveBeenCalled(mockTaskService.setTaskStatus);
  });

  test("throws ValidationError when session parameter is missing", async () => {
    await expect(
      approveSessionFromParams(
        {},
        {
          gitService: mockGitService as unknown,
          taskService: mockTaskService as unknown,
          sessionDB: mockSessionDB as unknown,
          workspaceUtils: WorkspaceUtils,
        }
      )
    ).rejects.toThrow("No session detected");
  });

  test("throws ResourceNotFoundError when session does not exist", async () => {
    // Create a new mock with different implementation rather than overriding
    const getNullSession = createMock(() => Promise.resolve(null));

    // Create a new mockSessionDB with the different getSession implementation
    const mockSessionDBWithNull = {
      ...mockSessionDB,
      getSession: getNullSession,
    };

    await expect(
      approveSessionFromParams(
        { _session: "non-existent-session" },
        {
          gitService: mockGitService as unknown,
          taskService: mockTaskService as unknown,
          sessionDB: mockSessionDBWithNull as unknown,
          workspaceUtils: WorkspaceUtils,
        }
      )
    ).rejects.toThrow("Session \"non-existent-session\" not found");
  });

  test("throws MinskyError when git command fails", async () => {
    // Create a new mock with different implementation rather than overriding
    const execWithError = createMock(() => Promise.reject(new Error("Git command failed")));

    // Create a new mockGitService with the different execInRepository implementation
    const mockGitServiceWithError = {
      ...mockGitService,
      execInRepository: execWithError,
    };

    await expect(
      approveSessionFromParams(
        { _session: "test-session" },
        {
          gitService: mockGitServiceWithError as unknown,
          taskService: mockTaskService as unknown,
          sessionDB: mockSessionDB as unknown,
          workspaceUtils: WorkspaceUtils,
        }
      )
    ).rejects.toThrow("Failed to approve session");
  });
});
