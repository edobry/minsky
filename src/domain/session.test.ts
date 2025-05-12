import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionDB } from "./session.js";
import type { SessionRecord } from "./session.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

describe("SessionDB", () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a fresh temp directory for each test
    tmpDir = mkdtempSync("/tmp/session-test-");
  });

  afterEach(() => {
    // Clean up the test directory
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("deleteSession", () => {
    test("should delete a session from the database", async () => {
      // Create a unique DB file for this test
      const testDbPath = join(tmpDir, "delete-session-test.json");

      // No need to ensure parent directory exists as tmpDir is already created

      // Initialize the database
      const db = new SessionDB(testDbPath);

      // Create test sessions
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#001",
        },
        {
          session: "test-session-2",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#002",
        },
      ];

      // Add sessions to the database
      await db.addSession(sessions[0]!);
      await db.addSession(sessions[1]!);

      // Delete the first session
      const result = await db.deleteSession("test-session-1");

      // Check that the session was deleted
      expect(result).toBe(true);

      // Check that only the second session remains
      const remainingSessions = await db.listSessions();
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0]?.session).toBe("test-session-2");
    });

    test("should return false if session does not exist", async () => {
      // Create a unique DB file for this test
      const testDbPath = join(tmpDir, "session-not-exist-test.json");

      // No need to ensure parent directory exists as tmpDir is already created

      // Initialize the database with a clean file
      const db = new SessionDB(testDbPath);

      // Create and add a test session
      const session: SessionRecord = {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: new Date().toISOString(),
      };

      await db.addSession(session);

      // Try to delete a non-existent session
      const result = await db.deleteSession("non-existent-session");

      // Check that the operation returned false
      expect(result).toBe(false);

      // Check that the original session still exists
      const remainingSessions = await db.listSessions();
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0]?.session).toBe("test-session");
    });

    test("should handle empty database gracefully", async () => {
      // Create a unique DB file for this test
      const emptyDbPath = join(tmpDir, "empty-session-db.json");

      // No need to ensure parent directory exists as tmpDir is already created

      // Ensure database file exists but is empty (empty array)
      writeFileSync(emptyDbPath, JSON.stringify([], null, 2));

      // Initialize SessionDB instance with the empty database
      const db = new SessionDB(emptyDbPath);

      // Try to delete a session
      const result = await db.deleteSession("non-existent-session");

      // The implementation returns false when the session is not found
      expect(result).toBe(false);
    });

    test("should handle non-existent database gracefully", async () => {
      // Create a path to a file that definitely doesn't exist
      const nonExistentDbPath = join(tmpDir, "non-existent-dir", "does-not-exist.json");

      // Initialize SessionDB instance with a non-existent database file
      const db = new SessionDB(nonExistentDbPath);

      // Check that deleteSession returns false if the database doesn't exist
      const result = await db.deleteSession("test-session");
      expect(result).toBe(false);
    });
  });

  describe("getSessionByTaskId", () => {
    test("should find a session by task ID", async () => {
      // Create a unique DB file for this test
      const testDbPath = join(tmpDir, "find-by-task-id-test.json");

      // No need to ensure parent directory exists as tmpDir is already created

      // Initialize with a clean database
      const db = new SessionDB(testDbPath);

      // Create test sessions with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#001",
        },
        {
          session: "test-session-2",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#002",
        },
      ];

      // Add sessions to the database
      await db.addSession(sessions[0]!);
      await db.addSession(sessions[1]!);

      // Find a session by task ID
      const result = await db.getSessionByTaskId("#002");

      // Check that the correct session was found
      expect(result).toBeTruthy();
      if (result) {
        expect(result.session).toBe("test-session-2");
        expect(result.taskId).toBe("#002");
      }
    });

    test("should return null if no session has the given task ID", async () => {
      // Create a unique DB file for this test
      const testDbPath = join(tmpDir, "no-task-id-test.json");

      // No need to ensure parent directory exists as tmpDir is already created

      // Initialize with a clean database
      const db = new SessionDB(testDbPath);

      // Create test sessions with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#001",
        },
      ];

      // Add sessions to the database
      await db.addSession(sessions[0]!);

      // Try to find a session with a non-existent task ID
      const result = await db.getSessionByTaskId("#999");

      // Check that no session was found
      expect(result).toBe(null);
    });
  });
});
