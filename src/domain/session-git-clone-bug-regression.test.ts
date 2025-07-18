/**
 * Regression test for session creation git clone consistency bug
 *
 * This test reproduces the exact scenario that caused the original issue:
 * 1. Git clone fails due to existing directory
 * 2. Verify session record is NOT left in database
 * 3. Verify proper cleanup allows subsequent session creation
 */

import { describe, it, expect } from "bun:test";
import { startSessionFromParams } from "./session";
import { createMock, createPartialMock } from "../utils/test-utils/mocking";
import { createMockSessionProvider, createMockGitService, createMockTaskService } from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";

describe("Session Git Clone Bug Regression Test", () => {
  it("should not leave orphaned session records when git clone fails", async () => {
    // Arrange - Simulate the exact error scenario that caused the bug using centralized factories
    
    // Create trackable spies for methods we need to verify
    const addSessionSpy = createMock();
    addSessionSpy.mockImplementation(() => Promise.resolve(undefined));

    const cloneSpy = createMock();
    cloneSpy.mockImplementation(() => Promise.reject(
      new Error("fatal: destination path 'task#160' already exists and is not an empty directory")
    ));

    const branchSpy = createMock();
    branchSpy.mockImplementation(() => Promise.resolve({ workdir: "/test/sessions/task#160", branch: "task#160" }));

    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy,
      deleteSession: () => Promise.resolve(true),
    });

    // Add getNewSessionRepoPath method not covered by centralized factory
    (mockSessionDB as any).getNewSessionRepoPath = () => "/test/sessions/task#160";

    const mockGitService = createMockGitService({
      clone: cloneSpy,
    });

    // Add branch method not covered by centralized factory
    (mockGitService as any).branch = branchSpy;

    const mockTaskService = createMockTaskService();

    // Add getTask method not covered by centralized factory
    (mockTaskService as any).getTask = () => Promise.resolve({ id: "160", title: "Test Task" });

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
    expect(addSessionSpy).not.toHaveBeenCalled();

    // Verify git clone was attempted but failed before session was added
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(branchSpy).not.toHaveBeenCalled(); // Should not reach branch creation
  });

  it("should successfully create session after fixing git directory issues", async () => {
    // Arrange - Now simulate successful scenario after cleanup

    // Create trackable spies for methods we need to verify
    const addSessionSpy = createMock();
    addSessionSpy.mockImplementation(() => Promise.resolve(undefined));

    const cloneSpy = createMock();
    cloneSpy.mockImplementation(() => Promise.resolve({ workdir: "/test/sessions/task#160", session: "task#160" }));

    const branchSpy = createMock();
    branchSpy.mockImplementation(() => Promise.resolve({ workdir: "/test/sessions/task#160", branch: "task#160" }));

    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy,
      deleteSession: () => Promise.resolve(true),
    });

    // Add getNewSessionRepoPath method not covered by centralized factory
    (mockSessionDB as any).getNewSessionRepoPath = () => "/test/sessions/task#160";

    const mockGitService = createMockGitService({
      clone: cloneSpy,
      branch: branchSpy,
    });

    const mockTaskService = createMockTaskService();

    // Add methods not covered by centralized factory
    (mockTaskService as any).getTask = () => Promise.resolve({ id: "160", title: "Test Task" });
    (mockTaskService as any).getTaskStatus = () => Promise.resolve("TODO");
    (mockTaskService as any).setTaskStatus = () => Promise.resolve(undefined);

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
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(branchSpy).toHaveBeenCalledTimes(1);
    expect(addSessionSpy).toHaveBeenCalledTimes(1);

    // Verify session record has correct data
    expect(addSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "task#160",
        taskId: "#160",
        repoUrl: "local/minsky",
        repoPath: "/test/sessions/task#160",
      })
    );
  });
});
