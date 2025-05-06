import { describe, it, expect, mock } from 'bun:test';
import { resolveRepoPath, normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';
import { exec } from 'child_process';
import { promisify } from 'util';

// Store original execAsync for restoration later
const originalExecAsync = promisify(exec);

describe('resolveRepoPath', () => {
  it('returns explicit repo path if given', async () => {
    expect(await resolveRepoPath({ repo: '/foo/bar' })).toBe('/foo/bar');
  });

  it('returns session repo path if session is given', async () => {
    // Create a test SessionDB
    const testRecord = {
      session: 'test-session',
      repoUrl: '/mock/repo',
      repoName: 'mock/repo',
      createdAt: new Date().toISOString()
    };

    // Override getSession just for this test
    const originalGetSession = SessionDB.prototype.getSession;
    SessionDB.prototype.getSession = mock(() => Promise.resolve(testRecord));

    try {
      const result = await resolveRepoPath({ session: 'test-session' });
      expect(result).toBe('/mock/repo');
    } finally {
      // Restore original method
      SessionDB.prototype.getSession = originalGetSession;
    }
  });

  it('falls back to git rev-parse if neither is given', async () => {
    // Save current process.cwd
    const originalCwd = process.cwd;
    
    // Mock process.cwd to return a predictable value
    process.cwd = mock(() => '/some/test/path');
    
    // Mock the execAsync function for this test
    const mockExecAsync = mock(() => Promise.resolve({ stdout: '/git/repo/path\n', stderr: '' }));
    global.execAsync = mockExecAsync;
    
    try {
      const result = await resolveRepoPath({});
      expect(result).toBe('/git/repo/path');
      expect(mockExecAsync).toHaveBeenCalledWith('git rev-parse --show-toplevel');
    } finally {
      // Clean up
      global.execAsync = originalExecAsync;
      process.cwd = originalCwd;
    }
  });
});

describe('normalizeRepoName', () => {
  it('normalizes HTTPS remote URLs', () => {
    expect(normalizeRepoName('https://github.com/org/project.git')).toBe('org/project');
    expect(normalizeRepoName('https://github.com/org/project')).toBe('org/project');
  });

  it('normalizes SSH remote URLs', () => {
    expect(normalizeRepoName('git@github.com:org/project.git')).toBe('org/project');
    expect(normalizeRepoName('git@github.com:org/project')).toBe('org/project');
  });

  it('normalizes local paths', () => {
    expect(normalizeRepoName('/Users/edobry/Projects/minsky')).toBe('local/minsky');
    expect(normalizeRepoName('/tmp/some-project')).toBe('local/some-project');
  });

  it('normalizes file:// URLs', () => {
    expect(normalizeRepoName('file:///Users/edobry/Projects/minsky')).toBe('local/minsky');
    expect(normalizeRepoName('file:///tmp/some-project')).toBe('local/some-project');
  });
}); 
