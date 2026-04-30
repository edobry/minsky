/**
 * Regression test for session creation git clone consistency bug
 *
 * This test reproduces the exact scenario that caused the original issue:
 * 1. Git clone fails due to existing directory
 * 2. Verify session record is NOT left in database
 * 3. Verify proper cleanup allows subsequent session creation
 */

import { describe, it, expect, mock } from "bun:test";
import { first } from "../utils/array-safety";
import { startSessionImpl } from "./session/start-session-operations";
import type { SessionStartParameters } from "./schemas";
import { TEST_PATHS } from "../utils/test-utils/test-constants";
import { FakeSessionProvider } from "./session/fake-session-provider";
import { FakeTaskService } from "./tasks/fake-task-service";
import { FakeGitService } from "./git/fake-git-service";
import { FakeWorkspaceUtils } from "./workspace/fake-workspace-utils";
import { RepositoryBackendType } from "./repository/index";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("Session Git Clone Bug Regression Test", () => {
  it("should not leave orphaned session records when git clone fails", async () => {
    // Arrange - Simulate the exact error scenario that caused the bug using centralized factories

    // Create trackable spies for methods we need to verify
    const addSessionSpy = mock(() => Promise.resolve());

    const cloneSpy = mock(() =>
      Promise.reject(
        new Error(
          `fatal: destination path '${TEST_UUID}' already exists and is not an empty directory`
        )
      )
    );

    const branchSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task/md-160" })
    );

    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.addSession = addSessionSpy;

    const fakeGitService1 = new FakeGitService();
    fakeGitService1.clone = cloneSpy;
    fakeGitService1.branchWithoutSession = branchSpy;
    fakeGitService1.branch = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task/md-160" })
    );
    fakeGitService1.execInRepository = mock(() => Promise.resolve(""));
    fakeGitService1.getSessionWorkdir = mock(() => TEST_PATHS.SESSION_MD_160);
    const mockGitService = fakeGitService1;

    const mockTaskService = new FakeTaskService({
      initialTasks: [{ id: "md#160", title: "Test Task", status: "READY" }],
    });

    // Create workspace utils mock with all required methods
    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const params = {
      task: "md#160",
      repo: "https://github.com/edobry/minsky.git",
      // name will be auto-generated from task
    };

    // Act & Assert - Git clone failure should not leave session in database
    await expect(
      startSessionImpl(params as unknown as SessionStartParameters, {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        workspaceUtils: mockWorkspaceUtils,
        getRepositoryBackend: async () => ({
          repoUrl: "https://github.com/edobry/minsky.git",
          backendType: RepositoryBackendType.GITHUB,
          github: { owner: "edobry", repo: "minsky" },
        }),
      })
    ).rejects.toThrow(`destination path '${TEST_UUID}' already exists`);

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
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, session: TEST_UUID })
    );

    const branchSpy = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task/md-160" })
    );

    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.addSession = addSessionSpy;

    const fakeGitService2 = new FakeGitService();
    fakeGitService2.clone = cloneSpy;
    fakeGitService2.branchWithoutSession = branchSpy;
    fakeGitService2.branch = mock(() =>
      Promise.resolve({ workdir: TEST_PATHS.SESSION_MD_160, branch: "task/md-160" })
    );
    fakeGitService2.execInRepository = mock(() => Promise.resolve(""));
    fakeGitService2.getSessionWorkdir = mock(() => TEST_PATHS.SESSION_MD_160);
    const mockGitService = fakeGitService2;

    const mockTaskService = new FakeTaskService({
      initialTasks: [{ id: "md#160", title: "Test Task", status: "READY" }],
    });

    // Create workspace utils mock with all required methods
    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const params = {
      task: "md#160",
      repo: "https://github.com/edobry/minsky.git",
      // name will be auto-generated from task
    };

    // Act
    const result = await startSessionImpl(params as unknown as SessionStartParameters, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getRepositoryBackend: async () => ({
        repoUrl: "https://github.com/edobry/minsky.git",
        backendType: RepositoryBackendType.GITHUB,
        github: { owner: "edobry", repo: "minsky" },
      }),
    });

    // Assert - Session should be created successfully
    expect(result).toMatchObject({
      taskId: "md#160",
      repoName: "edobry-minsky",
      repoUrl: "https://github.com/edobry/minsky.git",
    });
    // Session ID is now a UUID
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    // Verify proper order: git operations first, then session record
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(branchSpy).toHaveBeenCalledTimes(1);
    expect(addSessionSpy).toHaveBeenCalledTimes(1);

    // Verify session record has correct data (session ID is a UUID now)
    expect(addSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "md#160",
        repoUrl: "https://github.com/edobry/minsky.git",
        repoName: "edobry/minsky",
      })
    );
    // Verify the session ID in the record is a UUID
    const addedRecord = first(addSessionSpy.mock.calls as unknown[][])[0] as any;
    expect(addedRecord.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});
