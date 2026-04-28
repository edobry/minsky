/**
 * Session Update Command Tests
 *
 * Tests for session update command functionality
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { updateSessionImpl } from "../../../src/domain/session/session-update-operations";
import { FakeGitService } from "../../../src/domain/git/fake-git-service";
import { withDirectoryIsolation } from "../../../src/utils/test-utils/cleanup-patterns";
import { createSessionTestData, cleanupSessionTestData } from "./session-test-utilities";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import type { SessionTestData } from "./session-test-utilities";
import { SESSION_TEST_PATTERNS } from "../../../src/utils/test-utils/test-constants";
import type { SessionRecord } from "../../../src/domain/session";
import { FakeSessionProvider } from "../../../src/domain/session/fake-session-provider";

describe("session update command", () => {
  let testData: SessionTestData;
  let mockGitService: FakeGitService;
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    testData = createSessionTestData();

    mockGitService = new FakeGitService();
    mockGitService.hasUncommittedChanges = async () => false;
    mockGitService.fetchDefaultBranch = async () => "main";
  });

  afterEach(() => {
    cleanupSessionTestData(testData.tempDir);
    // Clean up using mock filesystem
    mockFs.cleanup();
  });

  test("should update session with new branch information", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "test-session");

    // Create the session directory using mock filesystem
    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      sessionId: "test-session",
      repoName: "test/repo",
      createdAt: new Date().toISOString(),
      name: "test-session",
      taskId: "123",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "old-branch",
      created: new Date().toISOString(),
    };

    // Mock the session database to return our test session
    const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    mockSessionDB.getSessionWorkdir = async () => sessionPath;

    const result = await updateSessionImpl(
      {
        name: "test-session",
        branch: "new-branch",
        noPush: true,
        force: true,
      } as any,
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "test-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.sessionId).toBe("test-session");
  });

  test("should handle session with missing directory", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "missing-session");

    // Create the session directory using mock filesystem
    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      sessionId: "missing-session",
      repoName: "test/repo",
      createdAt: new Date().toISOString(),
      name: "missing-session",
      taskId: "456",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "feature-branch",
      created: new Date().toISOString(),
    };

    const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    mockSessionDB.getSessionWorkdir = async () => sessionPath;

    const result = await updateSessionImpl(
      {
        name: "missing-session",
        force: true,
      } as any,
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "missing-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.sessionId).toBeTruthy();
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
      sessionId: SESSION_TEST_PATTERNS.URL_TEST_SESSION,
      repoName: "test/repo",
      createdAt: new Date().toISOString(),
      name: SESSION_TEST_PATTERNS.URL_TEST_SESSION,
      taskId: "789",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "main",
      created: new Date().toISOString(),
    };

    // Use directory isolation to mock process.cwd
    const _dirIsolation = withDirectoryIsolation();

    const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    mockSessionDB.getSessionWorkdir = async () => sessionPath;

    const result = await updateSessionImpl(
      {
        name: SESSION_TEST_PATTERNS.URL_TEST_SESSION,
        autoResolveDeleteConflicts: true,
        force: true,
      } as any,
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => SESSION_TEST_PATTERNS.URL_TEST_SESSION, // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.sessionId).toBeTruthy();

    // dirIsolation.cleanup(); // Not available in this test utility
  });

  test("should handle update with force flag", async () => {
    const sessionPath = join(testData.tempDir, "test-repo", "sessions", "force-session");

    mockFs.ensureDirectoryExists(sessionPath);

    const sessionRecord: SessionRecord = {
      sessionId: "force-session",
      repoName: "test/repo",
      createdAt: new Date().toISOString(),
      name: "force-session",
      taskId: "101112",
      repoUrl: "https://github.com/test/repo.git",
      workspacePath: join(testData.tempDir, "test-repo"),
      sessionPath,
      branch: "develop",
      created: new Date().toISOString(),
    };

    const mockSessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    mockSessionDB.getSessionWorkdir = async () => sessionPath;

    const result = await updateSessionImpl(
      {
        name: "force-session",
        force: true,
      } as any,
      {
        gitService: mockGitService,
        sessionDB: mockSessionDB,
        getCurrentSession: async () => "force-session", // Mock current session detection
      }
    );

    expect(result).toBeDefined();
    expect(result.sessionId).toBeTruthy();
  });
});
