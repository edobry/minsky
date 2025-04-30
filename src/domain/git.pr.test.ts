import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { GitService } from './git';
import type { PrOptions } from './git';

// Create mock functions outside describe block for global access
const mockExecFn = mock((...args: any[]) => Promise.resolve({ stdout: '', stderr: '' }));
const mockMkdir = mock(() => Promise.resolve(undefined));
const mockGetSessionFn = mock(() => Promise.resolve({
  repoName: 'test-repo',
  session: 'test-session'
}));

// Mock the modules before importing or requiring them
mock.module('child_process', () => ({
  exec: mockExecFn,
  promisify: mock((fn: any) => (cmd: string) => mockExecFn(cmd))
}));

mock.module('fs/promises', () => ({
  mkdir: mockMkdir
}));

// Mock the SessionDB class
mock.module('./session', () => ({
  SessionDB: mock(() => ({
    getSession: mockGetSessionFn
  }))
}));

// Helper to mock exec output
const mockExecOutput = (stdout: string, stderr = '') => {
  return Promise.resolve({ stdout, stderr });
};

describe('GitService.pr method', () => {
  let git: GitService;

  // Setup before each test
  beforeEach(() => {
    // Reset all mocks
    mockExecFn.mockReset();
    mockMkdir.mockReset();
    mockGetSessionFn.mockReset();
    mockGetSessionFn.mockImplementation(() => {
      return Promise.resolve({
        repoName: 'test-repo',
        session: 'test-session'
      });
    });
    
    // Create the GitService instance
    git = new GitService();
    
    // Mock the ensureBaseDir method
    spyOn(git as any, 'ensureBaseDir').mockResolvedValue(undefined);
    
    // Mock the getSessionWorkdir method
    spyOn(git as any, 'getSessionWorkdir').mockReturnValue('/mock/workdir/path');
  });

  afterEach(() => {
    mock.restore();
  });

  it('should use session to determine workdir when session provided', async () => {
    // Arrange
    const options: PrOptions = { session: 'test-session' };
    
    // Configure mocks
    mockExecFn.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return mockExecOutput('');
      
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return mockExecOutput('feature-branch');
      }
      if (cmd.includes('remote show origin')) {
        return mockExecOutput('  HEAD branch: main');
      }
      if (cmd.includes('merge-base')) {
        return mockExecOutput('abc123');
      }
      if (cmd.includes('diff --name-status')) {
        return mockExecOutput('A\tfile1.txt\nM\tfile2.txt');
      }
      if (cmd.includes('diff --shortstat')) {
        return mockExecOutput(' 2 files changed, 10 insertions(+), 5 deletions(-)');
      }
      if (cmd.includes('log')) {
        return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
      }
      return mockExecOutput('');
    });

    // Act
    const result = await git.pr(options);

    // Assert
    expect(mockGetSessionFn).toHaveBeenCalledWith('test-session');
    expect(result.markdown).toContain('feature-branch');
    expect(result.markdown).toContain('Changes compared to merge-base with main');
    expect(result.markdown).toContain('file1.txt');
    expect(result.markdown).toContain('file2.txt');
    expect(result.markdown).toContain('Commit 1');
  }, 10000); // Increase timeout

  it('should use repoPath when no session provided', async () => {
    // Arrange
    const options: PrOptions = { repoPath: '/custom/repo/path' };
    
    mockExecFn.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return mockExecOutput('');
      
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return mockExecOutput('feature-branch');
      }
      if (cmd.includes('remote show origin')) {
        return mockExecOutput('  HEAD branch: main');
      }
      if (cmd.includes('merge-base')) {
        return mockExecOutput('abc123');
      }
      if (cmd.includes('diff --name-status')) {
        return mockExecOutput('A\tfile1.txt\nM\tfile2.txt');
      }
      if (cmd.includes('diff --shortstat')) {
        return mockExecOutput(' 2 files changed, 10 insertions(+), 5 deletions(-)');
      }
      if (cmd.includes('log')) {
        return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
      }
      return mockExecOutput('');
    });

    // Act
    const result = await git.pr(options);

    // Assert
    expect(mockGetSessionFn).not.toHaveBeenCalled();
    expect(result.markdown).toContain('feature-branch');
    expect(result.markdown).toContain('Changes compared to merge-base with main');
    expect(result.markdown).toContain('file1.txt');
    expect(result.markdown).toContain('file2.txt');
  }, 10000); // Increase timeout

  it('should throw error if neither session nor repoPath provided', async () => {
    // Arrange
    const options: PrOptions = {};

    // Act & Assert
    await expect(git.pr(options)).rejects.toThrow('Either session or repoPath must be provided');
  });

  it('should use current branch if no branch provided', async () => {
    // Arrange
    const options: PrOptions = { repoPath: '/custom/repo/path' };
    mockExecFn.mockImplementation((cmd: string) => {
      if (typeof cmd !== 'string') return mockExecOutput('');
      
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return mockExecOutput('detected-branch');
      }
      if (cmd.includes('remote show origin')) {
        return mockExecOutput('  HEAD branch: main');
      }
      if (cmd.includes('merge-base')) {
        return mockExecOutput('abc123');
      }
      if (cmd.includes('diff --name-status')) {
        return mockExecOutput('A\tfile1.txt');
      }
      if (cmd.includes('diff --shortstat')) {
        return mockExecOutput(' 1 file changed, 5 insertions(+)');
      }
      if (cmd.includes('log')) {
        return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
      }
      return mockExecOutput('');
    });

    // Act
    const result = await git.pr(options);

    // Assert
    expect(result.markdown).toContain('detected-branch');
  }, 10000); // Increase timeout

  describe('Base branch detection', () => {
    it('should prefer remote HEAD branch', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          return mockExecOutput('  HEAD branch: remote-main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('Changes compared to merge-base with remote-main');
    }, 10000); // Increase timeout

    it('should fall back to upstream branch if remote HEAD not found', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        // Handle different operations
        if (cmd.includes('remote show origin')) {
          // Return a rejected promise for remote HEAD detection
          return Promise.reject(new Error('Remote not found'));
        }
        if (cmd.includes('rev-parse --abbrev-ref feature@{upstream}')) {
          return mockExecOutput('origin/upstream-branch');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('Changes compared to merge-base with origin/upstream-branch');
    }, 10000); // Increase timeout

    it('should fall back to main branch if upstream not found', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          // Simulate error for remote HEAD detection
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('rev-parse --abbrev-ref feature@{upstream}')) {
          // Simulate error for upstream detection
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('show-ref --verify --quiet refs/heads/main')) {
          // Success for main branch check
          return mockExecOutput('main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('Changes compared to merge-base with main');
    }, 10000); // Increase timeout

    it('should fall back to master branch if main not found', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          // Simulate error for remote HEAD detection
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('rev-parse --abbrev-ref feature@{upstream}')) {
          // Simulate error for upstream detection
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('show-ref --verify --quiet refs/heads/main')) {
          // Simulate error for main branch check
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('show-ref --verify --quiet refs/heads/master')) {
          // Success for master branch check
          return mockExecOutput('master');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('Changes compared to merge-base with master');
    }, 10000); // Increase timeout

    it('should fall back to first commit if no base branch found', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin') || 
            cmd.includes('rev-parse --abbrev-ref feature@{upstream}') || 
            cmd.includes('show-ref --verify --quiet refs/heads/main') || 
            cmd.includes('show-ref --verify --quiet refs/heads/master')) {
          // Simulate all base branch detection methods failing
          return Promise.reject(new Error('Not found'));
        }
        if (cmd.includes('rev-list --max-parents=0')) {
          return mockExecOutput('first-commit-hash');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('All changes since repository creation');
    }, 10000); // Increase timeout
  });

  describe('Edge cases', () => {
    it('should handle no modified files', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          return mockExecOutput('  HEAD branch: main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          // No changed files
          return mockExecOutput('');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput('');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('No modified files detected');
    }, 10000); // Increase timeout

    it('should handle no commits', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          return mockExecOutput('  HEAD branch: main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          // No commits
          return mockExecOutput('');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('No commits found between merge base and current branch');
    }, 10000); // Increase timeout

    it('should handle working directory changes', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature' };
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          return mockExecOutput('  HEAD branch: main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          if (cmd.includes('abc123 feature')) {
            // Committed changes
            return mockExecOutput('A\tcommitted-file.txt');
          } else {
            // Working directory changes
            return mockExecOutput('M\tworking-file.txt');
          }
        }
        if (cmd.includes('diff --shortstat')) {
          if (cmd.includes('abc123 feature')) {
            return mockExecOutput(' 1 file changed, 5 insertions(+)');
          } else {
            return mockExecOutput(' 1 file changed, 3 insertions(+), 2 deletions(-)');
          }
        }
        if (cmd.includes('ls-files --others')) {
          // Untracked files
          return mockExecOutput('untracked-file.txt');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      const result = await git.pr(options);

      // Assert
      expect(result.markdown).toContain('committed-file.txt');
      expect(result.markdown).toContain('working-file.txt');
      expect(result.markdown).toContain('untracked-file.txt');
      expect(result.markdown).toContain('Uncommitted changes in working directory');
    }, 10000); // Increase timeout

    it('should handle debug output', async () => {
      // Arrange
      const options: PrOptions = { repoPath: '/custom/repo/path', branch: 'feature', debug: true };
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
      mockExecFn.mockImplementation((cmd: string) => {
        if (typeof cmd !== 'string') return mockExecOutput('');
        
        if (cmd.includes('remote show origin')) {
          return mockExecOutput('  HEAD branch: main');
        }
        if (cmd.includes('merge-base')) {
          return mockExecOutput('abc123');
        }
        if (cmd.includes('diff --name-status')) {
          return mockExecOutput('A\tfile1.txt');
        }
        if (cmd.includes('diff --shortstat')) {
          return mockExecOutput(' 1 file changed, 5 insertions(+)');
        }
        if (cmd.includes('log')) {
          return mockExecOutput('abc123\x1fCommit 1\x1fCommit body\x1e');
        }
        return mockExecOutput('');
      });

      // Act
      await git.pr(options);

      // Assert
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
    }, 10000); // Increase timeout
  });
}); 
