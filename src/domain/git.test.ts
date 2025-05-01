import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { GitService } from "./git";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";

function run(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: "ignore" });
}

describe("GitService", () => {
  let tmpDir: string;
  let repoUrl: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tmpDir = mkdtempSync(join(tmpdir(), "minsky-git-test-"));

    // Initialize a git repo in the temp directory
    run("git init --initial-branch=main", tmpDir);
    run("git config user.email \"test@example.com\"", tmpDir);
    run("git config user.name \"Test User\"", tmpDir);
    
    // Create test files and commit them
    run("touch README.md", tmpDir);
    run("git add README.md", tmpDir);
    run("git commit -m \"Initial commit\"", tmpDir);
    
    // Use the temp directory as our test repo URL
    repoUrl = tmpDir;
  });

  afterEach(() => {
    // Clean up temporary directories
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clone: should create session repo under per-repo directory", async () => {
    // Create a GitService instance
    const git = new GitService();
    
    // Clone the test repo
    const session = "test-session";
    const result = await git.clone({ repoUrl, session });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(result.workdir).toContain(join("git", repoName, "sessions", session));
    
    // Check that the session ID is returned
    expect(result.session).toBe(session);
  });

  it("branch: should work with per-repo directory structure", async () => {
    // Create a GitService instance
    const git = new GitService();
    
    // First, clone the test repo
    const session = "test-session";
    await git.clone({ repoUrl, session });
    
    // Then create a branch
    const branchResult = await git.branch({ session, branch: "feature" });
    
    // Check that the workdir is under the correct repo directory
    const repoName = normalizeRepoName(repoUrl);
    expect(branchResult.workdir).toContain(join("git", repoName, "sessions", session));
    
    // Check that the branch name is returned
    expect(branchResult.branch).toBe("feature");
  });

  it("pr: should work with per-repo directory structure", async () => {
    // Create a GitService instance
    const git = new GitService();
    
    // First, clone the test repo
    const session = "test-session";
    const cloneResult = await git.clone({ repoUrl, session });
    const workdir = cloneResult.workdir;
    
    // Create a new branch and add a file
    run("git checkout -b feature", workdir);
    run("touch feature.txt", workdir);
    run("git add feature.txt", workdir);
    run("git commit -m \"Add feature.txt\"", workdir);
    
    // Generate a PR
    const result = await git.pr({ session });
    
    // Check the PR markdown contains relevant info
    expect(result.markdown).toContain("feature.txt");
    expect(result.markdown).toContain("feature");
  });
}); 
