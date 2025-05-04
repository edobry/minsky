import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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
      await db.addSession(sessions[0]);
      await db.addSession(sessions[1]);

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
      // Ensure database file exists but is empty
      writeFileSync(join(tmpDir, "session-db.json"), JSON.stringify([], null, 2));
      
      // Initialize SessionDB instance
      const db = new SessionDB(join(tmpDir, "session-db.json"));

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Check that the operation returned false
      expect(result).toBe(false);
    });

    test("should handle non-existent database gracefully", async () => {
      // Don't create the database file
      // Make sure it doesn't exist
      if (existsSync(join(tmpDir, "session-db.json"))) {
        rmSync(join(tmpDir, "session-db.json"));
      }

      // Initialize SessionDB instance
      const db = new SessionDB(join(tmpDir, "session-db.json"));

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Check that the operation returned false
      expect(result).toBe(false);
    });
  });
}); 
