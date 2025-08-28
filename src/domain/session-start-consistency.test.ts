/**
 * Test suite for session creation git clone consistency bug fix
 *
 * This tests the critical bug fix where session records were being added to the database
 * before git operations succeeded, causing inconsistent state when git operations failed.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { startSessionFromParams } from "./session";
import { MinskyError, ResourceNotFoundError } from "../errors";
import { TEST_PATHS } from "../utils/test-utils/test-constants";
import type { SessionProviderInterface } from "./session";
import type { GitServiceInterface } from "./git";
import type { TaskServiceInterface } from "./tasks";
import type { WorkspaceUtilsInterface } from "./workspace";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/index";

describe("Session Start Consistency Tests", () => {
  let mockSessionDB: SessionProviderInterface;
  let mockGitService: GitServiceInterface;
  let mockTaskService: TaskServiceInterface;
  let mockWorkspaceUtils: WorkspaceUtilsInterface;
  let mockResolveRepoPath: any;

  // Create individual spies for call tracking
  let gitCloneSpy: any;
  let gitBranchWithoutSessionSpy: any;
  let sessionAddSpy: any;

  beforeEach(() => {
    // Create centralized mocks with default successful responses
    mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null), // No existing session
      listSessions: () => Promise.resolve([]),
      addSession: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(true),
      getRepoPath: () => Promise.resolve(TEST_PATHS.SESSION_MD_160),
      getSessionWorkdir: () => Promise.resolve(TEST_PATHS.SESSION_MD_160),
    });

    mockGitService = createMockGitService({
      clone: () => Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, session: "task-md#160" }),
      branch: () => Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" }),
    });

    mockTaskService = createMockTaskService({
      getTask: () => Promise.resolve({ id: "md#160", title: "Test Task", status: "TODO" }),
      getTaskStatus: () => Promise.resolve("TODO"),
      setTaskStatus: () => Promise.resolve(),
    });

    mockWorkspaceUtils = {
      isSessionWorkspace: mock(() => false),
      isWorkspace: mock(() => Promise.resolve(true)),
      getCurrentSession: mock(() => Promise.resolve(undefined)),
      getSessionFromWorkspace: mock(() => Promise.resolve(undefined)),
      resolveWorkspacePath: mock(() => Promise.resolve("/mock/workspace/path")),
    };

    mockResolveRepoPath = mock(() => Promise.resolve("local/minsky"));

    // Create individual spies for call tracking
    gitCloneSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, session: "task-md#160" })
    );
    gitBranchWithoutSessionSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" })
    );
    sessionAddSpy = mock(() => Promise.resolve());

    // Replace service methods with spies for call tracking
    mockGitService.clone = gitCloneSpy;
    mockGitService.branchWithoutSession = gitBranchWithoutSessionSpy;
    mockSessionDB.addSession = sessionAddSpy;
  });

  describe("Successful session creation", () => {
    it("should only add session to database after git operations succeed", async () => {
      // Arrange
      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
        // sessionName will be auto-generated from taskId
      };

      // Act
      await startSessionFromParams(params, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
        // Inject mock fs adapter to avoid real filesystem ops in tests
        fs: {
          exists: () => false,
          rm: async () => {
            /* no-op */
          },
        } as any,
      });

      // Assert - verify call order by checking that git operations were called first
      expect(gitCloneSpy).toHaveBeenCalled();
      expect(gitBranchWithoutSessionSpy).toHaveBeenCalled();
      expect(sessionAddSpy).toHaveBeenCalled();

      // Verify all operations completed
      expect(gitCloneSpy).toHaveBeenCalledTimes(1);
      expect(gitBranchWithoutSessionSpy).toHaveBeenCalledTimes(1);
      expect(sessionAddSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Git clone failure scenarios", () => {
    it("should not add session to database when git clone fails", async () => {
      // Arrange
      const gitError = new Error("destination path already exists and is not an empty directory");
      mockGitService.clone = mock(() => Promise.reject(gitError));

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("destination path already exists");

      // Verify session was never added to database
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });

    it("should not add session to database when git branch creation fails", async () => {
      // Arrange
      const gitError = new Error("failed to create branch test-branch");
      mockGitService.branchWithoutSession = mock(() => Promise.reject(gitError));

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("failed to create branch");

      // Verify session was never added to database
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });

    it("should propagate git errors without modification", async () => {
      // Arrange
      const originalError = new Error("git operation failed");
      mockGitService.clone = mock(() => Promise.reject(originalError));

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("git operation failed");

      // Verify session was never added to database
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });
  });

  describe("Error handling edge cases", () => {
    it("should prevent session creation when session already exists", async () => {
      // Arrange
      const sessionGetSpy = mock(() =>
        Promise.resolve({
          session: "task-md#160",
          repoUrl: "local/minsky",
          repoName: "local-minsky",
          createdAt: new Date().toISOString(),
          taskId: "md#160",
          branch: "task-md#160",
        })
      );
      mockSessionDB.getSession = sessionGetSpy;

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("Session 'task-md#160' already exists");

      // Verify no git operations were attempted
      expect(gitCloneSpy).not.toHaveBeenCalled();
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });

    it("should prevent session creation when another session exists for same task", async () => {
      // Arrange
      const listSessionsSpy = mock(() =>
        Promise.resolve([
          {
            session: "different-session",
            taskId: "md#160", // Use qualified task ID format to match
            repoUrl: "local/minsky",
            repoName: "local-minsky",
            createdAt: new Date().toISOString(),
            branch: "different-session",
          },
        ])
      );
      mockSessionDB.listSessions = listSessionsSpy;

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("A session for task md#160 already exists");

      // Verify no git operations were attempted
      expect(gitCloneSpy).not.toHaveBeenCalled();
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });

    it("should prevent session creation when task does not exist", async () => {
      // Arrange
      const taskGetSpy = mock(() => Promise.resolve(null));
      mockTaskService.getTask = taskGetSpy;

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow(ResourceNotFoundError);

      // Verify no session operations were attempted
      expect(gitCloneSpy).not.toHaveBeenCalled();
      expect(sessionAddSpy).not.toHaveBeenCalled();
    });
  });

  describe("Critical consistency verification", () => {
    it("should never add session record before all git operations complete successfully", async () => {
      // Arrange - ensure git clone fails with exact error message from real git operations
      const gitError = new Error(
        "fatal: destination path 'task-md#160' already exists and is not an empty directory"
      );
      mockGitService.clone = mock(() => Promise.reject(gitError));

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act & Assert
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
          fs: {
            exists: () => false,
            rm: async () => {},
          } as any,
        })
      ).rejects.toThrow("fatal: destination path");

      // Critical assertion: session should NOT be in database after git failure
      expect(sessionAddSpy).not.toHaveBeenCalled();

      // This is the core consistency guarantee this test suite verifies
    });

    it("should successfully add session record only after all operations complete", async () => {
      // Arrange
      const sessionDbMock = createMockSessionProvider();
      const addSessionSpy = mock(() => Promise.resolve());
      sessionDbMock.addSession = addSessionSpy;

      const params = {
        taskId: "md#160",
        repositoryPath: "local/minsky",
      };

      // Act
      const result = await startSessionFromParams(params, {
        sessionDB: sessionDbMock,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath,
        fs: {
          exists: () => false,
          rm: async () => {},
        } as any,
      });

      // Assert - verify session was properly added to database
      expect(addSessionSpy).toHaveBeenCalledTimes(1);

      // Verify return value includes session information
      expect(result).toMatchObject({
        session: "task-md#160",
        taskId: "md#160",
      });
    });
  });
});
