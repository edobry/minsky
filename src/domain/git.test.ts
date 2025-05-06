import { beforeEach, afterEach, describe, it, expect, mock } from 'bun:test';
import { GitService } from './git';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';

// Mock SessionDB for testing
const mockSessionDB = () => {
  const sessions = new Map();
  
  return {
    getSession: mock((sessionName) => {
      return sessions.get(sessionName) || null;
    }),
    addSession: mock((record) => {
      sessions.set(record.session, record);
      return record;
    }),
    _addTestSession: (record) => {
      sessions.set(record.session, record);
    }
  };
};

// Mock exec functions
const mockExec = mock(() => ({ stdout: "", stderr: "" }));

describe('GitService', () => {
  let tmpDir: string;
  let repoUrl: string;
  let originalExecSync;
  let originalSessionDBGetSession;

  beforeEach(() => {
    // Create a temporary directory for testing
    tmpDir = mkdtempSync(join(tmpdir(), 'minsky-git-test-'));
    repoUrl = tmpDir;
    
    // Store original functions for restoration
    originalExecSync = execSync;
    originalSessionDBGetSession = SessionDB.prototype.getSession;
    
    // Mock execSync to avoid actual commands
    global.execSync = mockExec;
  });

  afterEach(() => {
    // Clean up temporary directories
    rmSync(tmpDir, { recursive: true, force: true });
    
    // Restore original functions
    global.execSync = originalExecSync;
    SessionDB.prototype.getSession = originalSessionDBGetSession;
  });

  it('clone: should create session repo under per-repo directory', async () => {
    // Create a GitService instance
    const git = new GitService();
    
    // Clone the test repo
    const session = 'test-session';
    const result = await git.clone({ repoUrl, session });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(result.workdir).toContain(join('git', repoName, 'sessions', session));
    
    // Check that the session ID is returned
    expect(result.session).toBe(session);
  });

  it('branch: should work with per-repo directory structure', async () => {
    // Create a GitService instance
    const git = new GitService();
    const session = 'test-session';
    const mockDB = mockSessionDB();
    SessionDB.prototype.getSession = mockDB.getSession;
    
    // Add a test session
    mockDB._addTestSession({
      session: session,
      repoUrl: tmpDir,
      repoName: normalizeRepoName(tmpDir),
      branch: 'main',
      createdAt: new Date().toISOString()
    });
    
    // Create a branch
    const branchResult = await git.branch({ session, branch: 'feature' });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(branchResult.workdir).toContain(join('git', repoName, 'sessions', session));
    
    // Check that the branch name is returned
    expect(branchResult.branch).toBe('feature');
  });

  it('pr: should work with per-repo directory structure', async () => {
    // Create a GitService instance
    const git = new GitService();
    const session = 'test-session';
    const mockDB = mockSessionDB();
    SessionDB.prototype.getSession = mockDB.getSession;
    
    // Add a test session to the mock DB
    mockDB._addTestSession({
      session: session,
      repoUrl: tmpDir,
      repoName: normalizeRepoName(tmpDir),
      branch: 'feature',
      createdAt: new Date().toISOString()
    });
    
    // Mock the PR generation result
    git.prWithDependencies = mock(() => ({
      markdown: '# Pull Request\n\n## Changes\n- feature.txt: Added\n\n## Branch\nfeature',
      details: {
        branch: 'feature',
        files: ['feature.txt'],
        commits: ['Add feature.txt']
      }
    }));
    
    // Generate a PR
    const result = await git.pr({ session });
    
    // Check the PR markdown contains relevant info
    expect(result.markdown).toContain('feature.txt');
    expect(result.markdown).toContain('feature');
  });
}); 
