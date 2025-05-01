import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import { GitService } from "./git";
import { mock } from "bun:test";
import { promises as fs } from "fs";
import { join } from "path";
import { SessionDB } from "./session";

describe("GitService", () => {
  const TEST_GIT_DIR = "/tmp/minsky-test/minsky/git";
  const TEST_SESSION_DB = "/tmp/minsky-test/minsky/session-db.json";

  beforeEach(async () => {
    // Mock fs.mkdir to avoid actual file system operations
    const mockMkdir = mock(() => Promise.resolve());
    const originalMkdir = fs.mkdir;
    (global as any).fs = { ...fs, mkdir: mockMkdir };

    // Mock execAsync for git commands
    const mockExecAsync = mock(() => Promise.resolve({ stdout: "", stderr: "" }));
    (global as any).execAsync = mockExecAsync;

    // Mock SessionDB
    const mockGetNewSessionRepoPath = mock((repoName: string, sessionId: string) => 
      Promise.resolve(join(TEST_GIT_DIR, repoName, "sessions", sessionId)));
    const mockAddSession = mock(() => Promise.resolve());
    const originalSessionDB = SessionDB;
    (global as any).SessionDB = class {
      getNewSessionRepoPath = mockGetNewSessionRepoPath;
      addSession = mockAddSession;
    };
  });

  afterEach(() => {
    // Restore original fs.mkdir
    delete (global as any).fs;
    // Restore original execAsync
    delete (global as any).execAsync;
    // Restore original SessionDB
    delete (global as any).SessionDB;
  });

  it("clone: should create session repo under per-repo directory", async () => {
    // Mock execAsync
    const mockExecAsync = mock(async () => ({ stdout: "", stderr: "" }));
    (global as any).execAsync = mockExecAsync;
    
    // Create GitService
    const git = new GitService();
    
    // Calculate the expected path
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const baseDir = join(xdgStateHome, "minsky", "git");
    const expectedPath = join(baseDir, "github.com/org/repo/sessions/test-session");
    
    // Call clone
    const repoPath = await git.clone({
      repoUrl: "https://github.com/org/repo",
      session: "test-session"
    });
    
    expect(repoPath).toBe(expectedPath);
    
    // Verify git command was called correctly
    expect(mockExecAsync).toHaveBeenCalledWith(
      "git clone https://github.com/org/repo " + expectedPath
    );
  });

  it("branch: should work with per-repo directory structure", async () => {
    const git = new GitService();
    await git.branch({
      repoPath: join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session"),
      branch: "feature/test"
    });

    // Verify git command was called correctly
    const mockExecAsync = (global as any).execAsync;
    expect(mockExecAsync).toHaveBeenCalledWith(
      "git checkout -b feature/test",
      { cwd: join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session") }
    );
  });

  it("pr: should work with per-repo directory structure", async () => {
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
  });
}); 
