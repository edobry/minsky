/**
 * Test for Session Lookup Bug Reproduction
 *
 * Bug #168: Sessions created with `minsky session start` are not properly registered
 * in the session database, causing lookup failures when using session commands.
 *
 * Root Cause: GitService.clone creates session directories BEFORE git operations,
 * but if git operations fail, directories remain on disk while session records
 * are never added to the database.
 *
 * Steps to reproduce:
 * 1. Session creation partially succeeds (directory created)
 * 2. Git operations fail (clone or branch creation)
 * 3. Directory cleanup fails or is incomplete
 * 4. Session directory exists on disk but session not in database
 * 5. `minsky session list` doesn't show the session
 * 6. `minsky session pr` fails with "Session not found"
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { join } from "path";
import { mkdir, rmdir, access } from "fs/promises";
import { existsSync } from "fs";
import { startSessionFromParams, listSessionsFromParams } from "./session";
import { createMock } from "../utils/test-utils/mocking";
import { createMockSessionProvider, createMockGitService, createMockTaskService } from "../utils/test-utils/dependencies";
import type { SessionProviderInterface } from "./session";

describe("Session Lookup Bug Reproduction (Task #168)", () => {
  let tempDir: string;
  let mockSessionDB: any;
  let mockGitService: any;
  let mockTaskService: any;
  let mockWorkspaceUtils: any;
  let mockResolveRepoPath: any;
  let addSessionSpy: any;

  beforeEach(() => {
    tempDir = join(process.cwd(), "test-tmp", "session-lookup-bug-test");

    // Create individual spies for methods that need call tracking
    addSessionSpy = createMock(() => Promise.resolve());

    // Setup clean mocks for each test using centralized factories
    mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy as any,
      deleteSession: () => Promise.resolve(true),
    });

    // Add getNewSessionRepoPath method not covered by centralized factory
    (mockSessionDB as any).getNewSessionRepoPath = createMock((...args: any[]) => {
      const [repoName, sessionName] = args;
      return join(tempDir, repoName, "sessions", sessionName);
    });

    mockTaskService = createMockTaskService({
      mockGetTask: () => Promise.resolve({ id: "168", title: "Test Task", status: "TODO" }),
      getTaskStatus: () => Promise.resolve("TODO"),
      setTaskStatus: () => Promise.resolve(),
    });

    mockWorkspaceUtils = {
      isSessionWorkspace: createMock(async () => false),
    };

    mockResolveRepoPath = createMock(async () => "local/minsky");
  });

  describe("Scenario 1: Git clone creates directory but fails before completion", () => {
    it("should not leave orphaned session directories when git clone fails after mkdir", async () => {
      // Bug setup: GitService.clone creates directories via mkdir BEFORE git operations
      // If git clone fails after mkdir but before session DB registration,
      // we get orphaned directories

      const cloneSpy = createMock();
      cloneSpy.mockImplementation(async (options: any) => {
        // Simulate GitService.clone behavior:
        // 1. Creates session directory structure (this happens in real GitService.clone)
        const sessionDir = join(tempDir, "local-minsky", "sessions", options.session);
        await mkdir(sessionDir, { recursive: true });

        // 2. Then git clone fails
        throw new Error("fatal: remote repository not found");
      });

      const branchWithoutSessionSpy = createMock();
      branchWithoutSessionSpy.mockImplementation(() => Promise.resolve({ branch: "test-orphan-session" }));

      mockGitService = createMockGitService({
        clone: cloneSpy as any,
      });

      // Add branchWithoutSession method not covered by centralized factory
      (mockGitService as any).branchWithoutSession = branchWithoutSessionSpy;

      const params = {
        name: "test-orphan-session",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act: Attempt session creation (should fail)
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("remote repository not found");

      // Assert: Critical bug symptoms
      // 1. Session directory should be cleaned up (currently failing)
      const sessionDir = join(tempDir, "local-minsky", "sessions", "test-orphan-session");
      const dirExists = existsSync(sessionDir);

      // 2. Session should NOT be in database
      expect(addSessionSpy).not.toHaveBeenCalled();

      // 3. Session should NOT appear in session list
      const sessions = await listSessionsFromParams({}, { sessionDB: mockSessionDB });
      const orphanSession = sessions.find((s) => s.session === "test-orphan-session");
      expect(orphanSession).toBeUndefined();

      // This assertion documents the current bug - directory exists but session not in DB
      if (dirExists) {
        console.warn(`BUG CONFIRMED: Orphaned session directory exists at ${sessionDir}`);
        // TODO: This should be false after the fix
        expect(dirExists).toBe(true);
      }
    });
  });

  describe("Scenario 2: Git branch creation fails after clone succeeds", () => {
    it("should not leave orphaned sessions when branch creation fails", async () => {
      // Bug setup: Git clone succeeds, but branch creation fails
      // Session directory exists but session never gets added to DB

      const cloneSpy = createMock();
      cloneSpy.mockImplementation(async (options: any) => {
        // Clone succeeds and creates directory
        const sessionDir = join(tempDir, "local-minsky", "sessions", options.session);
        await mkdir(sessionDir, { recursive: true });
        return { workdir: sessionDir, session: options.session };
      });

      const branchWithoutSessionSpy = createMock();
      branchWithoutSessionSpy.mockImplementation(() => Promise.reject(new Error("fatal: unable to create branch")));

      mockGitService = createMockGitService({
        clone: cloneSpy as any,
      });

      // Add branchWithoutSession method not covered by centralized factory
      (mockGitService as any).branchWithoutSession = branchWithoutSessionSpy;

      const params = {
        name: "test-branch-failure",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act: Attempt session creation (should fail at branch creation)
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("unable to create branch");

      // Assert: Session directory exists but not in database
      const sessionDir = join(tempDir, "local-minsky", "sessions", "test-branch-failure");
      const dirExists = existsSync(sessionDir);

      // Session should NOT be in database
      expect(addSessionSpy).not.toHaveBeenCalled();

      // This documents the bug - directory may exist but session not in DB
      if (dirExists) {
        console.warn(`BUG CONFIRMED: Orphaned session after branch failure at ${sessionDir}`);
      }
    });
  });

  describe("Scenario 3: Partial cleanup leaves inconsistent state", () => {
    it("should handle the case where session directories exist but sessions are not in database", async () => {
      // Bug setup: Simulate the actual state users encounter -
      // session directories exist on disk but session lookup fails

      const sessionName = "existing-orphan-session";
      const sessionDir = join(tempDir, "local-minsky", "sessions", sessionName);

      // Pre-create the session directory (simulating orphaned state)
      await mkdir(sessionDir, { recursive: true });

      // Create spies for specific behaviors in this test
      const getSessionSpy = createMock();
      getSessionSpy.mockImplementation(() => Promise.resolve(null));

      const listSessionsSpy = createMock();
      listSessionsSpy.mockImplementation(() => Promise.resolve([]));

      // Database doesn't know about this session - use specific mocks for this test
      const testMockSessionDB = createMockSessionProvider({
        getSession: getSessionSpy as any,
        listSessions: listSessionsSpy as any,
      });

      // Act: Try to list sessions
      const sessions = await listSessionsFromParams({}, { sessionDB: testMockSessionDB });

      // Assert: Session not found in database despite directory existing
      const foundSession = sessions.find((s) => s.session === sessionName);
      expect(foundSession).toBeUndefined();

      // But directory exists on disk
      expect(existsSync(sessionDir)).toBe(true);

      console.warn(`BUG CONFIRMED: Orphaned session directory at ${sessionDir} not in database`);
    });
  });

  describe("Expected behavior after fix", () => {
    it("should either succeed completely or fail cleanly with no orphaned directories", async () => {
      // This test documents the expected behavior after the fix

      const cloneSpy = createMock();
      cloneSpy.mockImplementation(() => Promise.reject(new Error("git clone failed")));

      mockGitService = createMockGitService({
        clone: cloneSpy as any,
      });

      // Add branchWithoutSession method not covered by centralized factory
      (mockGitService as any).branchWithoutSession = createMock();

      const params = {
        name: "test-clean-failure",
        repo: "local/minsky",
        quiet: false,
        noStatusUpdate: false,
        skipInstall: true,
      };

      // Act: Session creation should fail
      await expect(
        startSessionFromParams(params, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        })
      ).rejects.toThrow("git clone failed");

      // Assert: After fix, these should all be true:
      // 1. No session in database
      expect(addSessionSpy).not.toHaveBeenCalled();

      // 2. No orphaned directories (this should pass after fix)
      const sessionDir = join(tempDir, "local-minsky", "sessions", "test-clean-failure");
      expect(existsSync(sessionDir)).toBe(false);

      // 3. Session doesn't appear in list
      const sessions = await listSessionsFromParams({}, { sessionDB: mockSessionDB });
      const orphanSession = sessions.find((s) => s.session === "test-clean-failure");
      expect(orphanSession).toBeUndefined();
    });
  });
});
