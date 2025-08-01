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

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import { startSessionFromParams } from "./session";
import { getSessionDir } from "../utils/paths";

describe("Session Creation Bug Fix (TDD)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), "test-tmp", "tdd-session-test");
  });

  afterEach(async () => {
    // Clean up test directories and real session directory
    try {
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
      // Also clean up the real session directory that might be created
      const sessionDir = getSessionDir("test-session");
      if (existsSync(sessionDir)) {
        await rm(sessionDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it("should NOT create session directory if git operations fail", async () => {
    // Arrange: Mock session provider and git service that will fail
    const mockSessionDB = {
      getSession: async () => null,
      listSessions: async () => [],
      addSession: async () => {
        throw new Error("Should not be called if git fails");
      },
      deleteSession: async () => true,
      getNewSessionRepoPath: () => join(tempDir, "local-minsky", "sessions", "test-session"),
    } as any;

    const mockTaskService = {
      getTask: async () => ({ id: "168", title: "Test Task" }),
      getTaskStatus: async () => "TODO",
      setTaskStatus: async () => undefined,
    } as any;

    const mockWorkspaceUtils = {
      isSessionWorkspace: () => false,
      getWorkspaceRepoName: () => "local-minsky",
    } as any;

    // This mock simulates the ACTUAL GitService bug behavior
    const mockGitService = {
      clone: async (options: any) => {
        // REPRODUCE THE BUG: Create directories THEN fail (like real GitService.clone does)
        const { existsSync, mkdirSync } = await import("fs");
        // Use the real session directory path to match what cleanup expects
        const sessionPath = getSessionDir("test-session");

        // Create directory structure like real GitService does
        if (!existsSync(sessionPath)) {
          mkdirSync(sessionPath, { recursive: true });
        }

        // THEN fail the git operation
        throw new Error("git clone failed");
      },
      branchWithoutSession: async () => ({ branch: "test" }),
    } as any;

    // Act: Try to start a session (should fail cleanly)
    let sessionStartFailed = false;
    try {
      await startSessionFromParams(
        {
          name: "test-session",
          repo: "https://github.com/invalid/repo.git",
          task: "168",
          quiet: false,
          noStatusUpdate: true,
          skipInstall: true,
        },
        {
          sessionDB: mockSessionDB,
          gitService: mockGitService,
          taskService: mockTaskService,
          workspaceUtils: mockWorkspaceUtils,
        }
      );
    } catch (error) {
      sessionStartFailed = true;
    }

    // Assert: Expected behavior after fix
    expect(sessionStartFailed)!.toBe(true); // Session creation should fail

    // CRITICAL: This assertion should PASS after fix but FAILS before fix
    // Use the real session directory path to match what cleanup expects
    const sessionDirPath = getSessionDir("test-session");
    expect(existsSync(sessionDirPath))!.toBe(false); // No orphaned directories should exist

    // Session should not be in database either
    const sessions = await mockSessionDB.listSessions();
    expect(sessions)!.toHaveLength(0);
  });
});
