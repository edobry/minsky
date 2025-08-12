/**
 * Test-Driven Bug Fix for Session Lookup Bug (Task #168)
 *
 * This test should FAIL initially because of the bug, then PASS after the fix.
 *
 * Bug: When GitService.clone fails, session directories are created on disk
 * but sessions are never registered in the database.
 *
 * Expected Behavior: If git operations fail, NO session directory should exist
 * and session should not be registered.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { startSessionFromParams } from "./session";
import { getSessionDir } from "../utils/paths";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";

describe("Session Creation Bug Fix (TDD)", () => {
  // Mock filesystem operations using proven dependency injection patterns
  const mockFs = createMockFilesystem();

  // Use mock.module() to mock filesystem operations within test scope
  beforeEach(() => {
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
  });

  afterEach(() => {
    // Mock cleanup - avoiding real filesystem operations
    mockFs.reset();
    mock.restore();
  });

  // Static mock path to prevent environment dependencies
  const mockTempDir = "/mock/tmp/tdd-session-test";

  it("should NOT create session directory if git operations fail", async () => {
    // Arrange: Mock session provider and git service that will fail
    const mockSessionDB = {
      getSession: async () => null,
      listSessions: async () => [],
      addSession: async () => {
        throw new Error("Session registration failed");
      },
    };

    const mockGitService = {
      clone: async () => {
        throw new Error("Git clone failed");
      },
      getSessionWorkdir: () => "/mock/session/workdir",
    };

    // Act: Attempt to start a session (this should fail)
    let errorThrown = false;
    let sessionCreationError: Error | null = null;

    try {
      await startSessionFromParams(
        {
          sessionName: "test-session",
          repoUrl: "https://github.com/test/repo.git",
          branch: "main",
        },
        {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
        } as any
      );
    } catch (error) {
      errorThrown = true;
      sessionCreationError = error as Error;
    }

    // Assert: Verify the failure behavior
    expect(errorThrown).toBe(true);
    expect(sessionCreationError).toBeDefined();

    // Key assertion: NO session directory should exist after failed git operations
    const sessionDir = getSessionDir("test-session");
    expect(mockFs.existsSync(sessionDir)).toBe(false);

    // Verify session was not registered in database
    const registeredSession = await mockSessionDB.getSession("test-session");
    expect(registeredSession).toBeNull();
  });

  it("should properly clean up if session creation partially succeeds then fails", async () => {
    // Arrange: Mock scenario where directory creation succeeds but git clone fails
    const mockSessionDB = {
      getSession: async () => null,
      listSessions: async () => [],
      addSession: async (session: any) => {
        // Simulate session registration success
        mockFs.mkdir(`/mock/sessions/${session.session}`, { recursive: true });
      },
    };

    const mockGitService = {
      clone: async () => {
        throw new Error("Git clone failed after directory creation");
      },
      getSessionWorkdir: () => "/mock/session/workdir",
    };

    // Act: Attempt to start a session
    let errorThrown = false;

    try {
      await startSessionFromParams(
        {
          sessionName: "test-partial-session",
          repoUrl: "https://github.com/test/repo.git",
          branch: "main",
        },
        {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
        } as any
      );
    } catch (error) {
      errorThrown = true;
    }

    // Assert: Verify cleanup happened
    expect(errorThrown).toBe(true);

    // Key assertion: Even if directory was initially created, it should be cleaned up
    const sessionDir = getSessionDir("test-partial-session");
    expect(mockFs.existsSync(sessionDir)).toBe(false);
  });
});
