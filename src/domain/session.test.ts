import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionDB } from "./session";
import type { SessionRecord } from "./session";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

describe("SessionDB", () => {
  let tmpDir: string;
  let sessionDb: SessionDB;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/session-test-");
    sessionDb = new SessionDB(join(tmpDir, "session-db.json"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("deleteSession", () => {
    test("should delete a session from the database", async () => {
      // Create test sessions
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
        },
        {
          session: "test-session-2",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
        },
      ];

      // Add sessions to the database using the API
      const db = new SessionDB(join(tmpDir, "session-db.json"));
      if (sessions[0]) await db.addSession(sessions[0]);
      if (sessions[1]) await db.addSession(sessions[1]);

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
      // Create and add a test session using the API
      const session: SessionRecord = {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: new Date().toISOString(),
      };

      const db = new SessionDB(join(tmpDir, "session-db.json"));
      if (session) await db.addSession(session);

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
      // Create a completely isolated test directory for this test
      const emptyDbDir = mkdtempSync("/tmp/session-empty-test-");
      const emptyDbPath = join(emptyDbDir, "empty-session-db.json");
      
      try {
        // Ensure database file exists but is empty (empty array)
        writeFileSync(emptyDbPath, JSON.stringify([], null, 2));
        
        // Initialize SessionDB instance with the empty database
        const db = new SessionDB(emptyDbPath);

        // Try to delete a session
        const result = await db.deleteSession("non-existent-session");

        // The implementation returns false when the session is not found
        expect(result).toBe(false);
      } finally {
        // Clean up the isolated test directory
        rmSync(emptyDbDir, { recursive: true, force: true });
      }
    });

    test("should handle non-existent database gracefully", async () => {
      // Create a path to a file that definitely doesn't exist
      const nonExistentDbPath = join(tmpDir, "non-existent-dir", "does-not-exist.json");
      
      // Initialize SessionDB instance with a non-existent database file
      const db = new SessionDB(nonExistentDbPath);

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Check that the operation returned false
      expect(result).toBe(false);
    });
  });

  describe("getSessionByTaskId", () => {
    test("should find a session by task ID", async () => {
      // Create test sessions with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#001"
        },
        {
          session: "test-session-2",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#002"
        },
      ];

      // Add sessions to the database
      const db = new SessionDB(join(tmpDir, "session-db.json"));
      if (sessions[0]) await db.addSession(sessions[0]);
      if (sessions[1]) await db.addSession(sessions[1]);

      // Find a session by task ID
      const result = await db.getSessionByTaskId("#002");

      // Check that the correct session was found
      expect(result).not.toBe(null);
      if (result) {
        expect(result.session).toBe("test-session-2");
        expect(result.taskId).toBe("#002");
      }
    });

    test("should return null if no session has the given task ID", async () => {
      // Create test sessions with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: new Date().toISOString(),
          taskId: "#001"
        },
      ];

      // Add sessions to the database
      const db = new SessionDB(join(tmpDir, "session-db.json"));
      if (sessions[0]) await db.addSession(sessions[0]);

      // Try to find a session with a non-existent task ID
      const result = await db.getSessionByTaskId("#999");

      // Check that no session was found
      expect(result).toBe(null);
    });
  });
}); 
