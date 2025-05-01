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
      // Set up test data
      const sessions: SessionRecord[] = [
        {
          session: 'test-session-1',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
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
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create test session directories
      const sessionDir1 = join(TEST_GIT_DIR, 'test/repo', 'sessions', 'test-session-1');
      const sessionDir2 = join(TEST_GIT_DIR, 'test/repo2', 'sessions', 'test-session-2');
      mkdirSync(sessionDir1, { recursive: true });
      mkdirSync(sessionDir2, { recursive: true });
      
      // Create a test file in each session directory
      writeFileSync(join(sessionDir1, 'test-file.txt'), 'test content');
      writeFileSync(join(sessionDir2, 'test-file.txt'), 'test content');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Delete the first session
      const result = await db.deleteSession('test-session-1');
      
      // Verify result
      expect(result).toBe(true);
      
      // Verify session was removed from database
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].session).toBe('test-session-2');
      
      // Verify session directory still exists (since the domain module only removes from DB)
      expect(existsSync(sessionDir1)).toBe(true);
    });
    
    it('should return false if session does not exist', async () => {
      // Set up test data
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
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Try to delete a non-existent session
      const result = await db.deleteSession('non-existent-session');
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify database is unchanged
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(1);
      expect(remainingSessions[0].session).toBe('test-session');
    });
    
    it('should handle empty database gracefully', async () => {
      // Create empty test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify([]));
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify database is still empty
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(0);
    });
    
    it('should handle non-existent database gracefully', async () => {
      // Ensure database doesn't exist
      if (existsSync(TEST_SESSION_DB)) {
        unlinkSync(TEST_SESSION_DB);
      }
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
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
      // Set up session record
      const sessionRecord: SessionRecord = {
        session: 'test-session',
        repoUrl: 'https://github.com/test/repo',
        repoName: 'test/repo',
        branch: 'main',
        createdAt: new Date().toISOString()
      };
      
      // Create legacy path
      const legacyPath = join(TEST_GIT_DIR, 'test/repo', 'test-session');
      mkdirSync(join(TEST_GIT_DIR, 'test/repo'), { recursive: true });
      mkdirSync(legacyPath, { recursive: true });
      
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock the repoExists method to simulate legacy path exists but new path doesn't
      const originalRepoExists = (db as any).repoExists;
      (db as any).repoExists = async (path: string) => {
        return path === legacyPath; // Only legacy path exists
      };

      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(legacyPath);
    });
    
    it('should return the new path if sessions directory exists', async () => {
      // Set up session record
      const sessionRecord: SessionRecord = {
        session: 'test-session',
        repoUrl: 'https://github.com/test/repo',
        repoName: 'test/repo',
        branch: 'main',
        createdAt: new Date().toISOString()
      };
      
      // Create new path
      const newPath = join(TEST_GIT_DIR, 'test/repo', 'sessions', 'test-session');
      mkdirSync(join(TEST_GIT_DIR, 'test/repo', 'sessions'), { recursive: true });
      mkdirSync(newPath, { recursive: true });
      
      // Initialize SessionDB instance with mocked baseDir
      const db = new SessionDB();
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock the repoExists method to simulate only new path exists
      const originalRepoExists = (db as any).repoExists;
      (db as any).repoExists = async (path: string) => {
        return path === newPath; // Only new path exists
      };

      // Get repo path
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(newPath);
    });
    
    it('should prefer new path over legacy path if both exist', async () => {
      // Set up session record
      const sessionRecord: SessionRecord = {
        session: 'test-session',
        repoUrl: 'https://github.com/test/repo',
        repoName: 'test/repo',
        branch: 'main',
        createdAt: new Date().toISOString()
      };
      
      // Create both paths
      const legacyPath = join(TEST_GIT_DIR, 'test/repo', 'test-session');
      const newPath = join(TEST_GIT_DIR, 'test/repo', 'sessions', 'test-session');
      mkdirSync(join(TEST_GIT_DIR, 'test/repo'), { recursive: true });
      mkdirSync(legacyPath, { recursive: true });
      mkdirSync(join(TEST_GIT_DIR, 'test/repo', 'sessions'), { recursive: true });
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
      const result = await db.getRepoPath(sessionRecord);
      
      // Restore original method
      (db as any).repoExists = originalRepoExists;
      
      // Verify result
      expect(result).toBe(newPath);
    });
  });
  
  describe('getNewSessionRepoPath', () => {
    it('should return a path with sessions subdirectory', () => {
      const db = new SessionDB();
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      
      // Override the baseDir for testing
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Call the method - it's a synchronous method
      const result = db.getNewSessionRepoPath(repoName, sessionId);
      
      // Verify result matches expected format - it's a string, not a Promise
      expect(typeof result).toBe('string');
      expect(result).toBe(join(TEST_GIT_DIR, repoName, 'sessions', sessionId));
    });
  });
  
  describe('migrateSessionsToSubdirectory', () => {
    it('should move repos from legacy path to sessions subdirectory', async () => {
      // Set up sessions for testing
      const sessions = [
        {
          session: 'test-session-1',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString()
        },
        {
          session: 'test-session-2',
          repoUrl: 'https://github.com/test/repo',
          repoName: 'test/repo',
          branch: 'main',
          createdAt: new Date().toISOString()
        }
      ];
      
      // Write sessions to test DB
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create test session directories in legacy format
      const legacyPath1 = join(TEST_GIT_DIR, 'test/repo', 'test-session-1');
      const legacyPath2 = join(TEST_GIT_DIR, 'test/repo', 'test-session-2');
      const newPath1 = join(TEST_GIT_DIR, 'test/repo', 'sessions', 'test-session-1');
      const newPath2 = join(TEST_GIT_DIR, 'test/repo', 'sessions', 'test-session-2');
      
      mkdirSync(join(TEST_GIT_DIR, 'test/repo'), { recursive: true });
      mkdirSync(legacyPath1, { recursive: true });
      mkdirSync(legacyPath2, { recursive: true });
      
      // Create a test file in each session directory
      writeFileSync(join(legacyPath1, 'test-file.txt'), 'test content');
      writeFileSync(join(legacyPath2, 'test-file.txt'), 'test content');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      // Override the dbPath and baseDir for testing
      Object.defineProperty(db, 'dbPath', { value: TEST_SESSION_DB });
      Object.defineProperty(db, 'baseDir', { value: TEST_GIT_DIR });
      
      // Mock readDb, writeDb, and repoExists
      const originalReadDb = (db as any).readDb;
      const originalWriteDb = (db as any).writeDb;
      const originalRepoExists = (db as any).repoExists;
      
      // Mock readDb to return our test sessions
      (db as any).readDb = async () => sessions;
      
      // Mock writeDb to write to the test file
      (db as any).writeDb = async (updatedSessions: SessionRecord[]) => {
        await fs.writeFile(TEST_SESSION_DB, JSON.stringify(updatedSessions));
        sessions.length = 0;
        sessions.push(...updatedSessions);
      };
      
      // Mock repoExists to return true for the legacy paths
      (db as any).repoExists = async (path: string) => {
        return path === legacyPath1 || path === legacyPath2;
      };
      
      // Mock fs.rename to not actually move files (to avoid file system issues in tests)
      const originalRename = fs.rename;
      fs.rename = mock(async () => {});
      
      // Call the method
      await db.migrateSessionsToSubdirectory();
      
      // Restore original methods
      (db as any).readDb = originalReadDb;
      (db as any).writeDb = originalWriteDb;
      (db as any).repoExists = originalRepoExists;
      fs.rename = originalRename;
      
      // Verify sessions were updated with the new path
      expect(sessions[0].repoPath).toBeDefined();
      expect(sessions[1].repoPath).toBeDefined();
      expect(sessions[0].repoPath && sessions[0].repoPath.includes('sessions')).toBe(true);
      expect(sessions[1].repoPath && sessions[1].repoPath.includes('sessions')).toBe(true);
    });
  });
}); 
