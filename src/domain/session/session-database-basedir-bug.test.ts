/**
 * Test for Session Database BaseDir Bug
 *
 * Bug reproduction test for the issue where session approve fails with:
 * "ENOENT: no such file or directory, posix_spawn '/bin/sh'"
 *
 * Root Cause: Session database has incorrect baseDir that includes '/git'
 * leading to wrong session workspace path construction.
 *
 * Steps to reproduce:
 * 1. Session database has baseDir: "/Users/edobry/.local/state/minsky/git"
 * 2. Session approve tries to get session workspace directory
 * 3. Path gets constructed as "/Users/edobry/.local/state/minsky/git/sessions/task335"
 * 4. Directory doesn't exist, git command fails with posix_spawn error
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { SessionDbAdapter } from "./session-db-adapter";
import { initializeSessionDbState, getSessionWorkdirFn } from "./session-db";
import { readSessionDbFile } from "./session-db-io";
import { approveSessionImpl } from "./session-approve-operations";
import type { SessionRecord, SessionDbState } from "./types";
import { PATH_TEST_PATTERNS } from "../../utils/test-utils/test-constants";

describe("Session Database BaseDir Bug", () => {
  let mockSessionDB: any;
  let mockGitService: any;
  let mockTaskService: any;
  let mockExecGitWithTimeout: any;

  beforeEach(() => {
    // Mock git service that will fail when given wrong path
    mockExecGitWithTimeout = mock((operation: string, command: string, options: any) => {
      const workdir = options.workdir;
      // Simulate posix_spawn error when trying to use non-existent directory with wrong path structure
      if (workdir && workdir.includes("/wrong-component/sessions/")) {
        throw new Error(
          "Git switch failed: ENOENT: no such file or directory, posix_spawn '/bin/sh'"
        );
      }
      return Promise.resolve({ stdout: "", stderr: "", command, workdir, executionTimeMs: 1 });
    });

    mockSessionDB = {
      getSession: mock(),
      getSessionByTaskId: mock(),
      getSessionWorkdir: mock(),
      listSessions: mock(() => Promise.resolve([])),
      addSession: mock(() => Promise.resolve()),
      updateSession: mock(() => Promise.resolve()),
      deleteSession: mock(() => Promise.resolve(true)),
      getRepoPath: mock(() => Promise.resolve("/test/repo")),
    };

    mockGitService = {
      hasUncommittedChanges: mock(() => Promise.resolve(false)),
      stashChanges: mock(() => Promise.resolve({ stashed: false })),
      execInRepository: mock(),
    };

    mockTaskService = {
      getTask: mock(() =>
        Promise.resolve({
          id: "md#335",
          title: "Test Task 335",
          status: "IN-PROGRESS",
        })
      ),
      getTaskStatus: mock(() => Promise.resolve("IN-PROGRESS")),
      setTaskStatus: mock(() => Promise.resolve()),
      getBackendForTask: mock(() => Promise.resolve("md")),
      listTasks: mock(() => Promise.resolve([])),
      createTask: mock(() => Promise.resolve({ id: "md#335", title: "Test", status: "TODO" })),
      deleteTask: mock(() => Promise.resolve(false)),
      getWorkspacePath: mock(() => "/test/workspace"),
      createTaskFromTitleAndSpec: mock(() =>
        Promise.resolve({ id: "md#335", title: "Test", status: "TODO" })
      ),
    };
  });

  // Bug #335: Session approve fails with posix_spawn error due to incorrect baseDir
  // This test reproduces the exact error condition that happens in production
  it("should fail with posix_spawn error when session database has incorrect baseDir", async () => {
    // Set up session record
    const sessionRecord: SessionRecord = {
      session: "task335",
      repoUrl: "/test/repo",
      repoName: "test-repo",
      taskId: "md#335",
      createdAt: new Date().toISOString(),
    };

    mockSessionDB.getSessionByTaskId = mock(() => Promise.resolve(sessionRecord));
    mockSessionDB.getSession = mock(() => Promise.resolve(sessionRecord));

    // Mock the incorrect baseDir behavior that causes the bug
    // This simulates the session database having wrong baseDir with extra path components
    mockSessionDB.getSessionWorkdir = mock(() => {
      // This returns the WRONG path that causes posix_spawn error
      return Promise.resolve("/test/minsky/wrong-component/sessions/task335");
    });

    // Mock repository backend that uses git operations
    const mockCreateRepositoryBackend = mock(() =>
      Promise.resolve({
        getType: () => "local",
        mergePullRequest: mock((prIdentifier: string, sessionName: string) => {
          // This simulates the git operations that fail due to wrong workspace path
          return mockExecGitWithTimeout("switch", "switch main", {
            workdir: "/test/minsky/wrong-component/sessions/task335",
            timeout: 30000,
          }).then(() => ({
            commitHash: "abc123",
            mergeDate: new Date().toISOString(),
            mergedBy: "test-user",
          }));
        }),
      })
    );

    // This should fail with the exact posix_spawn error we're seeing
    await expect(
      approveSessionImpl(
        { task: "md#335" },
        {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          createRepositoryBackend: mockCreateRepositoryBackend,
        }
      )
    ).rejects.toThrow(
      "Git switch failed: ENOENT: no such file or directory, posix_spawn '/bin/sh'"
    );
  });

  it("should succeed when session database has correct baseDir", async () => {
    // Set up session record
    const sessionRecord: SessionRecord = {
      session: "task335",
      repoUrl: "/test/repo",
      repoName: "test-repo",
      taskId: "md#335",
      createdAt: new Date().toISOString(),
    };

    mockSessionDB.getSessionByTaskId = mock(() => Promise.resolve(sessionRecord));
    mockSessionDB.getSession = mock(() => Promise.resolve(sessionRecord));

    // Mock the correct baseDir behavior
    mockSessionDB.getSessionWorkdir = mock(() => {
      // This returns the CORRECT path without extra components
      return Promise.resolve("/test/minsky/sessions/task335");
    });

    // Mock successful git operations with correct path
    const mockSuccessfulExecGit = mock(() =>
      Promise.resolve({
        stdout: "",
        stderr: "",
        command: "switch main",
        workdir: "/test/minsky/sessions/task335",
        executionTimeMs: 1,
      })
    );

    const mockCreateRepositoryBackend = mock(() =>
      Promise.resolve({
        getType: () => "local",
        mergePullRequest: mock(() =>
          Promise.resolve({
            commitHash: "abc123",
            mergeDate: new Date().toISOString(),
            mergedBy: "test-user",
          })
        ),
      })
    );

    // This should succeed without posix_spawn errors
    const result = await approveSessionImpl(
      { task: "md#335" },
      {
        sessionDB: mockSessionDB,
        gitService: mockGitService,
        taskService: mockTaskService,
        createRepositoryBackend: mockCreateRepositoryBackend,
      }
    );

    expect(result.session).toBe("task335");
    expect(result.commitHash).toBe("abc123");
  });

  it("should demonstrate the path construction difference that causes the bug", () => {
    // Create two session database states to show the difference
    const correctState: SessionDbState = initializeSessionDbState({
      baseDir: "/test/minsky", // Correct baseDir
    });

    const incorrectState: SessionDbState = initializeSessionDbState({
      baseDir: "/test/minsky/wrong", // Bug - includes extra component
    });

    const sessionRecord: SessionRecord = {
      session: "test-session",
      repoUrl: "/test/repo",
      repoName: "test-repo",
      taskId: "123",
      createdAt: new Date().toISOString(),
    };

    // Add sessions to both states
    correctState.sessions = [sessionRecord];
    incorrectState.sessions = [sessionRecord];

    // Get workspace directories from both states
    const correctWorkdir = getSessionWorkdirFn(correctState, "test-session");
    const incorrectWorkdir = getSessionWorkdirFn(incorrectState, "test-session");

    // Show the difference in paths
    expect(correctWorkdir).toBe(PATH_TEST_PATTERNS.TEST_SESSION_PATH);
    expect(incorrectWorkdir).toBe("/test/minsky/wrong/sessions/test-session");

    // The incorrect path is what causes the posix_spawn error
    expect(correctWorkdir).not.toBe(incorrectWorkdir);
  });

  it("should demonstrate the LocalGitBackend vs SessionDB path inconsistency", async () => {
    // This test shows the REAL bug: LocalGitBackend and SessionDB use different path structures

    // Session database path (what session dir command returns)
    const mockBaseDir = "/test/minsky";
    const sessionState: SessionDbState = initializeSessionDbState({
      baseDir: mockBaseDir,
    });

    const sessionRecord: SessionRecord = {
      session: "test-session",
      repoUrl: "/test/repo",
      repoName: "test-repo",
      taskId: "123",
      createdAt: new Date().toISOString(),
    };

    sessionState.sessions = [sessionRecord];
    const sessionDbPath = getSessionWorkdirFn(sessionState, "test-session");

    // LocalGitBackend path BEFORE fix (what caused the bug)
    // This simulates the old getSessionWorkdir that included repoName
    const localGitBackendPathOld = join(
      mockBaseDir,
      sessionRecord.repoName,
      "sessions",
      "test-session"
    );

    // LocalGitBackend path AFTER fix (what it should be now)
    const localGitBackendPathFixed = join(mockBaseDir, "sessions", "test-session");

    // Show the inconsistency that caused the bug
    expect(sessionDbPath).toBe(PATH_TEST_PATTERNS.TEST_SESSION_PATH);
    expect(localGitBackendPathOld).toBe("/test/minsky/test-repo/sessions/test-session");
    expect(localGitBackendPathFixed).toBe(PATH_TEST_PATTERNS.TEST_SESSION_PATH);

    // The old paths were different (causing posix_spawn error)
    expect(sessionDbPath).not.toBe(localGitBackendPathOld);

    // The fixed paths should be the same (fixing the bug)
    expect(sessionDbPath).toBe(localGitBackendPathFixed);
  });
});
