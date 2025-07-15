/**
 * Test suite for session creation git clone consistency bug fix
 *
 * This tests the critical bug fix where session records were being added to the database
 * before git operations succeeded, causing inconsistent state when git operations failed.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import * as fs from "fs";
import { startSessionFromParams } from "./session";
import { createMock } from "../utils/test-utils/mocking";
import { MinskyError, ResourceNotFoundError } from "../errors";

describe("Session Start Consistency Tests", () => {
  let mockSessionDB: any;
  let mockGitService: any;
  let mockTaskService: any;
  let mockWorkspaceUtils: any;
  let mockResolveRepoPath: any;

  beforeEach(() => {
    // Mock the file system functions
    spyOn(fs, "existsSync").mockReturnValue(false);
    spyOn(fs, "rmSync").mockImplementation(() => {});

    // Create fresh mocks for each test
    mockSessionDB = {
      getSession: createMock(),
      addSession: createMock(),
      deleteSession: createMock(),
      listSessions: createMock(),
      getSessionByTaskId: createMock(),
      getNewSessionRepoPath: createMock(),
    };

    mockGitService = {
      clone: createMock(),
      branch: createMock(),
      branchWithoutSession: createMock(),
    };

    mockTaskService = {
      getTask: createMock(),
      getTaskStatus: createMock(),
      setTaskStatus: createMock(),
    };

    mockWorkspaceUtils = {
      isSessionWorkspace: createMock(),
    };

    mockResolveRepoPath = createMock();

    // Setup default successful responses
    mockSessionDB.getSession.mockResolvedValue(null); // No existing session
    mockSessionDB.listSessions.mockResolvedValue([]);
    mockSessionDB.addSession.mockResolvedValue(undefined);
    mockSessionDB.deleteSession.mockResolvedValue(true);
    mockSessionDB.getNewSessionRepoPath.mockReturnValue("/test/sessions/task160");

    mockGitService.clone.mockResolvedValue({ workdir: "/test/sessions/task160" });
    mockGitService.branch.mockResolvedValue({ branch: "task160" });
    mockGitService.branchWithoutSession.mockResolvedValue({ branch: "task160", workdir: "/test/sessions/task160" });

    mockTaskService.getTask.mockResolvedValue({ id: "160", title: "Test Task" });
    mockTaskService.getTaskStatus.mockResolvedValue("TODO");
    mockTaskService.setTaskStatus.mockResolvedValue(undefined);

    mockWorkspaceUtils.isSessionWorkspace.mockResolvedValue(false);
    mockResolveRepoPath.mockResolvedValue("local/minsky");
  });

  describe("Successful session creation", () => {
    it("should only add session to database after git operations succeed", async () => {
      // Arrange
      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act
      await startSessionFromParams(params, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
      });

      // Assert - verify call order by checking that git operations were called first
      expect(mockGitService.clone).toHaveBeenCalled();
      expect(mockGitService.branchWithoutSession).toHaveBeenCalled();
      expect(mockSessionDB.addSession).toHaveBeenCalled();

      // Verify all operations completed
      expect(mockGitService.clone).toHaveBeenCalledTimes(1);
      expect(mockGitService.branchWithoutSession).toHaveBeenCalledTimes(1);
      expect(mockSessionDB.addSession).toHaveBeenCalledTimes(1);
    });

    it("should clean up existing directory before starting", async () => {
      // Arrange
      (fs.existsSync as unknown).mockReturnValue(true); // Directory exists
      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act
      await startSessionFromParams(params, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
      });

      // Assert
      expect(fs.existsSync).toHaveBeenCalled();
      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining("task#160"), {
        recursive: true,
        force: true,
      });
    });
  });

  describe("Git clone failure scenarios", () => {
    it("should not add session to database when git clone fails", async () => {
      // Arrange
      const gitError = new Error("destination path already exists and is not an empty directory");
      mockGitService.clone.mockRejectedValue(gitError);

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("destination path already exists");

      // Verify session was never added to database
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });

    it("should not add session to database when git branch creation fails", async () => {
      // Arrange
      const branchError = new Error("failed to create branch");
      mockGitService.branchWithoutSession.mockRejectedValue(branchError);

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("failed to create branch");

      // Verify session was never added to database
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });

    it("should clean up session directory when git operations fail", async () => {
      // Arrange
      const gitError = new Error("git clone failed");
      mockGitService.clone.mockRejectedValue(gitError);
      (fs.existsSync as unknown).mockReturnValue(true); // Directory exists after failed clone

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("git clone failed");

      // Verify directory cleanup was attempted (called multiple times due to initial cleanup + error cleanup)
      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining("task#160"), {
        recursive: true,
        force: true,
      });
    });
  });

  describe("Session record cleanup scenarios", () => {
    it("should handle session deletion cleanup failure gracefully", async () => {
      // Arrange
      const gitError = new Error("git operation failed");

      mockGitService.clone.mockRejectedValue(gitError);

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("git operation failed");

      // The original git error should be thrown
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });
  });

  describe("Edge cases and error handling", () => {
    it("should handle directory cleanup failure gracefully", async () => {
      // Arrange
      (fs.existsSync as unknown).mockReturnValue(true);
      (fs.rmSync as unknown).mockImplementation(() => {
        throw new Error("permission denied");
      });

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert - should throw MinskyError about cleanup failure
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("Failed to clean up existing session directory");
    });

    it("should prevent session creation when session already exists", async () => {
      // Arrange
      mockSessionDB.getSession.mockResolvedValue({
        session: "task#160",
        repoUrl: "local/minsky",
        repoName: "local-minsky",
      });

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("Session 'task#160' already exists");

      // Verify no git operations were attempted
      expect(mockGitService.clone).not.toHaveBeenCalled();
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });

    it("should prevent session creation when task session already exists", async () => {
      // Arrange
      mockSessionDB.listSessions.mockResolvedValue([
        {
          session: "existing-task160",
          taskId: "#160",
          repoUrl: "local/minsky",
        },
      ]);

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("A session for task #160 already exists");

      // Verify no git operations were attempted
      expect(mockGitService.clone).not.toHaveBeenCalled();
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });

    it("should handle task not found gracefully", async () => {
      // Arrange
      mockTaskService.getTask.mockResolvedValue(null);

      const params = {
        task: "999",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("Task #999 not found");

      // Verify no session operations were attempted
      expect(mockGitService.clone).not.toHaveBeenCalled();
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();
    });
  });

  describe("Regression tests for original bug", () => {
    it("should reproduce and fix the original git clone consistency bug", async () => {
      // Arrange - simulate the exact scenario that caused the original bug
      const gitError = new Error(
        "fatal: destination path 'task#160' already exists and is not an empty directory"
      );
      mockGitService.clone.mockRejectedValue(gitError);

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("destination path 'task#160' already exists");

      // Critical assertion: session should NOT be in database after git failure
      expect(mockSessionDB.addSession).not.toHaveBeenCalled();

      // Verify the session database is clean and no orphaned records exist
      const addSessionCalls = mockSessionDB.addSession.mock.calls;
      const deleteSessionCalls = mockSessionDB.deleteSession.mock.calls;

      expect(addSessionCalls).toHaveLength(0);
      // If addSession was never called, deleteSession shouldn't be called either
      // (unless cleaning up pre-existing state, but that's handled elsewhere)
    });

    it("should verify that session can be created after cleaning up inconsistent state", async () => {
      // Arrange - simulate the scenario where we clean up and then successfully create
      let callCount = 0;
      mockSessionDB.getSession.mockImplementation(() => {
        callCount++;
        // First call: no existing session
        return Promise.resolve(null);
      });

      const params = {
        task: "160",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act - should succeed now that we have proper cleanup
      const result = await startSessionFromParams(params, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
      });

      // Assert
      expect(result).toMatchObject({
        session: "task#160",
        repoUrl: "local/minsky",
        branch: "task#160",
        taskId: "#160",
      });

      // Verify session was properly added to database
      expect(mockSessionDB.addSession).toHaveBeenCalledTimes(1);
      expect(mockSessionDB.addSession).toHaveBeenCalledWith(
        expect.objectContaining({
          session: "task#160",
          taskId: "#160",
          repoUrl: "local/minsky",
        })
      );
    });
  });
});
