import { describe, it, expect } from 'bun:test';
import { resolveRepoPath } from './repo-utils';

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
