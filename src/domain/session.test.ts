import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { SessionRecord } from "./session";
import { promises as fs } from "fs";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "fs";

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
  
  // Mock the SessionDB class to use our test directories
  let originalXdgStateHome: string | undefined;
  
  // Set up test environment
  beforeEach(async () => {
    // Save original environment
    originalXdgStateHome = process.env.XDG_STATE_HOME;
    
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

    // Mock fs operations
    const mockFs = {
      ...fs,
      mkdir: mock(() => Promise.resolve()),
      readFile: mock(() => Promise.resolve("[]")),
      writeFile: mock(() => Promise.resolve()),
      rename: mock(() => Promise.resolve()),
      access: mock(() => Promise.resolve())
    };
    (global as any).fs = mockFs;
  });
  
  // Clean up test environment
  afterEach(() => {
    // Restore original environment
    if (originalXdgStateHome) {
      process.env.XDG_STATE_HOME = originalXdgStateHome;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
    
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });

    // Restore original fs
    delete (global as any).fs;
  });
  
  describe("deleteSession", () => {
    it("should delete a session from the database", async () => {
      // Create a test session DB
      const db = new SessionDB();
      
      // Create test data
      const testSessions = [
        {
          session: "test-session",
          repoUrl: "https://repo",
          repoName: "repo",
          createdAt: "2024-01-01"
        },
        {
          session: "other-session",
          repoUrl: "https://repo",
          repoName: "repo",
          createdAt: "2024-01-01"
        }
      ];
      
      // Mock methods
      const mockReadDb = mock(() => Promise.resolve(testSessions));
      const mockWriteDb = mock(() => Promise.resolve());
      
      // Replace real methods with mocks
      (db as any).readDb = mockReadDb;
      (db as any).writeDb = mockWriteDb;
      
      // Call the deleteSession method
      const result = await db.deleteSession("test-session");
      
      // Verify the result is true (session was deleted)
      expect(result).toBe(true);
      
      // Verify that writeDb was called with the filtered sessions list
      // (without the deleted session)
      expect(mockWriteDb).toHaveBeenCalled();
      
      // Get the first call to writeDb
      const writeDbCall = mockWriteDb.mock.calls[0];
      
      // Check that it was called with an array of length 1
      if (writeDbCall) {
        expect(writeDbCall[0].length).toBe(1);
        
        // Check that the only session in the array is "other-session"
        expect(writeDbCall[0][0].session).toBe("other-session");
      }
    });
    
    it("should return false if session does not exist", async () => {
      // Setup test data with empty array (no sessions)
      (global as any).fs.readFile = mock(() => Promise.resolve("[]"));

      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Verify result
      expect(result).toBe(false);

      // Verify database was not modified
      const mockWriteFile = (global as any).fs.writeFile;
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
    
    it("should handle empty database gracefully", async () => {
      // Mock fs.readFile to return empty array
      (global as any).fs.readFile = mock(() => Promise.resolve("[]"));

      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Verify result
      expect(result).toBe(false);

      // Verify database was not modified
      const mockWriteFile = (global as any).fs.writeFile;
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
    
    it("should handle non-existent database gracefully", async () => {
      // Mock fs.readFile to throw ENOENT
      (global as any).fs.readFile = mock(() => Promise.reject(new Error("ENOENT")));

      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });

      // Try to delete a session
      const result = await db.deleteSession("test-session");

      // Verify result
      expect(result).toBe(false);

      // Verify database was not modified
      const mockWriteFile = (global as any).fs.writeFile;
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
  
  describe("getSessionByTaskId", () => {
    it("should find a session by task ID", async () => {
      // Create a test session DB
      const db = new SessionDB();
      
      // Create test data with task IDs that include # prefix
      const testSessions = [
        {
          session: "test-session",
          repoUrl: "https://repo",
          repoName: "repo",
          createdAt: "2024-01-01",
          taskId: "#002"
        },
        {
          session: "other-session",
          repoUrl: "https://repo",
          repoName: "repo",
          createdAt: "2024-01-01",
          taskId: "#003"
        }
      ];
      
      // Mock readDb to return our test data
      const mockReadDb = mock(() => Promise.resolve(testSessions));
      
      // Replace the real method with our mock
      (db as any).readDb = mockReadDb;
      
      // Call the getSessionByTaskId method
      const result = await db.getSessionByTaskId("#002");
      
      // Verify we got a result
      expect(result).toBeDefined();
      
      // Verify it's the right session
      if (result) {
        expect(result).toEqual(testSessions[0]);
      }
    });
    
    it("should return undefined if no session has the given task ID", async () => {
      // Setup test data with normalized task IDs (with # prefix)
      const testSessions = [
        { session: "test-session", repoUrl: "https://repo", repoName: "repo", createdAt: "2024-01-01", taskId: "#002", repoPath: join(TEST_GIT_DIR, "repo/sessions/test-session") }
      ];

      // Mock fs.readFile to return test data
      (global as any).fs.readFile = mock(() => Promise.resolve(JSON.stringify(testSessions)));

      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });

      // Try to find session by task ID
      const result = await db.getSessionByTaskId("#003");

      // Verify result
      expect(result).toBeUndefined();
    });

    it("should normalize task ID before searching", async () => {
      // Setup test data with normalized task IDs (with # prefix)
      const testSessions = [
        { session: "test-session", repoUrl: "https://repo", repoName: "repo", createdAt: "2024-01-01", taskId: "#002", repoPath: join(TEST_GIT_DIR, "repo/sessions/test-session") }
      ];

      // Mock fs.readFile to return test data
      (global as any).fs.readFile = mock(() => Promise.resolve(JSON.stringify(testSessions)));

      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, "dbPath", { value: TEST_SESSION_DB });

      // Find session by task ID with different formats
      const result1 = await db.getSessionByTaskId("#002");
      const result2 = await db.getSessionByTaskId("task#002");
      const result3 = await db.getSessionByTaskId("002");

      // Verify results
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result3).toBeDefined();
      
      if (result1 && result2 && result3) {
        expect(result1.session).toEqual("test-session");
        expect(result2.session).toEqual("test-session");
        expect(result3.session).toEqual("test-session");
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
      
      // Patch the join function to return the correct path for testing
      const originalJoin = join;
      const mockJoin = mock((...args: string[]) => {
        if (args.includes("sessions")) {
          return join(TEST_GIT_DIR, "test/repo", "sessions", "test-session");
        } else if (args.includes("test-session")) {
          return join(TEST_GIT_DIR, "test/repo", "test-session");
        }
        return originalJoin(...args);
      });
      
      // Replace global join with our mocked version
      (global as any).join = mockJoin;
      
      // Mock fs.access to fail for legacy path (simulate it doesn't exist)
      // but succeed for new path with sessions subdirectory
      const mockAccess = mock((path: string) => {
        if (path === join(TEST_GIT_DIR, "test/repo", "test-session")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve();
      });
      (global as any).fs.access = mockAccess;
      
      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original join function
      (global as any).join = originalJoin;
      
      // Verify result includes sessions subdirectory
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
      
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, "baseDir", { value: TEST_GIT_DIR });
      
      // Patch the join function to return the correct path for testing
      const originalJoin = join;
      const mockJoin = mock((...args: string[]) => {
        if (args.includes("sessions")) {
          return join(TEST_GIT_DIR, "test/repo", "sessions", "test-session");
        } else if (args.includes("test-session")) {
          return join(TEST_GIT_DIR, "test/repo", "test-session");
        }
        return originalJoin(...args);
      });
      
      // Replace global join with our mocked version
      (global as any).join = mockJoin;
      
      // Mock fs.access to succeed for legacy path
      const mockAccess = mock(() => Promise.resolve());
      (global as any).fs.access = mockAccess;
      
      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original join function
      (global as any).join = originalJoin;
      
      // Verify result is the legacy path
      expect(result).toBe(join(TEST_GIT_DIR, "test/repo", "test-session"));
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
      // Create a test session DB
      const db = new SessionDB();
      
      // Create a test session
      const testSession = {
        session: "test-session",
        repoUrl: "https://repo",
        repoName: "repo",
        createdAt: "2024-01-01"
      };
      
      // Mock our methods
      const mockReadDb = mock(() => Promise.resolve([testSession]));
      const mockWriteDb = mock(() => Promise.resolve());
      
      // Replace the real readDb and writeDb methods
      (db as any).readDb = mockReadDb;
      (db as any).writeDb = mockWriteDb;
      
      // Set the base directory for tests
      (db as any).baseDir = "/test/dir";
      
      // Set up paths for testing
      const legacyPath = "/test/dir/repo/test-session";
      const newPath = "/test/dir/repo/sessions/test-session";
      
      // Mock fs.access to return success for legacy path
      // and failure for new path
      const mockAccess = mock((path: string) => {
        if (path === legacyPath) {
          return Promise.resolve();
        }
        return Promise.reject(new Error("ENOENT"));
      });
      
      // Mock fs.mkdir and fs.rename
      const mockMkdir = mock(() => Promise.resolve());
      const mockRename = mock(() => Promise.resolve());
      
      // Replace fs methods with mocks
      (global as any).fs.access = mockAccess;
      (global as any).fs.mkdir = mockMkdir;
      (global as any).fs.rename = mockRename;
      
      // Call the method we're testing
      await db.migrateSessionsToSubdirectory();
      
      // Verify the results
      expect(mockRename).toHaveBeenCalled();
      expect(mockWriteDb).toHaveBeenCalled();
    });
  });
}); 
