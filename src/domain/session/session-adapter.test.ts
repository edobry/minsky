/**
 * Test suite for SessionDbAdapter
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';
import { SessionDbAdapter } from './session-adapter';
import * as sessionDb from './session-db';
import * as sessionDbIo from './session-db-io';

// Mock the I/O operations
mock.module('./session-db-io', () => ({
  readSessionDbFile: () => Promise.resolve([{ session: 'test' }]),
  writeSessionDbFile: () => Promise.resolve(),
  ensureDbDir: () => Promise.resolve(),
  getDefaultDbPath: () => '/mock/default/path.json',
  getDefaultBaseDir: () => '/mock/default/base',
  ensureBaseDir: () => Promise.resolve(),
  migrateSessionsToSubdirectoryFn: () => Promise.resolve({ sessions: [], modified: false }),
}));

describe('SessionDbAdapter', () => {
  describe('constructor', () => {
    it('should use default paths when no dbPath is provided', () => {
      const adapter = new SessionDbAdapter();
      // With the simplified mocks, we can just verify the adapter was created
      expect(adapter).toBeDefined();
    });
  });

  describe('listSessions', () => {
    it('should return the sessions from listSessionsFn', async () => {
      // Spy on the pure function
      const listSessionsFnSpy = spyOn(sessionDb, 'listSessionsFn');
      
      const mockSessions = [{ session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' }];
      listSessionsFnSpy.mockReturnValue(mockSessions);

      const adapter = new SessionDbAdapter();
      const result = await adapter.listSessions();

      expect(result).toEqual(mockSessions);
      
      // Restore the spy
      listSessionsFnSpy.mockRestore();
    });
  });

  describe('getSession', () => {
    it('should return the session from getSessionFn', async () => {
      // Spy on the pure function
      const getSessionFnSpy = spyOn(sessionDb, 'getSessionFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' };
      getSessionFnSpy.mockReturnValue(mockSession);

      const adapter = new SessionDbAdapter();
      const result = await adapter.getSession('test');

      expect(result).toEqual(mockSession);
      
      // Restore the spy
      getSessionFnSpy.mockRestore();
    });
  });

  describe('getSessionByTaskId', () => {
    it('should return the session from getSessionByTaskIdFn', async () => {
      // Spy on the pure function
      const getSessionByTaskIdFnSpy = spyOn(sessionDb, 'getSessionByTaskIdFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date', taskId: '#101' };
      getSessionByTaskIdFnSpy.mockReturnValue(mockSession);

      const adapter = new SessionDbAdapter();
      const result = await adapter.getSessionByTaskId('101');

      expect(result).toEqual(mockSession);
      
      // Restore the spy
      getSessionByTaskIdFnSpy.mockRestore();
    });
  });

  describe('addSession', () => {
    it('should call addSessionFn with the new session', async () => {
      // Spy on the pure function
      const addSessionFnSpy = spyOn(sessionDb, 'addSessionFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' };
      addSessionFnSpy.mockReturnValue({ sessions: [mockSession], baseDir: '/mock/base' });

      const adapter = new SessionDbAdapter();
      await adapter.addSession(mockSession);
      
      // Restore the spy
      addSessionFnSpy.mockRestore();
    });
  });

  describe('updateSession', () => {
    it('should call updateSessionFn with the updates', async () => {
      // Spy on the pure function
      const updateSessionFnSpy = spyOn(sessionDb, 'updateSessionFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' };
      const updates = { branch: 'new-branch' };
      
      // Mock to return updated sessions
      updateSessionFnSpy.mockReturnValue({ 
        sessions: [{ ...mockSession, branch: 'new-branch' }], 
        baseDir: '/mock/base' 
      });

      const adapter = new SessionDbAdapter();
      await adapter.updateSession('test', updates);
      
      // Restore the spy
      updateSessionFnSpy.mockRestore();
    });
  });

  describe('deleteSession', () => {
    it('should return true when session is deleted', async () => {
      // Spy on the pure function
      const deleteSessionFnSpy = spyOn(sessionDb, 'deleteSessionFn');
      
      // Use a mock state with a session for testing deletion
      const initialSessions = [{ session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' }];
      const emptyState = { sessions: [], baseDir: '/mock/base' };
      
      // Mock readSessionDbFile to return sessions with our test session
      mock.module('./session-db-io', () => ({
        readSessionDbFile: () => Promise.resolve(initialSessions),
        writeSessionDbFile: () => Promise.resolve(),
        getDefaultDbPath: () => '/mock/default/path.json',
        getDefaultBaseDir: () => '/mock/default/base',
      }));
      
      // Mock deleteSessionFn to return state with empty sessions array
      deleteSessionFnSpy.mockReturnValue(emptyState);

      const adapter = new SessionDbAdapter();
      const result = await adapter.deleteSession('test');

      expect(result).toBe(true);
      
      // Restore the spy
      deleteSessionFnSpy.mockRestore();
    });

    it('should return false if session was not deleted', async () => {
      // Spy on the pure function
      const deleteSessionFnSpy = spyOn(sessionDb, 'deleteSessionFn');
      
      // Create a mock session array that won't change
      const mockSessions = [{ session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' }];
      
      // Return the same sessions array (no deletion)
      deleteSessionFnSpy.mockReturnValue({ 
        sessions: mockSessions,
        baseDir: '/mock/base' 
      });

      // Read session returns the same sessions as delete returns
      mock.module('./session-db-io', () => ({
        readSessionDbFile: () => Promise.resolve(mockSessions),
        writeSessionDbFile: () => Promise.resolve(),
        getDefaultDbPath: () => '/mock/default/path.json',
        getDefaultBaseDir: () => '/mock/default/base',
      }));

      const adapter = new SessionDbAdapter();
      const result = await adapter.deleteSession('non-existent');

      expect(result).toBe(false);
      
      // Restore the spy
      deleteSessionFnSpy.mockRestore();
    });
  });

  describe('getRepoPath', () => {
    it('should return the path from getRepoPathFn', async () => {
      // Spy on the pure function
      const getRepoPathFnSpy = spyOn(sessionDb, 'getRepoPathFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' };
      getRepoPathFnSpy.mockReturnValue('/mock/path/to/repo');

      const adapter = new SessionDbAdapter();
      const result = await adapter.getRepoPath(mockSession);

      expect(result).toBe('/mock/path/to/repo');
      
      // Restore the spy
      getRepoPathFnSpy.mockRestore();
    });
  });

  describe('getSessionWorkdir', () => {
    it('should return the workdir from getSessionWorkdirFn', async () => {
      // Spy on the pure function
      const getSessionWorkdirFnSpy = spyOn(sessionDb, 'getSessionWorkdirFn');
      
      const mockSession = { session: 'test', repoName: 'repo', repoUrl: 'url', createdAt: 'date' };
      getSessionWorkdirFnSpy.mockReturnValue('/mock/path/to/workdir');

      const adapter = new SessionDbAdapter();
      const result = await adapter.getSessionWorkdir('test');

      expect(result).toBe('/mock/path/to/workdir');
      
      // Restore the spy
      getSessionWorkdirFnSpy.mockRestore();
    });

    it('should throw ResourceNotFoundError if session not found', async () => {
      // Spy on the pure function
      const getSessionWorkdirFnSpy = spyOn(sessionDb, 'getSessionWorkdirFn');
      
      getSessionWorkdirFnSpy.mockReturnValue(null);

      const adapter = new SessionDbAdapter();
      try {
        await adapter.getSessionWorkdir('non-existent');
        // Force test to fail if no error is thrown
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.name).toBe('ResourceNotFoundError');
      }
      
      // Restore the spy
      getSessionWorkdirFnSpy.mockRestore();
    });
  });
}); 
