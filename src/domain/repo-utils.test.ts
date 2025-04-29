import { describe, it, expect } from 'bun:test';
import { resolveRepoPath, normalizeRepoName } from './repo-utils';

describe('resolveRepoPath', () => {
  it('returns explicit repo path if given', async () => {
    expect(await resolveRepoPath({ repo: '/foo/bar' })).toBe('/foo/bar');
  });
  it('returns session repo path if session is given', async () => {
    // Mock SessionDB
    const SessionDB = require('./session').SessionDB;
    SessionDB.prototype.getSession = async (session: string) => ({ session, repoUrl: '/mock/repo', createdAt: '' });
    expect(await resolveRepoPath({ session: 'mysession' })).toBe('/mock/repo');
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
