import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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
  let repoDir: string;
  let git: GitService;

  beforeAll(() => {
    try {
      tmpDir = mkdtempSync("/tmp/minsky-git-test-");
      repoDir = join(tmpDir, "repo");
      
      // Initialize git repo
      run("git init --initial-branch=main", tmpDir);
      
      // Create initial commit on main
      writeFileSync(join(tmpDir, "README.md"), "# Test Repo\n");
      run("git add README.md", tmpDir);
      run("git commit -m \"Initial commit\"", tmpDir);
      
      // Create a feature branch
      run("git checkout -b feature", tmpDir);
      writeFileSync(join(tmpDir, "feature.txt"), "feature branch\n");
      run("git add feature.txt", tmpDir);
      run("git commit -m \"Add feature.txt\"", tmpDir);
      
      // Switch back to main and add another commit
      run("git checkout main", tmpDir);
      writeFileSync(join(tmpDir, "main.txt"), "main branch\n");
      run("git add main.txt", tmpDir);
      run("git commit -m \"Add main.txt\"", tmpDir);
      
      // Switch back to feature and add another commit
      run("git checkout feature", tmpDir);
      writeFileSync(join(tmpDir, "feature2.txt"), "feature branch 2\n");
      run("git add feature2.txt", tmpDir);
      run("git commit -m \"Add feature2.txt\"", tmpDir);
      
      git = new GitService();
    } catch (error) {
      // Clean up if setup fails
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.error("Failed to clean up temp directory:", cleanupError);
        }
      }
      throw error;
    }
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Failed to clean up temp directory:", error);
    }
  });

  it("should generate PR diff against main branch", async () => {
    try {
      const result = await git.pr({ repoPath: tmpDir, branch: "feature" });
      expect(result.markdown).toContain("feature.txt");
      expect(result.markdown).toContain("feature2.txt");
      expect(result.markdown).not.toContain("main.txt");
      expect(result.markdown).toContain("Changes compared to merge-base with main");
      expect(result.markdown).toMatch(/\d+ files? changed/);
    } catch (error) {
      console.error("Test failed:", error);
      throw error;
    }
  }, 10000); // Increase timeout to 10 seconds
}); 
