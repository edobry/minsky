/**
 * Session Update Command Tests
 *
 * Tests for session update command functionality
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { updateSessionFromParams } from "../../../src/domain/session/commands/update-command";
import { createMockGitService } from "../../../src/utils/test-utils/dependencies";
import { withDirectoryIsolation } from "../../../src/utils/test-utils/cleanup-patterns";
import { createSessionTestData, cleanupSessionTestData } from "./session-test-utilities";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import { createMock } from "../../../src/utils/test-utils/core/mock-functions";
import type { SessionTestData } from "./session-test-utilities";
import { SESSION_TEST_PATTERNS } from "../../../src/utils/test-utils/test-constants";
import type { SessionRecord } from "../../../src/domain/session";
import { mockLogger } from "../../../src/utils/test-utils/mock-logger";

describe("session update command", () => {
  let testData: SessionTestData;
  let mockGitService: any;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      promises: {
        mkdir: mockFs.mkdir,
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
      fetchLatest: async (workdir: string) => {
        // Mock successful fetch
        return;
      },
      execInRepository: async (workdir: string, command: string) => {
        if (command.includes("git remote get-url origin")) {
          return "https://github.com/test/repo.git";
        }
        if (command.includes("git checkout")) {
          return "Switched to branch 'new-branch'";
        }
        return "";
      },
    });
  });

  afterEach(() => {
    cleanupSessionTestData(testData);
    // Clean up using mock filesystem
    mockFs.cleanup();
  });

  test("should update session with new branch information", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "test-session");

    // Create the session directory using mock filesystem
    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      name: "test-session",
      taskId: "123",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "old-branch",
      created: new Date().toISOString(),
    };

    // Mock the session database to return our test session
    const mockSessionDB = {
      getSession: () => sessionRecord,
      updateSession: createMock(),
      getSessionWorkdir: createMock(() => sessionPath),
    };

    const result = await updateSessionFromParams(
      {
        sessionName: "test-session",
        branch: "new-branch",
        noPush: true,
      },
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "test-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe("test-session");
    expect(result.branch).toBe("new-branch");
    expect(mockSessionDB.updateSession).toHaveBeenCalled();
  });

  test("should handle session with missing directory", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "missing-session");

    // Create the session directory using mock filesystem
    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      name: "missing-session",
      taskId: "456",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "feature-branch",
      created: new Date().toISOString(),
    };

    const mockSessionDB = {
      getSession: () => sessionRecord,
      updateSession: createMock(),
      getSessionWorkdir: createMock(() => sessionPath),
    };

    const result = await updateSessionFromParams(
      {
        sessionName: "missing-session",
        skipInstall: true,
      },
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "missing-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.name).toBeTruthy();
  });

  test("should handle repository URL detection", async () => {
    const sessionPath = join(
      testData.tempDir,
      "test-repo",
      "sessions",
      SESSION_TEST_PATTERNS.URL_TEST_SESSION
    );

    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      name: SESSION_TEST_PATTERNS.URL_TEST_SESSION,
      taskId: "789",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "main",
      created: new Date().toISOString(),
    };

    // Use directory isolation to mock process.cwd
    const dirIsolation = withDirectoryIsolation();

    const mockSessionDB = {
      getSession: () => sessionRecord,
      updateSession: createMock(),
      getSessionWorkdir: createMock(() => sessionPath),
    };

    const result = await updateSessionFromParams(
      {
        sessionName: SESSION_TEST_PATTERNS.URL_TEST_SESSION,
        autoResolveDeleteConflicts: true,
      },
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => SESSION_TEST_PATTERNS.URL_TEST_SESSION, // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.name).toBeTruthy();

    // dirIsolation.cleanup(); // Not available in this test utility
  });

  test("should handle update with force flag", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "force-session");

    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      name: "force-session",
      taskId: "101112",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "develop",
      created: new Date().toISOString(),
    };

    const mockSessionDB = {
      getSession: () => sessionRecord,
      updateSession: createMock(),
      getSessionWorkdir: createMock(() => sessionPath),
    };

    const result = await updateSessionFromParams(
      {
        sessionName: "force-session",
        force: true,
      },
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "force-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.name).toBeTruthy();
  });

  test("should handle dry run mode", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "dry-run-session");

    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      name: "dry-run-session",
      taskId: "131415",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "staging",
      created: new Date().toISOString(),
    };

    const mockSessionDB = {
      getSession: () => sessionRecord,
      updateSession: createMock(),
      getSessionWorkdir: createMock(() => sessionPath),
    };

    const result = await updateSessionFromParams(
      {
        sessionName: "dry-run-session",
        dryRun: true,
      },
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "dry-run-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.name).toBeTruthy();
    // In dry run mode, updateSession should not be called
    expect(mockSessionDB.updateSession).not.toHaveBeenCalled();
  });
});
