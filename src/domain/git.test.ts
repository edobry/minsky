/// <reference types="bun-types" />

import { describe, test, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';
import { GitService } from './git';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync, exec as childExec } from 'child_process';

function run(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'ignore' });
}

function generateUniqueName(): string {
  return `test-${Math.random().toString(36).substring(2, 8)}`;
}

describe('GitService', () => {
  let tmpDir: string;
  let git: GitService;
  let mockExec: typeof childExec;

  beforeAll(async () => {
    mockExec = mock((command: string, options: any, callback: any) => {
      // Call the real exec for now, but we can mock specific commands later
      childExec(command, options, callback);
    });

    git = new GitService(mockExec);
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
    const session = generateUniqueName();
    const result = await git.clone({ repoUrl, session });
    
    try {
      // Check that the workdir is under the correct repo directory
      expect(result.workdir).toContain(join('git', session));
      
      // Check that the repo was actually cloned
      expect(() => execSync('git status', { cwd: result.workdir })).not.toThrow();
    } finally {
      // Clean up the cloned repo
      rmSync(result.workdir, { recursive: true, force: true });
    }
  });

  test('branch: should work with per-repo directory structure', async () => {
    // First clone a repo
    const repoUrl = tmpDir;
    const session = generateUniqueName();
    const cloneResult = await git.clone({ repoUrl, session });
    
    try {
      // Then create a branch
      const branchResult = await git.branch({ session, branch: 'feature' });
      
      // Check that the workdir is under the correct repo directory
      expect(branchResult.workdir).toContain(join('git', session));
      
      // Check that the branch was created
      const output = execSync('git branch --show-current', { cwd: branchResult.workdir });
      expect(output.toString().trim()).toBe('feature');
    } finally {
      // Clean up the cloned repo
      rmSync(cloneResult.workdir, { recursive: true, force: true });
    }
  });
}); 
