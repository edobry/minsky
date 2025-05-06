import { beforeEach, afterEach, describe, it, expect, mock } from "bun:test";
import { GitService } from "./git";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { normalizeRepoName } from "./repo-utils";

let originalSessionDB: any;
let originalExecSync: any;

describe("GitService", () => {
  let tmpDir: string;
  let repoUrl: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minsky-git-test-"));
    repoUrl = tmpDir;
    originalSessionDB = global.SessionDB;
    originalExecSync = global.execSync;
    global.execSync = mock(() => ({ stdout: "", stderr: "" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    global.SessionDB = originalSessionDB;
    global.execSync = originalExecSync;
  });

  it("clone: should create session repo under per-repo directory", async () => {
    const git = new GitService();
    const session = "test-session";
    const result = await git.clone({ repoUrl, session });
    const repoName = normalizeRepoName(repoUrl);
    expect(result.workdir).toContain(join("git", repoName, "sessions", session));
    expect(result.session).toBe(session);
  });

  it("branch: should work with per-repo directory structure", async () => {
    const session = "test-session";
    const repoName = normalizeRepoName(tmpDir);
    
    // Create a proper mock class with the getSession method
    class MockSessionDB {
      async getSession(sessionName: string) {
        if (sessionName === session) {
          return {
            session: session,
            repoUrl: tmpDir,
            repoName: repoName,
            branch: "main",
            createdAt: new Date().toISOString()
          };
        }
        return null;
      }
    }
    
    // Replace the global SessionDB with our mock
    global.SessionDB = MockSessionDB;
    
    const git = new GitService();
    const branchResult = await git.branch({ session, branch: "feature" });
    expect(branchResult.workdir).toContain(join("git", repoName, "sessions", session));
    expect(branchResult.branch).toBe("feature");
  });

  it("pr: should work with per-repo directory structure", async () => {
    const session = "test-session";
    const repoName = normalizeRepoName(tmpDir);
    
    // Create a proper mock class with the getSession method
    class MockSessionDB {
      async getSession(sessionName: string) {
        if (sessionName === session) {
          return {
            session: session,
            repoUrl: tmpDir,
            repoName: repoName,
            branch: "feature",
            createdAt: new Date().toISOString()
          };
        }
        return null;
      }
    }
    
    // Replace the global SessionDB with our mock
    global.SessionDB = MockSessionDB;
    
    const git = new GitService();
    
    // Mock the PR generation function
    (git as any).prWithDependencies = mock(() => ({
      markdown: "# Pull Request\n\n## Changes\n- feature.txt: Added\n\n## Branch\nfeature",
      details: {
        branch: "feature",
        files: ["feature.txt"],
        commits: ["Add feature.txt"]
      }
    }));
    
    const result = await git.pr({ session });
    expect(result.markdown).toContain("feature.txt");
    expect(result.markdown).toContain("feature");
  });
}); 
