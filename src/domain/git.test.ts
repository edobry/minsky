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
    const git = new GitService();
    const repoPath = await git.clone({
      repoUrl: "https://github.com/org/repo",
      session: "test-session"
    });

    expect(repoPath).toBe(join(TEST_GIT_DIR, "github.com/org/repo/sessions/test-session"));
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
