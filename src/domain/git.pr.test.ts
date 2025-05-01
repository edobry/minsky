import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GitService } from './git';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { mock } from "bun:test";
import { promises as fs } from "fs";
import { SessionDB } from "./session";

function run(cmd: string, cwd: string) {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(`Working directory: ${cwd}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

describe('GitService PR base branch detection', () => {
  const TEST_GIT_DIR = "/tmp/minsky-test/minsky/git";

  beforeEach(async () => {
    // Mock execAsync for git commands
    const mockExecAsync = mock((cmd: string) => {
      if (cmd === "git remote show origin") {
        return Promise.resolve({
          stdout: `
* remote origin
  Fetch URL: https://github.com/org/repo.git
  Push  URL: https://github.com/org/repo.git
  HEAD branch: main
  Remote branches:
    main   tracked
    dev    tracked
  Local branches configured for 'git pull':
    main  merges with remote main
  Local refs configured for 'git push':
    main  pushes to main  (up to date)
`,
          stderr: ""
        });
      }
      if (cmd === "git rev-parse --abbrev-ref HEAD") {
        return Promise.resolve({ stdout: "feature/test\n", stderr: "" });
      }
      if (cmd === "git push -u origin feature/test") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    (global as any).execAsync = mockExecAsync;
  });

  afterEach(() => {
    // Restore original execAsync
    delete (global as any).execAsync;
  });

  it('should generate PR diff against main branch', async () => {
    const git = new GitService();
    await git.pr({
      repoPath: join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session"),
      branch: "feature/test"
    });

    // Verify git commands were called correctly
    const mockExecAsync = (global as any).execAsync;
    expect(mockExecAsync).toHaveBeenCalledWith(
      "git remote show origin",
      { cwd: join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session") }
    );
    expect(mockExecAsync).toHaveBeenCalledWith(
      "git push -u origin feature/test",
      { cwd: join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session") }
    );
  });
}); 
