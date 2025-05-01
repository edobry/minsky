import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { SessionRecord } from "./session";
import { promises as fs } from "fs";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "fs";
import { PathLike } from "fs";

// Mock the normalizeRepoName function
mock.module("./repo-utils", () => ({
  normalizeRepoName: (repoUrl: string) => {
    // For tests, we want to preserve the exact repo name passed in
    // This ensures our test paths match exactly what we expect
    return repoUrl;
  }
}));

// Mock the normalizeTaskId function
mock.module("../utils/task-utils", () => ({
  normalizeTaskId: (taskId: string) => {
    // Match the actual implementation's behavior
    console.log("Mocked normalizeTaskId called with:", taskId);
    if (!taskId) {
      return taskId;
    }
    return taskId.startsWith("#") ? taskId : `#${taskId}`;
  }
}));

// Import the SessionDB class after mocking dependencies
import { SessionDB } from "./session";

describe("SessionDB", () => {
  const TEST_DIR = "/tmp/minsky-test";
  const TEST_STATE_DIR = join(TEST_DIR, "minsky");
  const TEST_SESSION_DB = join(TEST_STATE_DIR, "session-db.json");
  const TEST_GIT_DIR = join(TEST_STATE_DIR, "git");
  
  // Set up test environment
  beforeEach(async () => {
    // Create test directories
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_GIT_DIR, { recursive: true });
    
    // Set XDG_STATE_HOME for tests
    process.env.XDG_STATE_HOME = TEST_DIR;
    
    // Ensure the session database doesn't exist initially
    try {
      await fs.unlink(TEST_SESSION_DB);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  });
  
  // Clean up test environment
  afterEach(() => {
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
    
    // Reset environment variables
    delete process.env.XDG_STATE_HOME;
  });
  
  describe("deleteSession", () => {
    it("should delete a session from the database", async () => {
      // Set up test data
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString()
        },
        {
          session: "test-session-2",
          repoUrl: "https://github.com/test/repo2",
          repoName: "test/repo2",
          branch: "main",
          createdAt: new Date().toISOString()
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create test session directories
      const sessionDir1 = join(TEST_GIT_DIR, "test/repo", "sessions", "test-session-1");
      const sessionDir2 = join(TEST_GIT_DIR, "test/repo2", "sessions", "test-session-2");
      mkdirSync(join(TEST_GIT_DIR, "test/repo", "sessions"), { recursive: true });
      mkdirSync(join(TEST_GIT_DIR, "test/repo2", "sessions"), { recursive: true });
      mkdirSync(sessionDir1, { recursive: true });
      mkdirSync(sessionDir2, { recursive: true });
      
      // Create a test file in each session directory
      writeFileSync(join(sessionDir1, "test-file.txt"), "test content");
      writeFileSync(join(sessionDir2, "test-file.txt"), "test content");
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Delete the first session
      const result = await db.deleteSession("test-session-1");
      
      // Verify result
      expect(result).toBe(true);
      
      // Verify session was removed from database
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, "utf-8"));
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].session).toBe("test-session-2");
      
      // Verify session directory still exists (since the domain module only removes from DB)
      expect(existsSync(sessionDir1)).toBe(true);
    });
    
    it("should return false if session does not exist", async () => {
      // Set up test data
      const sessions: SessionRecord[] = [
        {
          session: "test-session",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString()
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Try to delete a non-existent session
      const result = await db.deleteSession("non-existent-session");
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify database is unchanged
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, "utf-8"));
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].session).toBe("test-session");
    });
    
    it("should handle empty database gracefully", async () => {
      // Create empty test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify([]));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Try to delete a session
      const result = await db.deleteSession("test-session");
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify database is still empty
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, "utf-8"));
      expect(remainingSessions.length).toBe(0);
    });
    
    it("should handle non-existent database gracefully", async () => {
      // Ensure database doesn't exist
      if (existsSync(TEST_SESSION_DB)) {
        unlinkSync(TEST_SESSION_DB);
      }
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Try to delete a session
      const result = await db.deleteSession("test-session");
      
      // Verify result
      expect(result).toBe(false);
    });
  });
  
  describe("getSessionByTaskId", () => {
    it("should find a session by task ID", async () => {
      // Set up test data with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString(),
          taskId: "#001"
        },
        {
          session: "test-session-2",
          repoUrl: "https://github.com/test/repo2",
          repoName: "test/repo2",
          branch: "main",
          createdAt: new Date().toISOString(),
          taskId: "#002"
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Find session by task ID
      const result = await db.getSessionByTaskId("#002");
      
      // Verify result
      expect(result).not.toBeNull();
      expect(result).toBeDefined();
      expect(result?.session).toBe("test-session-2");
      expect(result?.taskId).toBe("#002");
    });
    
    it("should return undefined if no session has the given task ID", async () => {
      // Set up test data with task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString(),
          taskId: "#001"
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Find session by non-existent task ID
      const result = await db.getSessionByTaskId("#999");
      
      // Verify result
      expect(result).toBeUndefined();
    });
    
    it("should normalize task ID before searching", async () => {
      // Set up test data with normalized task IDs
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString(),
          taskId: "#002"
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      
      // Find session by task ID with different formats
      const result1 = await db.getSessionByTaskId("#002");
      const result2 = await db.getSessionByTaskId("002");
      
      // Verify results - both formats should work
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      
      // Both results should point to the same session
      if (result1 && result2) {
        expect(result1.session).toBe("test-session-1");
        expect(result2.session).toBe("test-session-1");
      }
    });
  });
  
  describe("getRepoPath", () => {
    it("should construct the correct repo path", async () => {
      // Set up session record
      const sessionRecord: SessionRecord = {
        session: "test-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        createdAt: new Date().toISOString()
      };
      
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, "baseDir", { value: TEST_GIT_DIR });
      
      // Mock fs.access to fail for legacy path and succeed for new path
      const originalAccess = fs.access;
      const mockAccess = async (path: PathLike, mode?: number) => {
        if (path === join(TEST_GIT_DIR, "test/repo", "test-session")) {
          throw new Error("ENOENT");
        }
        return Promise.resolve();
      };
      fs.access = mockAccess;
      
      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original function
      fs.access = originalAccess;
      
      // Verify result is the new path format
      expect(result).toBe(join(TEST_GIT_DIR, "test/repo", "sessions", "test-session"));
    });
    
    it("should use repoPath from record if it exists", async () => {
      // Set up session record with explicit repoPath
      const sessionRecord: SessionRecord = {
        session: "test-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        createdAt: new Date().toISOString(),
        repoPath: "/custom/path/to/repo"
      };
      
      const db = new SessionDB();
      
      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Verify result uses the explicit repoPath
      expect(result).toBe("/custom/path/to/repo");
    });
    
    it("should prefer legacy path if it exists", async () => {
      // Set up session record
      const sessionRecord: SessionRecord = {
        session: "test-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        createdAt: new Date().toISOString()
      };
      
      // Setup paths
      const legacyPath = join(TEST_GIT_DIR, "test/repo", "test-session");
      
      // Make the legacy path actually exist
      mkdirSync(join(TEST_GIT_DIR, "test/repo"), { recursive: true });
      mkdirSync(legacyPath, { recursive: true });
      
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, "baseDir", { value: TEST_GIT_DIR });
      
      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Verify result is the legacy path
      expect(result).toBe(legacyPath);
    });
  });
  
  describe("getNewSessionRepoPath", () => {
    it("should return a path with sessions subdirectory", () => {
      const db = new SessionDB();
      const repoName = "test/repo";
      const sessionId = "test-session";
      
      // Override the baseDir for testing
      Object.defineProperty(db, "baseDir", { value: TEST_GIT_DIR });
      
      // Call the method
      const result = db.getNewSessionRepoPath(repoName, sessionId);
      
      // Verify result includes sessions subdirectory
      expect(result).toBe(join(TEST_GIT_DIR, repoName, "sessions", sessionId));
    });
  });
  
  describe("migrateSessionsToSubdirectory", () => {
    it("should move repos from legacy path to sessions subdirectory", async () => {
      // Set up test sessions
      const sessions: SessionRecord[] = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString()
        },
        {
          session: "test-session-2",
          repoUrl: "https://github.com/test/repo",
          repoName: "test/repo",
          branch: "main",
          createdAt: new Date().toISOString()
        }
      ];
      
      // Write sessions to test DB
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create legacy paths (actual directories)
      const legacyPath1 = join(TEST_GIT_DIR, "test/repo", "test-session-1");
      const legacyPath2 = join(TEST_GIT_DIR, "test/repo", "test-session-2");
      
      // Ensure test directories exist
      mkdirSync(join(TEST_GIT_DIR, "test/repo"), { recursive: true });
      mkdirSync(legacyPath1, { recursive: true });
      mkdirSync(legacyPath2, { recursive: true });
      
      // Expected new paths
      const newPath1 = join(TEST_GIT_DIR, "test/repo", "sessions", "test-session-1");
      const newPath2 = join(TEST_GIT_DIR, "test/repo", "sessions", "test-session-2");
      
      // Initialize SessionDB
      const db = new SessionDB();
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });
      Object.defineProperty(db, "baseDir", { value: TEST_GIT_DIR });
      
      // Run migration
      await db.migrateSessionsToSubdirectory();
      
      // Verify that the database was updated (directory paths are updated in DB)
      // Reload the sessions from the DB
      const savedSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, "utf-8")) as SessionRecord[];
      
      expect(savedSessions[0].repoPath).toBeDefined();
      expect(savedSessions[1].repoPath).toBeDefined();
      
      // Ensure new paths are created
      expect(existsSync(join(TEST_GIT_DIR, "test/repo", "sessions"))).toBe(true);
    });
  });
}); 
