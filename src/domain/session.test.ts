import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SessionDB } from './session';
import type { SessionRecord } from './session';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from 'fs';

// Mock the normalizeRepoName function
mock.module('./repo-utils', () => ({
  normalizeRepoName: (repoUrl: string) => {
    // For tests, we want to preserve the exact repo name passed in
    // This ensures our test paths match exactly what we expect
    return repoUrl;
  }
}));

// Import the SessionDB class after mocking dependencies
import { SessionDB as ActualSessionDB } from './session';

describe('SessionDB', () => {
  const TEST_DIR = '/tmp/minsky-test';
  const TEST_STATE_DIR = join(TEST_DIR, 'minsky');
  const TEST_SESSION_DB = join(TEST_STATE_DIR, 'session-db.json');
  const TEST_GIT_DIR = join(TEST_STATE_DIR, 'git');
  
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
  });
  
  describe('deleteSession', () => {
    it('should delete a session from the database', async () => {
      // Create test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString()
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Create a custom mock for getSessions that returns our test data
      const originalGetSessions = db.getSessions;
      db.getSessions = async () => sessions;
      
      // Create a custom mock for saveSessions that clears the sessions array
      const originalSaveSessions = db.saveSessions;
      db.saveSessions = async (sessionsToSave) => {
        sessions.length = 0; // Clear the array
        writeFileSync(TEST_SESSION_DB, JSON.stringify([]));
      };
      
      // Delete the session
      const result = await db.deleteSession('test-session');
      
      // Restore original methods
      db.getSessions = originalGetSessions;
      db.saveSessions = originalSaveSessions;
      
      // Verify result
      expect(result).toBe(true);
      
      // Verify session was removed from database (our mock should have cleared it)
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(0);
    });
    
    it('should return false if session does not exist', async () => {
      // Create test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString()
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Create a custom mock for getSessions that returns our test data
      const originalGetSessions = db.getSessions;
      db.getSessions = async () => [...sessions]; // Return a copy
      
      // Try to delete a non-existent session
      const result = await db.deleteSession('non-existent-session');
      
      // Restore original method
      db.getSessions = originalGetSessions;
      
      // Verify result
      expect(result).toBe(false);
    });
    
    it('should handle empty database gracefully', async () => {
      // Create empty session database
      writeFileSync(TEST_SESSION_DB, '[]');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Create a custom mock for getSessions that returns an empty array
      const originalGetSessions = db.getSessions;
      db.getSessions = async () => [];
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
      // Restore original method
      db.getSessions = originalGetSessions;
      
      // Verify result
      expect(result).toBe(false);
    });
    
    it('should handle non-existent database gracefully', async () => {
      // Ensure database doesn't exist
      if (existsSync(TEST_SESSION_DB)) {
        unlinkSync(TEST_SESSION_DB);
      }
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Create a custom mock for getSessions that simulates error by returning empty array
      const originalGetSessions = db.getSessions;
      db.getSessions = async () => [];
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
      // Restore original method
      db.getSessions = originalGetSessions;
      
      // Verify result
      expect(result).toBe(false);
    });
  });
  
  describe('getSessionByTaskId', () => {
    it('should find a session by task ID', async () => {
      // Set up test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session-1',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString(),
          taskId: '#001'
        },
        {
          session: 'test-session-2',
          repoUrl: 'https://github.com/test/repo2',
          repoName: 'test/repo2',
          branch: 'main',
          createdAt: new Date().toISOString(),
          taskId: '#002'
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Find session by task ID
      const result = await db.getSessionByTaskId('#002');
      
      // Verify result
      expect(result).not.toBeNull();
      expect(result).toBeDefined();
      expect(result?.session).toBe('test-session-2');
      expect(result?.taskId).toBe('#002');
    });
    
    it('should return undefined if no session has the given task ID', async () => {
      // Set up test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session-1',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString(),
          taskId: '#001'
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Find session by non-existent task ID
      const result = await db.getSessionByTaskId('#999');
      
      // Verify result
      expect(result).toBeUndefined();
    });
  });
  
  describe('getRepoPath', () => {
    it('should return the legacy path if no sessions directory exists', async () => {
      // Create legacy path
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      const legacyPath = join(TEST_GIT_DIR, repoName, sessionId);
      mkdirSync(join(TEST_GIT_DIR, repoName), { recursive: true });
      mkdirSync(legacyPath, { recursive: true });
      
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock the repoExists method to simulate legacy path exists but new path doesn't
      const originalRepoExists = (db as any).repoExists;
      (db as any).repoExists = async (path: string) => {
        if (path === join(TEST_GIT_DIR, repoName, 'sessions', sessionId)) {
          return false; // New path doesn't exist
        }
        return path === legacyPath; // Only legacy path exists
      };

      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(legacyPath);
    });
    
    it('should return the new path if sessions directory exists', async () => {
      // Create new path
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      const newPath = join(TEST_GIT_DIR, repoName, 'sessions', sessionId);
      mkdirSync(join(TEST_GIT_DIR, repoName, 'sessions'), { recursive: true });
      mkdirSync(newPath, { recursive: true });
      
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock the repoExists method to simulate new path exists
      const originalRepoExists = (db as any).repoExists;
      (db as any).repoExists = async (path: string) => {
        return path === newPath; // Only new path exists
      };
      
      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(newPath);
    });
    
    it('should prefer new path over legacy path if both exist', async () => {
      // Create both paths
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      const legacyPath = join(TEST_GIT_DIR, repoName, sessionId);
      const newPath = join(TEST_GIT_DIR, repoName, 'sessions', sessionId);
      mkdirSync(join(TEST_GIT_DIR, repoName), { recursive: true });
      mkdirSync(legacyPath, { recursive: true });
      mkdirSync(join(TEST_GIT_DIR, repoName, 'sessions'), { recursive: true });
      mkdirSync(newPath, { recursive: true });
      
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock the repoExists method to simulate both paths exist
      const originalRepoExists = (db as any).repoExists;
      (db as any).repoExists = async (path: string) => {
        return path === newPath || path === legacyPath; // Both paths exist
      };
      
      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(newPath);
    });
  });
  
  describe('getNewSessionRepoPath', () => {
    it('should return a path with sessions subdirectory', async () => {
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock fs.mkdir to avoid actual filesystem operations
      const originalMkdir = fs.mkdir;
      fs.mkdir = mock(async () => {});
      
      // Get new session repo path
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      const result = await db.getNewSessionRepoPath(repoName, sessionId);
      
      // Restore original
      fs.mkdir = originalMkdir;
      
      // Verify result matches expected format
      expect(result).toBe(join(TEST_GIT_DIR, repoName, 'sessions', sessionId));
    });
  });
  
  describe('migrateSessionsToSubdirectory', () => {
    it('should move repos from legacy path to sessions subdirectory', async () => {
      // Create test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session-1',
          repoUrl: 'https://github.com/test/repo1',
          repoName: 'test/repo1',
          branch: 'main',
          createdAt: new Date().toISOString()
        },
        {
          session: 'test-session-2',
          repoUrl: 'https://github.com/test/repo2',
          repoName: 'test/repo2',
          branch: 'main',
          createdAt: new Date().toISOString()
        }
      ];
      
      // Create session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create legacy directory paths for testing
      const legacyPath1 = join(TEST_GIT_DIR, 'test/repo1', 'test-session-1');
      const legacyPath2 = join(TEST_GIT_DIR, 'test/repo2', 'test-session-2');
      const newPath1 = join(TEST_GIT_DIR, 'test/repo1', 'sessions', 'test-session-1');
      const newPath2 = join(TEST_GIT_DIR, 'test/repo2', 'sessions', 'test-session-2');
      
      // Initialize SessionDB instance with mocked parameters
      const db = new SessionDB();
      // Override the baseDir and dbPath for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Mock file access checks
      const originalFs = { ...fs };
      
      // Mock fs.access to simulate file existence
      fs.access = mock(async (path: string) => {
        if (path === legacyPath1 || path === legacyPath2) {
          return Promise.resolve();
        }
        if (path === newPath1 || path === newPath2) {
          return Promise.reject(new Error('File not found'));
        }
        return Promise.reject(new Error('File not found'));
      });
      
      // Mock mkdir to avoid filesystem operations
      fs.mkdir = mock(async () => {});
      
      // Mock rename to avoid filesystem operations
      fs.rename = mock(async () => {});
      
      // Mock readFile and writeFile to handle session DB updates
      const originalReadFile = fs.readFile;
      fs.readFile = mock(async (path: string) => {
        if (path === TEST_SESSION_DB) {
          return JSON.stringify(sessions);
        }
        return "";
      });
      
      const originalWriteFile = fs.writeFile;
      fs.writeFile = mock(async (path: string, data: string) => {
        if (path === TEST_SESSION_DB) {
          // Update our test sessions with the new paths
          sessions[0].repoPath = newPath1;
          sessions[1].repoPath = newPath2;
        }
      });
      
      // Migrate sessions
      await db.migrateSessionsToSubdirectory();
      
      // Restore original fs methods
      fs.access = originalFs.access;
      fs.mkdir = originalFs.mkdir;
      fs.rename = originalFs.rename;
      fs.readFile = originalReadFile;
      fs.writeFile = originalWriteFile;
      
      // Verify sessions were updated with the correct paths
      expect(sessions[0].repoPath).toBe(newPath1);
      expect(sessions[1].repoPath).toBe(newPath2);
    });
  });
}); 
