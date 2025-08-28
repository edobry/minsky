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

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { startSessionFromParams, listSessionsFromParams } from "./session";
import { createMock } from "../utils/test-utils/mocking";
import { SESSION_TEST_PATTERNS } from "../utils/test-utils/test-constants";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/dependencies";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
import type { SessionProviderInterface } from "./session";

describe("Session Lookup Bug Reproduction (Task #168)", () => {
  // Static mock path to prevent environment dependencies
  const mockTempDir = "/mock/tmp/session-lookup-bug-test";
  let mockSessionDB: any;
  let mockGitService: any;
  let mockTaskService: any;
  let mockWorkspaceUtils: any;
  let mockResolveRepoPath: any;
  let addSessionSpy: any;

  // Mock filesystem operations using proven dependency injection patterns
  const mockFs = createMockFilesystem();

  beforeEach(() => {
    // Use mock.module() to mock filesystem operations within test scope
    mock.module("fs", () => ({
      default: {
        existsSync: mockFs.existsSync,
        statSync: (path: string) => ({
          isDirectory: () => mockFs.existsSync(path) && mockFs.directories.has(path),
        }),
      },
      existsSync: mockFs.existsSync,
      statSync: (path: string) => ({
        isDirectory: () => mockFs.existsSync(path) && mockFs.directories.has(path),
      }),
    }));
    mock.module("fs/promises", () => ({
      mkdir: mockFs.mkdir,
      rmdir: mockFs.rmdir,
      rm: mockFs.rm,
      readFile: mockFs.readFile,
      writeFile: mockFs.writeFile,
      readdir: mockFs.readdir,
      stat: mockFs.stat,
    }));

    // Mock cleanup - avoiding real filesystem operations
    mockFs.reset();

    // Create individual spies for methods that need call tracking
    addSessionSpy = mock(() => Promise.resolve());

    // Setup clean mocks for each test using centralized factories
    mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      listSessions: () => Promise.resolve([]),
      addSession: addSessionSpy as any,
      deleteSession: () => Promise.resolve(true),
      getRepoPath: () => Promise.resolve("/mock/repo/path"),
      getSessionWorkdir: () => Promise.resolve("/mock/session/workdir"),
    });

    // Mock git service with failing clone operation for bug reproduction
    mockGitService = createMockGitService({
      clone: async () => {
        // Mock directory creation then failure - avoiding real filesystem operations
        throw new Error("Git clone failed");
      },
      getSessionWorkdir: () => "/mock/session/workdir",
    });

    mockTaskService = createMockTaskService({
      getTaskById: () => Promise.resolve(null),
      listTasks: () => Promise.resolve([]),
      createTask: () => Promise.resolve(),
      updateTask: () => Promise.resolve(),
      deleteTask: () => Promise.resolve(true),
    });

    // Mock workspace utilities
    mockWorkspaceUtils = {
      createWorkspaceStructure: mock(() => Promise.resolve()),
      validateWorkspace: mock(() => Promise.resolve(true)),
    };

    mockResolveRepoPath = mock(() => Promise.resolve("/mock/repo/path"));
  });

  afterEach(() => {
    // Mock cleanup - avoiding real filesystem operations
    mockFs.reset();
    mock.restore();
  });

  describe("🐛 Session Creation Bug", () => {
    it("should NOT register session in database if git operations fail", async () => {
      const sessionParams = {
        sessionName: "test-bug-session",
        repoUrl: "https://github.com/test/repo.git",
        branch: "main",
      };

      // Mock directory creation before git failure
      mockFs.mkdir("/mock/sessions/test-bug-session", { recursive: true });

      // Act: Attempt to start session (should fail due to git error)
      let errorThrown = false;
      try {
        await startSessionFromParams(sessionParams, {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
          resolveRepoPath: mockResolveRepoPath,
        } as any);
      } catch (error) {
        errorThrown = true;
      }

      // Assert: Verify error was thrown
      expect(errorThrown).toBe(true);

      // Key assertion: Session should NOT be in database despite directory existing
      expect(addSessionSpy.mock.calls.length).toBe(0);

      // Verify session directory would exist (simulating the bug)
      expect(mockFs.existsSync("/mock/sessions/test-bug-session")).toBe(true);

      // Assert: listSessions should return empty array (session not registered)
      const sessions = await listSessionsFromParams({}, {
        sessionDB: mockSessionDB,
      } as any);
      expect(sessions).toEqual([]);
    });

    it("should demonstrate the lookup failure scenario", async () => {
      // Arrange: Simulate the bug state - directory exists but session not in database
      mockFs.mkdir("/mock/sessions/orphaned-session", { recursive: true });
      mockFs.writeFile(
        "/mock/sessions/orphaned-session/session.json",
        JSON.stringify({
          session: SESSION_TEST_PATTERNS.ORPHANED_SESSION,
          repoUrl: "https://github.com/test/repo.git",
          branch: "main",
        })
      );

      // Verify directory exists
      expect(mockFs.existsSync("/mock/sessions/orphaned-session")).toBe(true);

      // But session lookup fails because it's not in the database
      const session = await mockSessionDB.getSession(SESSION_TEST_PATTERNS.ORPHANED_SESSION);
      expect(session).toBeNull();

      // And session doesn't appear in list
      const sessions = await listSessionsFromParams({}, {
        sessionDB: mockSessionDB,
      } as any);
      expect(sessions).toEqual([]);
    });
  });

  describe("🔍 Session Directory vs Database Consistency", () => {
    it("should demonstrate the inconsistency between filesystem and database", async () => {
      // Create multiple sessions in different states
      const scenarios = [
        {
          name: "complete-session",
          inDatabase: true,
          hasDirectory: true,
        },
        {
          name: SESSION_TEST_PATTERNS.ORPHANED_SESSION,
          inDatabase: false,
          hasDirectory: true, // Bug: directory exists but not in database
        },
        {
          name: "ghost-session",
          inDatabase: true,
          hasDirectory: false, // Another bug: in database but no directory
        },
      ];

      // Set up the scenarios
      for (const scenario of scenarios) {
        if (scenario.hasDirectory) {
          mockFs.mkdir(`/mock/sessions/${scenario.name}`, { recursive: true });
          mockFs.writeFile(
            `/mock/sessions/${scenario.name}/session.json`,
            JSON.stringify({
              session: scenario.name,
              repoUrl: "https://github.com/test/repo.git",
              branch: "main",
            })
          );
        }

        if (scenario.inDatabase) {
          // Mock the database to return this session
          const originalGetSession = mockSessionDB.getSession;
          mockSessionDB.getSession = mock(async (name: string) => {
            if (name === scenario.name) {
              return {
                session: scenario.name,
                repoUrl: "https://github.com/test/repo.git",
                branch: "main",
              };
            }
            return null;
          });
        }
      }

      // Test each scenario
      for (const scenario of scenarios) {
        const sessionExists = await mockSessionDB.getSession(scenario.name);
        const directoryExists = mockFs.existsSync(`/mock/sessions/${scenario.name}`);

        console.log(`Scenario: ${scenario.name}`);
        console.log(`  Database: ${sessionExists ? "✓" : "✗"}`);
        console.log(`  Directory: ${directoryExists ? "✓" : "✗"}`);

        // Verify the expected inconsistencies
        if (scenario.name === SESSION_TEST_PATTERNS.ORPHANED_SESSION) {
          expect(sessionExists).toBeNull(); // Not in database
          expect(directoryExists).toBe(true); // But directory exists
        }
      }
    });

    it("should show how the bug affects session commands", async () => {
      // Simulate orphaned session (directory exists, not in database)
      mockFs.mkdir("/mock/sessions/orphaned-pr-session", { recursive: true });
      mockFs.writeFile(
        "/mock/sessions/orphaned-pr-session/session.json",
        JSON.stringify({
          session: "orphaned-pr-session",
          repoUrl: "https://github.com/test/repo.git",
          branch: "main",
        })
      );

      // Verify directory exists
      expect(mockFs.existsSync("/mock/sessions/orphaned-pr-session")).toBe(true);

      // But session lookup fails
      const session = await mockSessionDB.getSession("orphaned-pr-session");
      expect(session).toBeNull();

      // This would cause PR commands to fail with "Session not found"
      // even though the session directory exists on disk
    });
  });
});
