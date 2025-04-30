import { describe, it, expect } from 'bun:test';
import { resolveRepoPath, normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';

describe('resolveRepoPath', () => {
  it('returns explicit repo path if given', async () => {
    expect(await resolveRepoPath({ repo: '/foo/bar' })).toBe('/foo/bar');
  });

  it('returns session repo path if session is given', async () => {
    // Save original method
    const originalGetSession = SessionDB.prototype.getSession;

    // Create a local implementation that doesn't depend on bun:test mock
    SessionDB.prototype.getSession = async () => ({
      session: 'test-session',
      repoUrl: '/mock/repo',
      repoName: 'mock/repo',
      createdAt: new Date().toISOString()
    });
    
    try {
      const result = await resolveRepoPath({ session: 'test-session' });
      expect(result).toBe('/mock/repo');
    } finally {
      // Restore original method
      SessionDB.prototype.getSession = originalGetSession;
    }
  });

  it('falls back to git rev-parse if neither is given', async () => {
    // Try to get the real value
    const { execSync } = require('child_process');
    let expected;
    try {
      expected = execSync('git rev-parse --show-toplevel').toString().trim();
    } catch {
      expected = process.cwd(); // fallback if not in a git repo
    }
    const result = await resolveRepoPath({});
    expect(result).toBe(expected);
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
