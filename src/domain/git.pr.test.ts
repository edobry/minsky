import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { GitService } from "./git";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function run(cmd: string, cwd: string) {
  try {
    execSync(cmd, { cwd, stdio: "pipe" });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(`Working directory: ${cwd}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

describe("GitService PR base branch detection", () => {
  let tmpDir: string;
  let git: GitService;

  beforeEach(() => {
    tmpDir = mkdtempSync("/tmp/git-test-");
    git = new GitService();

    // Initialize fresh repo for each test
    run("git init --initial-branch=main", tmpDir);
    
    // Configure git for test environment
    run("git config user.name \"Test User\"", tmpDir);
    run("git config user.email \"test@example.com\"", tmpDir);
    
    // Create initial commit on main
    writeFileSync(join(tmpDir, "README.md"), "# Test Repo\n");
    run("git add README.md", tmpDir);
    run("git commit -m \"Initial commit\"", tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("should generate PR diff against main branch", async () => {
    try {
      // Create and switch to feature branch
      run("git checkout -b feature", tmpDir);
      writeFileSync(join(tmpDir, "feature.txt"), "feature branch file\n");
      run("git add feature.txt", tmpDir);
      run("git commit -m \"Add feature.txt\"", tmpDir);

      const result = await git.pr({ repoPath: tmpDir, branch: "feature" });
      expect(result.markdown).toContain("feature.txt");
    } catch (error) {
      console.error("Test failed:", error);
      throw error;
    }
  });
}); 
