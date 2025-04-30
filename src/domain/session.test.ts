import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionDB } from './session';
import type { SessionRecord } from './session';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';

describe('SessionDB', () => {
  const TEST_DIR = '/tmp/minsky-test';
  const TEST_STATE_DIR = join(TEST_DIR, 'minsky');
  const TEST_SESSION_DB = join(TEST_STATE_DIR, 'session-db.json');
  const TEST_GIT_DIR = join(TEST_STATE_DIR, 'git');
  
  // Set up test environment
  beforeEach(async () => {
    // Create test directories
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    mkdirSync(TEST_GIT_DIR, { recursive: true });
    
    // Set XDG_STATE_HOME for tests
    process.env.XDG_STATE_HOME = TEST_DIR;
  });
  
  // Clean up test environment
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.XDG_STATE_HOME;
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
      const sessionDir1 = join(TEST_GIT_DIR, 'test/repo', 'test-session-1');
      const sessionDir2 = join(TEST_GIT_DIR, 'test/repo2', 'test-session-2');
      mkdirSync(sessionDir1, { recursive: true });
      mkdirSync(sessionDir2, { recursive: true });
      
      // Create a test file in each session directory
      writeFileSync(join(sessionDir1, 'test-file.txt'), 'test content');
      writeFileSync(join(sessionDir2, 'test-file.txt'), 'test content');
      
      // Initialize SessionDB instance
      const db = new SessionDB();
      
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
      
      // Database handling is implementation-specific and may or may not create an empty file
    });
  });
}); 
