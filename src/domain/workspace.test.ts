import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import { promises as fs } from 'fs';
import { isSessionRepository, getSessionFromRepo, resolveWorkspacePath } from './workspace';

describe('Workspace Utils', () => {
  describe('isSessionRepository', () => {
    it('should return true for a session repository path', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'session-name');
      
      // Create mock execAsync that returns a session repository path
      const mockExecAsync = mock(async () => ({ 
        stdout: sessionPath,
        stderr: '' 
      }));
      
      // Call the function with the mock
      const result = await isSessionRepository('/some/repo/path', mockExecAsync);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBe(true);
    });

    it('should return false for a non-session repository path', async () => {
      // Create mock execAsync that returns a non-session repository path
      const mockExecAsync = mock(async () => ({ 
        stdout: '/Users/username/Projects/repo',
        stderr: '' 
      }));
      
      // Call the function with the mock
      const result = await isSessionRepository('/some/repo/path', mockExecAsync);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBe(false);
    });

    it('should return false if an error occurs', async () => {
      // Create mock execAsync that throws an error
      const mockExecAsync = mock(async () => { 
        throw new Error('Command failed');
      });
      
      // Call the function with the mock
      const result = await isSessionRepository('/some/repo/path', mockExecAsync);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBe(false);
    });
  });

  describe('getSessionFromRepo', () => {
    it('should extract session info from a session repository path', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'existingSession');
      
      // Create mock execAsync that returns a session repository path
      const mockExecAsync = mock(async () => ({ 
        stdout: sessionPath,
        stderr: '' 
      }));
      
      // Create mock SessionDB
      const mockSessionDB = {
        getSession: mock(async () => ({
          session: 'existingSession',
          repoUrl: '/path/to/main/workspace',
          repoName: 'workspace',
          createdAt: new Date().toISOString()
        }))
      };
      
      // Call the function with the mocks
      const result = await getSessionFromRepo('/some/repo/path', mockExecAsync, mockSessionDB);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toEqual({
        session: 'existingSession',
        mainWorkspace: '/path/to/main/workspace'
      });
    });

    it('should return null for a non-session repository path', async () => {
      // Create mock execAsync that returns a non-session repository path
      const mockExecAsync = mock(async () => ({ 
        stdout: '/Users/username/Projects/repo',
        stderr: '' 
      }));
      
      // Call the function with the mock
      const result = await getSessionFromRepo('/some/repo/path', mockExecAsync);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBeNull();
    });

    it('should return null if the session record is not found', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'nonExistingSession');
      
      // Create mock execAsync that returns a session repository path
      const mockExecAsync = mock(async () => ({ 
        stdout: sessionPath,
        stderr: '' 
      }));
      
      // Create mock SessionDB that returns null (no session found)
      const mockSessionDB = {
        getSession: mock(async () => null)
      };
      
      // Call the function with the mocks
      const result = await getSessionFromRepo('/some/repo/path', mockExecAsync, mockSessionDB);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBeNull();
    });

    it('should return null if an error occurs', async () => {
      // Create mock execAsync that throws an error
      const mockExecAsync = mock(async () => { 
        throw new Error('Command failed');
      });
      
      // Call the function with the mock
      const result = await getSessionFromRepo('/some/repo/path', mockExecAsync);
      
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel', { cwd: '/some/repo/path' });
      expect(result).toBeNull();
    });
  });

  describe('resolveWorkspacePath', () => {
    it('should use explicitly provided workspace path', async () => {
      // Mock fs.access
      const mockFsAccess = mock(() => Promise.resolve());
      
      // Call the function with the mock
      const result = await resolveWorkspacePath({ 
        workspace: '/path/to/workspace' 
      }, { access: mockFsAccess });
      
      expect(result).toBe('/path/to/workspace');
      expect(mockFsAccess).toHaveBeenCalledWith(join('/path/to/workspace', 'process'));
    });

    it('should throw error if workspace path is invalid', async () => {
      // Mock fs.access that rejects
      const mockFsAccess = mock(() => Promise.reject(new Error('File not found')));
      
      // Call the function with the mock
      await expect(resolveWorkspacePath({ 
        workspace: '/invalid/path' 
      }, { access: mockFsAccess })).rejects.toThrow('Invalid workspace path: /invalid/path');
      
      expect(mockFsAccess).toHaveBeenCalledWith(join('/invalid/path', 'process'));
    });

    it('should use main workspace path if in a session repo', async () => {
      // Mock getSessionFromRepo
      const mockGetSessionFromRepo = mock(async () => ({
        session: 'existingSession',
        mainWorkspace: '/path/to/main/workspace'
      }));
      
      // Call the function with the mock
      const result = await resolveWorkspacePath({ 
        sessionRepo: '/some/session/path' 
      }, { getSessionFromRepo: mockGetSessionFromRepo });
      
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith('/some/session/path');
      expect(result).toBe('/path/to/main/workspace');
    });

    it('should strip file:// protocol from mainWorkspace', async () => {
      // Mock getSessionFromRepo that returns a file:// URL
      const mockGetSessionFromRepo = mock(async () => ({
        session: 'existingSession',
        mainWorkspace: 'file:///path/to/main/workspace'
      }));
      
      // Call the function with the mock
      const result = await resolveWorkspacePath({ 
        sessionRepo: '/some/session/path' 
      }, { getSessionFromRepo: mockGetSessionFromRepo });
      
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith('/some/session/path');
      expect(result).toBe('/path/to/main/workspace');
    });

    it('should use current directory if not in a session repo', async () => {
      // Mock getSessionFromRepo that returns null
      const mockGetSessionFromRepo = mock(async () => null);
      
      // Call the function with the mock
      const result = await resolveWorkspacePath({ 
        sessionRepo: '/some/non/session/path' 
      }, { getSessionFromRepo: mockGetSessionFromRepo });
      
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith('/some/non/session/path');
      expect(result).toBe('/some/non/session/path');
    });

    it('should use current directory if no options provided', async () => {
      // Mock getSessionFromRepo that returns null
      const mockGetSessionFromRepo = mock(async () => null);
      
      // Mock process.cwd
      const originalCwd = process.cwd;
      process.cwd = mock(() => '/current/directory');
      
      // Call the function with the mock
      const result = await resolveWorkspacePath(
        undefined,
        { getSessionFromRepo: mockGetSessionFromRepo }
      );
      
      expect(mockGetSessionFromRepo).toHaveBeenCalledWith('/current/directory');
      expect(result).toBe('/current/directory');
      
      // Restore original
      process.cwd = originalCwd;
    });
  });
}); 
