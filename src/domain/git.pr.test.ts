import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { GitService } from './git';
import type { PrOptions, PrTestDependencies } from './git';

// Define better types for our mocks
type ExecAsyncFn = ((command: string, options?: any) => Promise<{stdout: string, stderr: string}>) & {
  mock: {
    calls: [string, any?][];
  };
};
type GetSessionFn = (sessionName: string) => Promise<any>;
type GetSessionWorkdirFn = (repoName: string, session: string) => string;

describe('GitService.pr method', () => {
  let git: GitService;
  let mockExecAsync: ExecAsyncFn;
  let mockGetSession: GetSessionFn;
  let mockGetSessionWorkdir: GetSessionWorkdirFn;
  let deps: PrTestDependencies;

  beforeEach(() => {
    // Reset mocks before each test
    mockExecAsync = mock((cmd: string, options?: any) => {
      // Default mock responses
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return Promise.resolve({ stdout: 'feature\n', stderr: '' });
      }
      if (cmd.includes('remote show origin')) {
        return Promise.resolve({ stdout: 'HEAD branch: main\n', stderr: '' });
      }
      if (cmd.includes('merge-base')) {
        return Promise.resolve({ stdout: 'abc123\n', stderr: '' });
      }
      if (cmd.includes('diff --name-status')) {
        return Promise.resolve({ stdout: 'A\tfeature.txt\nM\tfeature2.txt\n', stderr: '' });
      }
      if (cmd.includes('diff --shortstat')) {
        return Promise.resolve({ stdout: ' 2 files changed, 10 insertions(+), 5 deletions(-)\n', stderr: '' });
      }
      if (cmd.includes('log')) {
        return Promise.resolve({
          stdout: 'abc123\x1fAdd feature2.txt\x1fDetailed description\x1edef456\x1fAdd feature.txt\x1f\x1e',
          stderr: ''
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    }) as ExecAsyncFn;

    mockGetSession = mock(() => Promise.resolve(null));
    mockGetSessionWorkdir = mock(() => '/mock/path');

    deps = {
      execAsync: mockExecAsync,
      getSession: mockGetSession,
      getSessionWorkdir: mockGetSessionWorkdir
    };

    git = new GitService();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('basic PR generation', () => {
    it('should generate PR diff against main branch', async () => {
      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, deps);
      
      // Verify markdown content
      expect(result.markdown).toContain('Pull Request for branch `feature`');
      expect(result.markdown).toContain('Changes compared to merge-base with main');
      expect(result.markdown).toContain('feature.txt');
      expect(result.markdown).toContain('feature2.txt');
      expect(result.markdown).toContain('2 files changed');
      expect(result.markdown).toContain('Add feature2.txt');
      expect(result.markdown).toContain('Add feature.txt');

      // Verify git commands were called
      const calls = mockExecAsync.mock.calls;
      expect(calls.some(([cmd]) => cmd === 'git -C /test/repo remote show origin')).toBe(true);
      expect(calls.some(([cmd]) => cmd === 'git -C /test/repo merge-base main feature')).toBe(true);
      expect(calls.some(([cmd]) => cmd === 'git -C /test/repo diff --name-status abc123 feature')).toBe(true);
    });
  });

  describe('base branch detection', () => {
    it('should use main as base branch when available', async () => {
      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, deps);
      expect(result.markdown).toContain('Changes compared to merge-base with main');
    });

    it('should fall back to master when main is not available', async () => {
      // Mock remote show origin to indicate master is the default branch
      const masterDeps = {
        ...deps,
        execAsync: mock((cmd: string, options?: any) => {
          if (cmd.includes('remote show origin')) {
            return Promise.resolve({ stdout: 'HEAD branch: master\n', stderr: '' });
          }
          return mockExecAsync(cmd, options);
        }) as ExecAsyncFn
      };

      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, masterDeps);
      expect(result.markdown).toContain('Changes compared to merge-base with master');
    });

    it('should use first commit when no base branch is found', async () => {
      // Mock failure to find base branch and return first commit
      const noBaseDeps = {
        ...deps,
        execAsync: mock((cmd: string, options?: any) => {
          if (cmd.includes('remote show origin')) {
            return Promise.reject(new Error('No remote'));
          }
          if (cmd.includes('show-ref --verify refs/heads/main')) {
            return Promise.reject(new Error('No main branch'));
          }
          if (cmd.includes('show-ref --verify refs/heads/master')) {
            return Promise.reject(new Error('No master branch'));
          }
          if (cmd.includes('rev-list --max-parents=0')) {
            return Promise.resolve({ stdout: 'first123\n', stderr: '' });
          }
          if (cmd.includes('diff --name-status')) {
            return Promise.resolve({ stdout: 'A\tfeature.txt\nM\tfeature2.txt\n', stderr: '' });
          }
          if (cmd.includes('diff --shortstat')) {
            return Promise.resolve({ stdout: ' 2 files changed, 10 insertions(+), 5 deletions(-)\n', stderr: '' });
          }
          if (cmd.includes('log')) {
            return Promise.resolve({
              stdout: 'abc123\x1fAdd feature2.txt\x1fDetailed description\x1edef456\x1fAdd feature.txt\x1f\x1e',
              stderr: ''
            });
          }
          return mockExecAsync(cmd, options);
        }) as ExecAsyncFn
      };

      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, noBaseDeps);
      expect(result.markdown).toContain('All changes since repository creation');
    });
  });

  describe('edge cases', () => {
    it('should handle no modified files', async () => {
      const emptyDiffDeps = {
        ...deps,
        execAsync: mock((cmd: string, options?: any) => {
          if (cmd.includes('diff --name-status') || cmd.includes('diff --shortstat')) {
            return Promise.resolve({ stdout: '', stderr: '' });
          }
          return mockExecAsync(cmd, options);
        }) as ExecAsyncFn
      };

      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, emptyDiffDeps);
      expect(result.markdown).toContain('No modified files detected');
    });

    it('should handle working directory changes', async () => {
      const wdChangesDeps = {
        ...deps,
        execAsync: mock((cmd: string, options?: any) => {
          if (cmd.includes('diff --name-status') && !cmd.includes('abc123')) {
            return Promise.resolve({ stdout: 'M\tuncommitted.txt\n', stderr: '' });
          }
          if (cmd.includes('ls-files --others')) {
            return Promise.resolve({ stdout: 'untracked.txt\n', stderr: '' });
          }
          if (cmd.includes('diff --shortstat') && !cmd.includes('abc123')) {
            return Promise.resolve({ stdout: ' 1 file changed\n', stderr: '' });
          }
          return mockExecAsync(cmd, options);
        }) as ExecAsyncFn
      };

      const result = await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature' }, wdChangesDeps);
      expect(result.markdown).toContain('Uncommitted changes in working directory');
      expect(result.markdown).toContain('untracked.txt');
      expect(result.markdown).toContain('uncommitted.txt');
    });

    it('should handle session-based repository path', async () => {
      // Override the mock functions directly
      deps.getSession = mock(() => Promise.resolve({
        repoName: 'test-repo',
        repoUrl: 'https://github.com/test/repo'
      }));
      deps.getSessionWorkdir = mock(() => '/mock/session/path');

      const result = await git.prWithDependencies({ session: 'test-session' }, deps);
      expect(deps.getSession).toHaveBeenCalledWith('test-session');
      expect(deps.getSessionWorkdir).toHaveBeenCalledWith('test-repo', 'test-session');
      expect(result.markdown).toContain('Pull Request for branch `feature`');
    });

    it('should handle debug output', async () => {
      const debugLogs: string[] = [];
      const consoleSpy = spyOn(console, 'error').mockImplementation((msg) => {
        debugLogs.push(msg);
      });

      await git.prWithDependencies({ repoPath: '/test/repo', branch: 'feature', debug: true }, deps);

      expect(debugLogs).toContain('[DEBUG] Found remote HEAD branch: main');
      expect(debugLogs).toContain('[DEBUG] Using base branch: main');
      expect(debugLogs).toContain('[DEBUG] Using merge base: abc123');

      consoleSpy.mockRestore();
    });
  });

  // Add tests for task option
  describe('PR generation with task option', () => {
    it('should find the session for a task ID and generate PR markdown', async () => {
      const gitService = new GitService();
      
      // Mock data
      const taskId = '#123';
      const sessionName = 'task#123';
      const repoName = 'test-repo';
      const workdir = '/fake/path/to/repo';
      
      // Track if methods were called with correct args
      let taskIdCalled: string | null = null;
      let repoAndSessionCalled: { repo: string, session: string } | null = null;
      
      // Mock the dependencies
      const mockDeps: PrTestDependencies = {
        execAsync: async (cmd: string) => {
          if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            return { stdout: 'task#123', stderr: '' };
          } 
          if (cmd.includes('remote show origin')) {
            return { stdout: 'HEAD branch: main', stderr: '' };
          }
          if (cmd.includes('diff')) {
            return { stdout: 'file1\nfile2', stderr: '' };
          }
          if (cmd.includes('log')) {
            return { stdout: 'commit a1b2c3\nAuthor: Test\nDate: 2023-01-01\n\n    Test commit', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
        getSession: async () => null, // Not used in this test
        getSessionWorkdir: (repo: string, session: string) => {
          repoAndSessionCalled = { repo, session };
          return workdir;
        },
        getSessionByTaskId: async (id: string) => {
          taskIdCalled = id;
          if (id === taskId) {
            return {
              session: sessionName,
              repoName,
              repoUrl: 'https://github.com/user/test-repo.git'
            };
          }
          return null;
        }
      };
      
      // Call the method with task ID
      const result = await gitService.prWithDependencies(
        { taskId, debug: true },
        mockDeps
      );
      
      // Verify the correct session was used via tracking variables
      expect(taskIdCalled).toBe(taskId);
      expect(repoAndSessionCalled).toEqual({ repo: repoName, session: sessionName });
      expect(result.markdown).toBeTruthy();
    });
    
    it('should handle task IDs without the # prefix', async () => {
      const gitService = new GitService();
      
      // Mock data
      const taskId = '123'; // No # prefix
      const normalizedTaskId = '#123';
      const sessionName = 'task#123';
      const repoName = 'test-repo';
      const workdir = '/fake/path/to/repo';
      
      // Track if methods were called with correct args
      let taskIdCalled: string | null = null;
      let repoAndSessionCalled: { repo: string, session: string } | null = null;
      
      // Mock the dependencies
      const mockDeps: PrTestDependencies = {
        execAsync: async (cmd: string) => {
          if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            return { stdout: 'task#123', stderr: '' };
          } 
          if (cmd.includes('remote show origin')) {
            return { stdout: 'HEAD branch: main', stderr: '' };
          }
          if (cmd.includes('diff')) {
            return { stdout: 'file1\nfile2', stderr: '' };
          }
          if (cmd.includes('log')) {
            return { stdout: 'commit a1b2c3\nAuthor: Test\nDate: 2023-01-01\n\n    Test commit', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
        getSession: async () => null, // Not used in this test
        getSessionWorkdir: (repo: string, session: string) => {
          repoAndSessionCalled = { repo, session };
          return workdir;
        },
        getSessionByTaskId: async (id: string) => {
          taskIdCalled = id;
          if (id === normalizedTaskId) {
            return {
              session: sessionName,
              repoName,
              repoUrl: 'https://github.com/user/test-repo.git'
            };
          }
          return null;
        }
      };
      
      // Call the method with task ID without # prefix
      const result = await gitService.prWithDependencies(
        { taskId, debug: true },
        mockDeps
      );
      
      // Verify the normalized task ID was used via tracking variables
      expect(taskIdCalled).toBe(normalizedTaskId);
      expect(repoAndSessionCalled).toEqual({ repo: repoName, session: sessionName });
      expect(result.markdown).toBeTruthy();
    });
    
    it('should throw an error when no session exists for the task', async () => {
      const gitService = new GitService();
      
      // Mock data
      const taskId = '#123';
      
      // Mock the dependencies
      const mockDeps: PrTestDependencies = {
        execAsync: async () => ({
          stdout: '',
          stderr: ''
        }),
        getSession: async () => null,
        getSessionWorkdir: () => '',
        getSessionByTaskId: async () => null // No session found
      };
      
      // Expect an error
      await expect(
        gitService.prWithDependencies({ taskId }, mockDeps)
      ).rejects.toThrow(`No session found for task '${taskId}'`);
    });
  });
}); 
