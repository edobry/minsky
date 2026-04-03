/**
 * Regression test for session creation git clone consistency bug
 *
 * This test reproduces the exact scenario that caused the original issue:
 * 1. Git clone fails due to existing directory
 * 2. Verify session record is NOT left in database
 * 3. Verify proper cleanup allows subsequent session creation
 */

import { describe, it, expect, mock } from "bun:test";
import { startSessionFromParams } from "./session";
import { createPartialMock } from "../utils/test-utils/mocking";
import { TEST_PATHS } from "../utils/test-utils/test-constants";
import { createMockSessionProvider, createMockTaskService } from "../utils/test-utils/dependencies";
import type { GitServiceInterface } from "./git";
import type { WorkspaceUtilsInterface } from "./workspace";

describe("Session Git Clone Bug Regression Test", () => {
  it("should not leave orphaned session records when git clone fails", async () => {
    // Arrange - Simulate the exact error scenario that caused the bug using centralized factories

    // Create trackable spies for methods we need to verify
    const addSessionSpy = mock(() => Promise.resolve());

    const cloneSpy = mock(() =>
      Promise.reject(
        new Error(
          "fatal: destination path 'task-md#160' already exists and is not an empty directory"
        )
      )
    );

    const branchSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" })
    );

    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy,
      deleteSession: () => Promise.resolve(true),
    });

    const mockGitService = createPartialMock<GitServiceInterface>({
      clone: cloneSpy,
      branchWithoutSession: branchSpy,
      branch: mock(() =>
        Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" })
      ),
      execInRepository: mock(() => Promise.resolve("")),
      getSessionWorkdir: mock(() => TEST_PATHS.SESSION_MD_160),
    });

    const mockTaskService = createMockTaskService({
      getTask: () => Promise.resolve({ id: "md#160", title: "Test Task", status: "TODO" }),
    });

    // Create workspace utils mock with all required methods
    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isWorkspace: () => Promise.resolve(true),
      isSessionWorkspace: () => false,
      getCurrentSession: () => Promise.resolve(undefined),
      getSessionFromWorkspace: () => Promise.resolve(undefined),
      resolveWorkspacePath: () => Promise.resolve("/mock/workspace"),
    });

    const mockResolveRepoPath = () => Promise.resolve("local/minsky");

    const params = {
      task: "md#160",
      repo: "local/minsky",
      // name will be auto-generated from task
    };

    // Act & Assert - Git clone failure should not leave session in database
    await expect(
      startSessionFromParams(params as any, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        resolveRepoPath: mockResolveRepoPath as any,
      })
    ).rejects.toThrow("destination path 'task-md#160' already exists");

    // Critical assertion: NO session record should be added to database
    expect(addSessionSpy).not.toHaveBeenCalled();

    // Verify git clone was attempted but failed before session was added
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(branchSpy).not.toHaveBeenCalled(); // Should not reach branch creation
  });

  it("should successfully create session after fixing git directory issues", async () => {
    // Arrange - Now simulate successful scenario after cleanup

    // Create trackable spies for methods we need to verify
    const addSessionSpy = mock(() => Promise.resolve()) as ReturnType<typeof mock> & {
      mock: { calls: any[][] };
    };

    const cloneSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, session: "task-md#160" })
    );

    const branchSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" })
    );

    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy,
      deleteSession: () => Promise.resolve(true),
    });

    const mockGitService = createPartialMock<GitServiceInterface>({
      clone: cloneSpy,
      branchWithoutSession: branchSpy,
      branch: mock(() =>
        Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task-md#160" })
      ),
      execInRepository: mock(() => Promise.resolve("")),
      getSessionWorkdir: mock(() => TEST_PATHS.SESSION_MD_160),
    });

    const mockTaskService = createMockTaskService({
      getTask: () => Promise.resolve({ id: "md#160", title: "Test Task", status: "TODO" }),
      getTaskStatus: () => Promise.resolve("TODO"),
      setTaskStatus: () => Promise.resolve(),
    });

    // Create workspace utils mock with all required methods
    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isWorkspace: () => Promise.resolve(true),
      isSessionWorkspace: () => false,
      getCurrentSession: () => Promise.resolve(undefined),
      getSessionFromWorkspace: () => Promise.resolve(undefined),
      resolveWorkspacePath: () => Promise.resolve("/mock/workspace"),
    });

    const mockResolveRepoPath = () => Promise.resolve("local/minsky");

    const params = {
      task: "md#160",
      repo: "local/minsky",
      // name will be auto-generated from task
    };

    // Act
    const result = await startSessionFromParams(params as any, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      resolveRepoPath: mockResolveRepoPath as any,
    });

    // Assert - Session should be created successfully
    expect(result).toMatchObject({
      taskId: "md#160",
      repoName: "local-minsky",
      repoUrl: "local/minsky",
    });
    // Session name is now a UUID
    expect(result.session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // Verify proper order: git operations first, then session record
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(branchSpy).toHaveBeenCalledTimes(1);
    expect(addSessionSpy).toHaveBeenCalledTimes(1);

    // Verify session record has correct data (session name is a UUID now)
    expect(addSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "md#160",
        repoUrl: "local/minsky",
        repoName: "local/minsky",
      })
    );
    // Verify the session name in the record is a UUID
    const addedRecord = addSessionSpy.mock.calls[0]![0] as any;
    expect(addedRecord.session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});
