/**
 * NOTE: These tests are temporarily disabled due to issues with Jest mocking in Bun environment.
 *
 * The CLI tests require proper jest.mock functionality which is not fully compatible with Bun.
 *
 * This test suite will be reimplemented after resolving the testing framework compatibility issues.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { getSessionDirFromParams, updateSessionFromParams } from "../../../src/domain/session";
import { getCurrentSession, getSessionFromWorkspace } from "../../../src/domain/workspace";
import { createMock, setupTestMocks } from "../../../src/utils/test-utils/mocking";
import {
  createMockGitService,
  createMockSessionProvider,
} from "../../../src/utils/test-utils/dependencies";
import { withDirectoryIsolation } from "../../../src/utils/test-utils/cleanup-patterns";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import type { SessionRecord, SessionProviderInterface } from "../../../src/domain/session";
import type { GitServiceInterface } from "../../../src/domain/git";
import { createSessionTestData, cleanupSessionTestData } from "./session-test-utilities";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session CLI Commands", () => {
  let testData: any;
  let mockGitService: GitServiceInterface;
  let mockSessionProvider: SessionProviderInterface;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      promises: {
        mkdir: mockFs.mkdir,
        rmdir: mockFs.rmdir,
        rm: mockFs.rm,
        readFile: mockFs.readFile,
        writeFile: mockFs.writeFile,
        readdir: mockFs.readdir,
        stat: mockFs.stat,
      },
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
      rmSync: mockFs.rmSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
    }));

    testData = createSessionTestData();

    mockGitService = createMockGitService({
      getSessionWorkdir: () => join(testData.tempDir, "test-repo", "sessions", "test-session"),
      execInRepository: async (workdir: string, command: string) => {
        if (command.includes("git remote get-url origin")) {
          return "https://github.com/test/repo.git";
        }
        return "";
      },
    });

    mockSessionProvider = createMockSessionProvider({
      getSession: () => ({
        name: "test-session",
        taskId: "123",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", "test-session"),
        branch: "main",
        created: new Date().toISOString(),
      }),
    });
  });

  afterEach(() => {
    cleanupSessionTestData(testData);
    // Clean up using mock filesystem
    mockFs.cleanup();
  });

  describe("getSessionDirFromParams", () => {
    test("should resolve session directory from session name", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "test-session");

      // Create the session directory using mock filesystem
      mockFs.ensureDirectoryExists(sessionPath);

      const result = await getSessionDirFromParams(
        { sessionName: "test-session" },
        { sessionProvider: mockSessionProvider }
      );

      expect(result.sessionPath).toBe(sessionPath);
      expect(result.sessionName).toBe("test-session");
    });

    test("should resolve session directory from task ID", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "task-123");

      // Create the session directory using mock filesystem
      mockFs.ensureDirectoryExists(sessionPath);

      const mockSessionProviderWithTask = createMockSessionProvider({
        getSessionFromTask: () => ({
          name: "task-123",
          taskId: "123",
          repoUrl: "https://github.com/test/repo.git",
          workspacePath: testData.tempDir,
          sessionPath,
          branch: "feature/task-123",
          created: new Date().toISOString(),
        }),
      });

      const result = await getSessionDirFromParams(
        { task: "123" },
        { sessionProvider: mockSessionProviderWithTask }
      );

      expect(result.sessionPath).toBe(sessionPath);
      expect(result.sessionName).toBe("task-123");
    });

    test("should resolve session directory from current working directory", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "current-session");

      mockFs.ensureDirectoryExists(sessionPath);

      // Use directory isolation to mock process.cwd
      const dirIsolation = withDirectoryIsolation();

      const mockSessionProviderCurrent = createMockSessionProvider({
        getCurrentSession: () => ({
          name: "current-session",
          taskId: "456",
          repoUrl: "https://github.com/test/repo.git",
          workspacePath: testData.tempDir,
          sessionPath,
          branch: "current-branch",
          created: new Date().toISOString(),
        }),
      });

      const result = await getSessionDirFromParams(
        {},
        { sessionProvider: mockSessionProviderCurrent }
      );

      expect(result.sessionPath).toBe(sessionPath);
      expect(result.sessionName).toBe("current-session");

      dirIsolation.cleanup();
    });
  });

  describe("updateSessionFromParams", () => {
    test("should update session with new branch", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "update-session");

      mockFs.ensureDirectoryExists(sessionPath);

      const sessionRecord: SessionRecord = {
        name: "update-session",
        taskId: "789",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath,
        branch: "old-branch",
        created: new Date().toISOString(),
      };

      const mockSessionDB = {
        getSession: () => sessionRecord,
        updateSession: mock.fn(),
      };

      const result = await updateSessionFromParams(
        {
          sessionName: "update-session",
          branch: "new-branch",
        },
        {
          gitService: mockGitService,
          sessionDB: mockSessionDB,
        }
      );

      expect(result.success).toBe(true);
      expect(mockSessionDB.updateSession).toHaveBeenCalledWith("update-session", {
        ...sessionRecord,
        branch: "new-branch",
      });
    });

    test("should handle session update with git operations", async () => {
      const sessionPath = join(testData.tempDir, "test-repo", "sessions", "git-session");

      // Create the test working directory using mock filesystem
      const testWorkdir = join(testData.tempDir, "test-workspace");
      mockFs.ensureDirectoryExists(testWorkdir);
      mockFs.ensureDirectoryExists(sessionPath);

      const sessionRecord: SessionRecord = {
        name: "git-session",
        taskId: "101112",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testWorkdir,
        sessionPath,
        branch: "feature-branch",
        created: new Date().toISOString(),
      };

      const mockSessionDB = {
        getSession: () => sessionRecord,
        updateSession: mock.fn(),
      };

      const mockGitServiceWithCommands = createMockGitService({
        getSessionWorkdir: () => sessionPath,
        execInRepository: async (workdir: string, command: string) => {
          if (command.includes("git remote get-url origin")) {
            return "https://github.com/test/repo.git";
          }
          if (command.includes("git status")) {
            return "nothing to commit, working tree clean";
          }
          return "";
        },
      });

      const result = await updateSessionFromParams(
        {
          sessionName: "git-session",
          autoResolveDeleteConflicts: true,
        },
        {
          gitService: mockGitServiceWithCommands,
          sessionDB: mockSessionDB,
        }
      );

      expect(result.success).toBe(true);
    });
  });

  describe("getCurrentSession", () => {
    test("should get current session from workspace", async () => {
      const sessionRecord: SessionRecord = {
        name: "workspace-session",
        taskId: "131415",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", "workspace-session"),
        branch: "workspace-branch",
        created: new Date().toISOString(),
      };

      const mockSessionProviderWorkspace = createMockSessionProvider({
        getCurrentSession: () => sessionRecord,
      });

      const result = await getCurrentSession({ sessionProvider: mockSessionProviderWorkspace });

      expect(result).toEqual(sessionRecord);
    });
  });

  describe("getSessionFromWorkspace", () => {
    test("should get session from workspace directory", async () => {
      const sessionRecord: SessionRecord = {
        name: "directory-session",
        taskId: "161718",
        repoUrl: "https://github.com/test/repo.git",
        workspacePath: testData.tempDir,
        sessionPath: join(testData.tempDir, "sessions", "directory-session"),
        branch: "directory-branch",
        created: new Date().toISOString(),
      };

      const mockSessionProviderDirectory = createMockSessionProvider({
        getSessionFromWorkspace: () => sessionRecord,
      });

      const result = await getSessionFromWorkspace(testData.tempDir, {
        sessionProvider: mockSessionProviderDirectory,
      });

      expect(result).toEqual(sessionRecord);
    });
  });
});
