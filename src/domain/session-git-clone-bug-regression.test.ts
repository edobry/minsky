/**
 * Regression test for session creation git clone consistency bug
 *
 * This test reproduces the exact scenario that caused the original issue:
 * 1. Git clone fails due to existing directory
 * 2. Verify session record is NOT left in database
 * 3. Verify proper cleanup allows subsequent session creation
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { startSessionFromParams } from "./session.js";
import { createMock } from "../utils/test-utils/mocking.js";

describe("Session Git Clone Bug Regression Test", () => {
  it("should not leave orphaned session records when git clone fails", async () => {
    // Arrange - Simulate the exact error scenario that caused the bug
    const mockSessionDB = {
      getSession: createMock().mockResolvedValue(null),
      listSessions: createMock().mockResolvedValue([]),
      addSession: createMock().mockResolvedValue(undefined),
      deleteSession: createMock().mockResolvedValue(true),
      getNewSessionRepoPath: createMock().mockReturnValue("/test/sessions/task#160"),
    };

    const mockGitService = {
      clone: createMock().mockRejectedValue(
        new Error("fatal: destination path 'task#160' already exists and is not an empty directory")
      ),
      branch: createMock().mockResolvedValue({ branch: "task#160" }),
    };

    const mockTaskService = {
      getTask: createMock().mockResolvedValue({ id: "160", title: "Test Task" }),
      getTaskStatus: createMock().mockResolvedValue("TODO"),
      setTaskStatus: createMock().mockResolvedValue(undefined),
    };

    const mockWorkspaceUtils = {
      isSessionWorkspace: createMock().mockResolvedValue(false),
    };

    const mockResolveRepoPath = createMock().mockResolvedValue("local/minsky");

    const params = {
      task: "160",
      repo: "local/minsky",
      quiet: false,
      noStatusUpdate: false,
      skipInstall: true,
    };

    // Act & Assert - Git clone failure should not leave session in database
    await expect(
      startSessionFromParams(params, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
      })
    ).rejects.toThrow("destination path 'task#160' already exists");

    // Critical assertion: NO session record should be added to database
    expect(mockSessionDB.addSession).not.toHaveBeenCalled();

    // Verify git clone was attempted but failed before session was added
    expect(mockGitService.clone).toHaveBeenCalledTimes(1);
    expect(mockGitService.branch).not.toHaveBeenCalled(); // Should not reach branch creation
  });

  it("should successfully create session after fixing git directory issues", async () => {
    // Arrange - Now simulate successful scenario after cleanup
    const mockSessionDB = {
      getSession: createMock().mockResolvedValue(null),
      listSessions: createMock().mockResolvedValue([]),
      addSession: createMock().mockResolvedValue(undefined),
      deleteSession: createMock().mockResolvedValue(true),
      getNewSessionRepoPath: createMock().mockReturnValue("/test/sessions/task#160"),
    };

    const mockGitService = {
      clone: createMock().mockResolvedValue({ workdir: "/test/sessions/task#160" }),
      branch: createMock().mockResolvedValue({ branch: "task#160" }),
    };

    const mockTaskService = {
      getTask: createMock().mockResolvedValue({ id: "160", title: "Test Task" }),
      getTaskStatus: createMock().mockResolvedValue("TODO"),
      setTaskStatus: createMock().mockResolvedValue(undefined),
    };

    const mockWorkspaceUtils = {
      isSessionWorkspace: createMock().mockResolvedValue(false),
    };

    const mockResolveRepoPath = createMock().mockResolvedValue("local/minsky");

    const params = {
      task: "160",
      repo: "local/minsky",
      quiet: false,
      noStatusUpdate: false,
      skipInstall: true,
    };

    // Act
    const result = await startSessionFromParams(params, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      resolveRepoPath: mockResolveRepoPath,
    });

    // Assert - Session should be created successfully
    expect(result).toMatchObject({
      session: "task#160",
      taskId: "#160",
      repoUrl: "local/minsky",
    });

    // Verify proper order: git operations first, then session record
    expect(mockGitService.clone).toHaveBeenCalledTimes(1);
    expect(mockGitService.branch).toHaveBeenCalledTimes(1);
    expect(mockSessionDB.addSession).toHaveBeenCalledTimes(1);

    // Verify session record has correct data
    expect(mockSessionDB.addSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "task#160",
        taskId: "#160",
        repoUrl: "local/minsky",
        repoPath: "/test/sessions/task#160",
      })
    );
  });
});
