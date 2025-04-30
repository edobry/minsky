import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SessionDB } from './session';
import type { SessionRecord } from './session';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';

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
        }
      ];
      
      // Create test session database
      writeFileSync(TEST_SESSION_DB, JSON.stringify(sessions));
      
      // Create test session directories (both legacy and new structure)
      const legacySessionDir = join(TEST_GIT_DIR, 'test/repo', 'test-session-1');
      mkdirSync(join(TEST_GIT_DIR, 'test/repo'), { recursive: true });
      mkdirSync(legacySessionDir, { recursive: true });
      writeFileSync(join(legacySessionDir, 'test-file.txt'), 'test content');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Delete the session
      const result = await db.deleteSession('test-session-1');
      
      // Verify result
      expect(result).toBe(true);
      
      // Verify session was removed from database
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(0);
      
      // Verify session directory still exists (since the domain module only removes from DB)
      expect(existsSync(legacySessionDir)).toBe(true);
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
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify database is still empty
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(0);
    });
    
    it('should handle non-existent database gracefully', async () => {
      // Do not create session database file
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Try to delete a session
      const result = await db.deleteSession('test-session');
      
      // Verify result
      expect(result).toBe(false);
      
      // Verify empty database was created
      expect(existsSync(TEST_SESSION_DB)).toBe(true);
      const remainingSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(remainingSessions.length).toBe(0);
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
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
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
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
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
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Get repo path
      const result = await db.getRepoPath(repoName, sessionId);
      
      // Verify result
      expect(result).toBe(newPath);
    });
  });
  
  describe('getNewSessionRepoPath', () => {
    it('should return a path with sessions subdirectory', async () => {
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Get new session repo path
      const repoName = 'test/repo';
      const sessionId = 'test-session';
      const result = await db.getNewSessionRepoPath(repoName, sessionId);
      
      // Verify result
      const expectedPath = join(TEST_GIT_DIR, repoName, 'sessions', sessionId);
      expect(result).toBe(expectedPath);
      
      // Verify sessions directory was created
      expect(existsSync(join(TEST_GIT_DIR, repoName, 'sessions'))).toBe(true);
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
      
      // Create legacy directories
      const legacyPath1 = join(TEST_GIT_DIR, 'test/repo1', 'test-session-1');
      const legacyPath2 = join(TEST_GIT_DIR, 'test/repo2', 'test-session-2');
      mkdirSync(join(TEST_GIT_DIR, 'test/repo1'), { recursive: true });
      mkdirSync(legacyPath1, { recursive: true });
      mkdirSync(join(TEST_GIT_DIR, 'test/repo2'), { recursive: true });
      mkdirSync(legacyPath2, { recursive: true });
      
      // Create test files
      writeFileSync(join(legacyPath1, 'test-file-1.txt'), 'test content 1');
      writeFileSync(join(legacyPath2, 'test-file-2.txt'), 'test content 2');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
      // Migrate sessions
      await db.migrateSessionsToSubdirectory();
      
      // Verify migration
      const newPath1 = join(TEST_GIT_DIR, 'test/repo1', 'sessions', 'test-session-1');
      const newPath2 = join(TEST_GIT_DIR, 'test/repo2', 'sessions', 'test-session-2');
      
      // Check that new directories exist with the files
      expect(existsSync(newPath1)).toBe(true);
      expect(existsSync(newPath2)).toBe(true);
      expect(existsSync(join(newPath1, 'test-file-1.txt'))).toBe(true);
      expect(existsSync(join(newPath2, 'test-file-2.txt'))).toBe(true);
      
      // Check that legacy directories no longer exist
      expect(existsSync(legacyPath1)).toBe(false);
      expect(existsSync(legacyPath2)).toBe(false);
      
      // Check that session records were updated
      const updatedSessions = JSON.parse(await fs.readFile(TEST_SESSION_DB, 'utf-8'));
      expect(updatedSessions[0].repoPath).toBe(newPath1);
      expect(updatedSessions[1].repoPath).toBe(newPath2);
    });
  });
}); 
