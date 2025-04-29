import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GitService } from './git';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { normalizeRepoName } from './repo-utils';

function run(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'ignore' });
}

describe('GitService', () => {
  let tmpDir: string;
  let git: GitService;

  beforeAll(async () => {
    git = new GitService();
  });

  beforeEach(async () => {
    // Create fresh temp directory
    tmpDir = mkdtempSync('/tmp/minsky-git-test-');

    // Initialize fresh repo for each test
    run('git init --initial-branch=main', tmpDir);
    
    // Configure git for test environment
    run('git config user.name "Test User"', tmpDir);
    run('git config user.email "test@example.com"', tmpDir);
    
    // Create initial commit on main
    writeFileSync(join(tmpDir, 'README.md'), '# Test Repo\n');
    run('git add README.md', tmpDir);
    run('git commit -m "Initial commit"', tmpDir);
  });

  afterEach(async () => {
    // Clean up temp directory after each test
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('clone: should create session repo under per-repo directory', async () => {
    const repoUrl = tmpDir;
    const session = 'test-session';
    const result = await git.clone({ repoUrl, session });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(result.workdir).toContain(join('git', repoName, session));
    
    // Check that the repo was actually cloned
    expect(() => execSync('git status', { cwd: result.workdir })).not.toThrow();
  });

  test('branch: should work with per-repo directory structure', async () => {
    // First clone a repo
    const repoUrl = tmpDir;
    const session = 'test-session';
    const cloneResult = await git.clone({ repoUrl, session });
    
    // Then create a branch
    const branchResult = await git.branch({ session, branch: 'feature' });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(branchResult.workdir).toContain(join('git', repoName, session));
    
    // Check that the branch was created
    const output = execSync('git branch --show-current', { cwd: branchResult.workdir });
    expect(output.toString().trim()).toBe('feature');
  });

  test('pr: should work with per-repo directory structure', async () => {
    // First clone a repo
    const repoUrl = tmpDir;
    const session = 'test-session';
    const cloneResult = await git.clone({ repoUrl, session });
    
    // Create and switch to feature branch
    await git.branch({ session, branch: 'feature' });
    
    // Add a commit to the feature branch
    writeFileSync(join(cloneResult.workdir, 'feature.txt'), 'feature branch file\n');
    run('git add feature.txt', cloneResult.workdir);
    run('git commit -m "Add feature.txt"', cloneResult.workdir);
    
    // Generate PR
    const result = await git.pr({ session });
    
    // Check that the PR was generated correctly
    expect(result.markdown).toContain('Add feature.txt');
    expect(result.markdown).toContain('feature.txt');
  });
}); 
