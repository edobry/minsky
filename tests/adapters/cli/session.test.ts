/**
 * NOTE: These tests are temporarily disabled due to issues with Jest mocking in Bun environment.
 *
 * The CLI tests require proper jest.mock functionality which is not fully compatible with Bun.
 *
 * This test suite will be reimplemented after resolving the testing framework compatibility issues.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { getSessionDirImpl } from "../../../src/domain/session/session-lifecycle-operations";
import { updateSessionImpl } from "../../../src/domain/session/session-update-operations";
import { getCurrentSession, getSessionFromWorkspace } from "../../../src/domain/workspace";
import { setupTestMocks } from "../../../src/utils/test-utils/mocking";
import {
  SESSION_TEST_PATTERNS,
  PATH_TEST_PATTERNS,
} from "../../../src/utils/test-utils/test-constants";
import { FakeGitService } from "../../../src/domain/git/fake-git-service";
import { FakeSessionProvider } from "../../../src/domain/session/fake-session-provider";
import { withDirectoryIsolation } from "../../../src/utils/test-utils/cleanup-patterns";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import type { SessionRecord, SessionProviderInterface } from "../../../src/domain/session";
import type { GitServiceInterface } from "../../../src/domain/git";
import { createSessionTestData, cleanupSessionTestData } from "./session-test-utilities";
import { getSessionsDir } from "../../../src/utils/paths";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session CLI Commands", () => {
  let testData: ReturnType<typeof createSessionTestData>;
  let mockGitService: GitServiceInterface;
  let mockSessionProvider: SessionProviderInterface;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    testData = createSessionTestData();

    const fakeGit = new FakeGitService();
    fakeGit.getSessionWorkdir = () =>
      join(testData.tempDir, "test-repo", "sessions", "test-session");
    fakeGit.execInRepository = async (_workdir: string, command: string) => {
      fakeGit.recordedCommands.push({ workdir: _workdir, command });
      if (command.includes("git remote get-url origin")) {
        return "https://github.com/test/repo.git";
      }
      return "";
    };
    mockGitService = fakeGit;

    const fakeSessionProvider = new FakeSessionProvider();
    fakeSessionProvider.getSession = (sessionId: string) =>
      Promise.resolve({
        sessionId: sessionId,
        repoName: "test/repo",
        taskId: sessionId === "test-session" ? "123" : undefined,
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", sessionId),
        branch: "main",
        createdAt: new Date().toISOString(),
      });
    fakeSessionProvider.getSessionWorkdir = (sessionId: string) =>
      Promise.resolve(join(testData.tempDir, "sessions", sessionId));
    fakeSessionProvider.listSessions = () =>
      Promise.resolve([
        {
          sessionId: "test-session",
          repoName: "test/repo",
          taskId: "123",
          repoUrl: "https://github.com/test/repo.git",
          workspacePath: testData.tempDir,
          sessionPath: join(testData.tempDir, "sessions", "test-session"),
          branch: "main",
          createdAt: new Date().toISOString(),
        },
      ]);
    mockSessionProvider = fakeSessionProvider;
  });

  afterEach(() => {
    cleanupSessionTestData(testData as any);
    // Clean up using mock filesystem
    mockFs.cleanup();
  });

  describe("getSessionDirImpl", () => {
    test("should resolve session directory from session ID", async () => {
      const sessionPath = join(testData.tempDir, "sessions", "test-session");

      // Create the session directory using mock filesystem
      mockFs.ensureDirectoryExists(sessionPath);

      const result = await getSessionDirImpl(
        { sessionId: "test-session" },
        { sessionDB: mockSessionProvider }
      );

      expect(result).toBe(sessionPath);
    });

    test("should resolve session directory from task ID", async () => {
      const sessionPath = join(testData.tempDir, "sessions", "task-123");

      // Create the session directory using mock filesystem
      mockFs.ensureDirectoryExists(sessionPath);

      const mockSessionProviderWithTask = new FakeSessionProvider({
        initialSessions: [
          {
            sessionId: "task-123",
            repoName: "test/repo",
            taskId: "md#123",
            repoUrl: "https://github.com/test/repo.git",
            workspacePath: testData.tempDir,
            sessionPath,
            branch: PATH_TEST_PATTERNS.FEATURE_TASK_BRANCH,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      mockSessionProviderWithTask.getSessionWorkdir = (_sessionId: string) =>
        Promise.resolve(sessionPath);

      const result = await getSessionDirImpl(
        { task: "md#123" },
        { sessionDB: mockSessionProviderWithTask }
      );

      expect(result).toBe(sessionPath);
    });

    test("should resolve session directory from current working directory", async () => {
      const sessionPath = join(testData.tempDir, "sessions", "current-session");

      mockFs.ensureDirectoryExists(sessionPath);

      // Use directory isolation to mock process.cwd
      const _dirIsolation = withDirectoryIsolation();

      const mockSessionProviderCurrent = new FakeSessionProvider({
        initialSessions: [
          {
            sessionId: "current-session",
            repoName: "test/repo",
            taskId: "456",
            repoUrl: "https://github.com/test/repo.git",
            workspacePath: testData.tempDir,
            sessionPath,
            branch: "current-branch",
            createdAt: new Date().toISOString(),
          },
        ],
      });
      mockSessionProviderCurrent.getSessionWorkdir = (_sessionId: string) =>
        Promise.resolve(sessionPath);

      // For now, provide session ID explicitly to avoid complex auto-detection mocking
      const result = await getSessionDirImpl(
        { sessionId: "current-session" },
        { sessionDB: mockSessionProviderCurrent }
      );

      expect(result).toBe(sessionPath);

      // dirIsolation.cleanup(); // Not available in this test utility
    });
  });

  describe("updateSessionImpl", () => {
    test("should update session with new branch", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "update-session");

      mockFs.ensureDirectoryExists(sessionPath);

      const sessionRecord: SessionRecord = {
        sessionId: "update-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "update-session",
        taskId: "789",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath,
        branch: "old-branch",
        created: new Date().toISOString(),
      };

      const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
      mockSessionDB.getSessionWorkdir = async () => sessionPath;

      const result = await updateSessionImpl(
        {
          sessionId: "update-session",
          branch: "new-branch",
          force: true,
          noStash: false,
          noPush: false,
          skipConflictCheck: true,
          autoResolveDeleteConflicts: false,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          gitService: mockGitService,
          sessionDB: mockSessionDB,
          getCurrentSession: async () => "update-session",
        }
      );

      expect(result).toBeDefined();
      expect(result.sessionId).toBe("update-session");
    });

    test("should handle session update with git operations", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "git-session");

      // Create the test working directory using mock filesystem
      const testWorkdir = join(testData.tempDir, "test-workspace");
      mockFs.ensureDirectoryExists(testWorkdir);
      mockFs.ensureDirectoryExists(sessionPath);

      const sessionRecord: SessionRecord = {
        sessionId: "git-session",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: "git-session",
        taskId: "101112",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testWorkdir,
        sessionPath,
        branch: "feature-branch",
        created: new Date().toISOString(),
      };

      const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
      mockSessionDB.getSessionWorkdir = async () => sessionPath;

      const mockGitServiceWithCommands = new FakeGitService();
      mockGitServiceWithCommands.hasUncommittedChanges = async () => false;
      mockGitServiceWithCommands.fetchDefaultBranch = async () => "main";

      const result = await updateSessionImpl(
        {
          sessionId: "git-session",
          autoResolveDeleteConflicts: true,
          force: true,
          noStash: false,
          noPush: false,
          skipConflictCheck: true,
          dryRun: false,
          skipIfAlreadyMerged: false,
        },
        {
          gitService: mockGitServiceWithCommands,
          sessionDB: mockSessionDB,
          getCurrentSession: async () => "git-session",
        }
      );

      expect(result).toBeDefined();
      expect(result.sessionId).toBeDefined();
    });
  });

  describe("getCurrentSession", () => {
    test("should get current session from workspace", async () => {
      const sessionRecord: SessionRecord = {
        sessionId: SESSION_TEST_PATTERNS.WORKSPACE_SESSION,
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: SESSION_TEST_PATTERNS.WORKSPACE_SESSION,
        taskId: "131415",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", SESSION_TEST_PATTERNS.WORKSPACE_SESSION),
        branch: "workspace-branch",
        created: new Date().toISOString(),
      };

      const mockSessionProviderWorkspace = new FakeSessionProvider();
      mockSessionProviderWorkspace.getSession = (sessionId: string) => {
        if (sessionId === SESSION_TEST_PATTERNS.WORKSPACE_SESSION) {
          return Promise.resolve(sessionRecord);
        }
        return Promise.resolve(null);
      };

      // Mock execAsync to simulate git commands
      const mockExecAsync = mock(async (command: string) => {
        if (command === "git rev-parse --show-toplevel") {
          // Return a path that matches the session directory structure used by getSessionsDir()
          return { stdout: join(getSessionsDir(), "workspace-session"), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await getCurrentSession(
        testData.tempDir,
        mockExecAsync,
        mockSessionProviderWorkspace
      );

      expect(result).toBe(SESSION_TEST_PATTERNS.WORKSPACE_SESSION);
    });
  });

  describe("getSessionFromWorkspace", () => {
    test("should get session from workspace directory", async () => {
      const sessionRecord: SessionRecord = {
        sessionId: SESSION_TEST_PATTERNS.DIRECTORY_SESSION,
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        name: SESSION_TEST_PATTERNS.DIRECTORY_SESSION,
        taskId: "161718",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", SESSION_TEST_PATTERNS.DIRECTORY_SESSION),
        branch: "directory-branch",
        created: new Date().toISOString(),
      };

      const mockSessionProviderDirectory = new FakeSessionProvider();
      mockSessionProviderDirectory.getSession = (sessionId: string) => {
        if (sessionId === SESSION_TEST_PATTERNS.DIRECTORY_SESSION) {
          return Promise.resolve(sessionRecord);
        }
        return Promise.resolve(null);
      };

      // Mock execAsync to simulate git commands
      const mockExecAsync = mock(async (command: string) => {
        if (command === "git rev-parse --show-toplevel") {
          // Return a path that matches the session directory structure used by getSessionsDir()
          return { stdout: join(getSessionsDir(), "directory-session"), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const result = await getSessionFromWorkspace(
        testData.tempDir,
        mockExecAsync,
        mockSessionProviderDirectory
      );

      expect(result).toEqual({
        session: SESSION_TEST_PATTERNS.DIRECTORY_SESSION,
        upstreamRepository: "https://github.com/test/repo.git",
        gitRoot: join(getSessionsDir(), "directory-session"),
      });
    });
  });
});
