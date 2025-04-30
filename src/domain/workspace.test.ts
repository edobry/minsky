import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { join } from 'path';
import { promises as fs } from 'fs';

// For Bun testing, use mock.module to mock modules
const mockExecOutput = {
  stdout: '',
  stderr: '',
};

// Mock the exec function
const mockExecAsync = mock(async (cmd: string, options: any) => ({ 
  stdout: mockExecOutput.stdout, 
  stderr: mockExecOutput.stderr 
}));

// Mock the modules
mock.module('child_process', () => ({
  exec: () => {},
}));

mock.module('util', () => ({
  promisify: () => mockExecAsync,
}));

// Mock the SessionDB
mock.module('./session', () => {
  return {
    SessionDB: function() {
      return {
        getSession: async (sessionName: string) => {
          if (sessionName === 'existingSession') {
            return {
              session: 'existingSession',
              repoUrl: '/path/to/main/workspace',
              repoName: 'workspace',
              createdAt: new Date().toISOString()
            };
          }
          return undefined;
        },
        getRepoPath: async (repoName: string, sessionId: string) => {
          return `/path/to/${repoName}/${sessionId}`;
        },
        getNewSessionRepoPath: async (repoName: string, sessionId: string) => {
          return `/path/to/${repoName}/sessions/${sessionId}`;
        },
        deleteSession: async (sessionName: string) => {
          return sessionName === 'test-session-1' || sessionName === 'test-session';
        }
      };
    }
  };
});

// Import our modules after mocking
import { isSessionRepository, getSessionFromRepo, resolveWorkspacePath } from './workspace';

// Helper function for workspace repo detection
async function checkSessionRepository(repoPath: string): Promise<boolean> {
  try {
    // Use our mock instead of the real execAsync
    const { stdout } = await mockExecAsync('git rev-parse --show-toplevel', { cwd: repoPath });
    const gitRoot = stdout.trim();
    
    // Check if the git root contains a session marker
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    const minskyPath = join(xdgStateHome, 'minsky', 'git');
    
    return gitRoot.startsWith(minskyPath);
  } catch (error) {
    return false;
  }
}

// Helper function for session repo info
async function getRepoSessionInfo(repoPath: string): Promise<{ session: string, mainWorkspace: string } | null> {
  try {
    // Use our mock instead of the real execAsync
    const { stdout } = await mockExecAsync('git rev-parse --show-toplevel', { cwd: repoPath });
    const gitRoot = stdout.trim();
    
    // Check if this is in the minsky sessions directory structure
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    const minskyPath = join(xdgStateHome, 'minsky', 'git');
    
    if (!gitRoot.startsWith(minskyPath)) {
      return null;
    }
    
    // Extract session name
    const sessionName = gitRoot.includes('/sessions/') 
      ? gitRoot.split('/sessions/')[1] 
      : gitRoot.split('/').pop();
      
    // Use our mock SessionDB
    if (sessionName === 'existingSession') {
      return {
        session: 'existingSession',
        mainWorkspace: '/path/to/main/workspace'
      };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

describe('Workspace Utils', () => {
  beforeEach(() => {
    mockExecOutput.stdout = '';
    mockExecOutput.stderr = '';
    mockExecAsync.mockClear();
  });

  describe('isSessionRepository', () => {
    it('should return true for a legacy session repository path', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'session-name');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await isSessionRepository('/some/repo/path');
      
      expect(result).toBe(true);
    });

    it('should return true for a new session repository path with sessions subdirectory', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'sessions', 'session-name');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await isSessionRepository('/some/repo/path');
      
      expect(result).toBe(true);
    });

    it('should return false for a non-session repository path', async () => {
      mockExecOutput.stdout = '/Users/username/Projects/repo';
      
      const result = await isSessionRepository('/some/repo/path');
      
      expect(result).toBe(false);
    });

    it('should return false if an error occurs', async () => {
      mockExecAsync.mockImplementationOnce(() => {
        throw new Error('Command failed');
      });
      
      const result = await isSessionRepository('/some/repo/path');
      
      expect(result).toBe(false);
    });
  });

  describe('getSessionFromRepo', () => {
    it('should extract session info from a legacy session repository path', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'existingSession');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo('/some/repo/path');
      
      expect(result).toEqual({
        session: 'existingSession',
        mainWorkspace: '/path/to/main/workspace'
      });
    });

    it('should extract session info from a new session repository path with sessions subdirectory', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'sessions', 'existingSession');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo('/some/repo/path');
      
      expect(result).toEqual({
        session: 'existingSession',
        mainWorkspace: '/path/to/main/workspace'
      });
    });

    it('should return null for a non-session repository path', async () => {
      mockExecOutput.stdout = '/Users/username/Projects/repo';
      
      const result = await getSessionFromRepo('/some/repo/path');
      
      expect(result).toBeNull();
    });

    it('should return null if the session record is not found', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'nonExistingSession');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await getSessionFromRepo('/some/repo/path');
      
      expect(result).toBeNull();
    });

    it('should return null if an error occurs', async () => {
      mockExecAsync.mockImplementationOnce(() => {
        throw new Error('Command failed');
      });
      
      const result = await getSessionFromRepo('/some/repo/path');
      
      expect(result).toBeNull();
    });
  });

  describe('resolveWorkspacePath', () => {
    it('should use explicitly provided workspace path', async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = mock(() => Promise.resolve());
      
      const result = await resolveWorkspacePath({ workspace: '/path/to/workspace' });
      
      expect(result).toBe('/path/to/workspace');
      
      // Restore original
      fs.access = originalAccess;
    });

    it('should throw error if workspace path is invalid', async () => {
      // Mock fs.access
      const originalAccess = fs.access;
      fs.access = mock(() => Promise.reject(new Error('File not found')));
      
      await expect(resolveWorkspacePath({ workspace: '/invalid/path' }))
        .rejects.toThrow('Invalid workspace path: /invalid/path. Path must be a valid Minsky workspace.');
      
      // Restore original
      fs.access = originalAccess;
    });

    it('should use main workspace path if in a session repo', async () => {
      const home = process.env.HOME || '';
      const xdgStateHome = process.env.XDG_STATE_HOME || join(home, '.local/state');
      const sessionPath = join(xdgStateHome, 'minsky', 'git', 'local', 'repo', 'existingSession');
      
      mockExecOutput.stdout = sessionPath;
      
      const result = await resolveWorkspacePath({ sessionRepo: '/some/session/path' });
      
      expect(result).toBe('/path/to/main/workspace');
    });

    it('should use current directory if not in a session repo', async () => {
      mockExecOutput.stdout = '/Users/username/Projects/repo';
      
      const result = await resolveWorkspacePath({ sessionRepo: '/some/non/session/path' });
      
      expect(result).toBe('/some/non/session/path');
    });

    it('should use current directory if no options provided', async () => {
      mockExecOutput.stdout = '/Users/username/Projects/repo';
      
      const originalCwd = process.cwd;
      process.cwd = mock(() => '/current/directory');
      
      const result = await resolveWorkspacePath();
      
      expect(result).toBe('/current/directory');
      
      // Restore original
      process.cwd = originalCwd;
    });
  });
}); 
