import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createUpdateCommand } from "./update";
import { GitService } from "../../domain/git";
import { SessionDB } from "../../domain/session";
import { mkdtempSync, rmSync } from "fs";
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

describe("session update command", () => {
  let tmpDir: string;
  let repoUrl: string;
  let command: ReturnType<typeof createUpdateCommand>;
  let mockGitService: GitService;
  let mockSessionDb: SessionDB;

  beforeEach(() => {
    // Create a temporary directory for testing
    tmpDir = mkdtempSync(join("/tmp", "minsky-update-test-"));

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

    // Mock GitService
    mockGitService = {
      clone: mock(() => Promise.resolve({ workdir: tmpDir, session: "test-session" })),
      branch: mock(() => Promise.resolve({ workdir: tmpDir, branch: "test-branch" })),
      pr: mock(() => Promise.resolve({ markdown: "test pr" })),
      stashChanges: mock(() => Promise.resolve({ workdir: tmpDir, stashed: true })),
      popStash: mock(() => Promise.resolve({ workdir: tmpDir, stashed: true })),
      pullLatest: mock(() => Promise.resolve({ workdir: tmpDir, updated: true })),
      mergeBranch: mock(() => Promise.resolve({ workdir: tmpDir, merged: true, conflicts: false })),
      pushBranch: mock(() => Promise.resolve({ workdir: tmpDir, pushed: true })),
      getSessionWorkdir: mock(() => tmpDir)
    } as unknown as GitService;

    // Mock SessionDB
    mockSessionDb = {
      getSession: mock(() => Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl,
        createdAt: new Date().toISOString()
      })),
      listSessions: mock(() => Promise.resolve([{
        session: "test-session",
        repoName: "test-repo",
        repoUrl,
        createdAt: new Date().toISOString()
      }])),
      addSession: mock(() => Promise.resolve()),
      updateSession: mock(() => Promise.resolve())
    } as unknown as SessionDB;

    // Create command with mocked dependencies
    command = createUpdateCommand(mockGitService, mockSessionDb);
  });

  afterEach(() => {
    // Clean up temporary directories
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should update session with latest changes", async () => {
    // Run the command
    await command.parseAsync(["node", "minsky", "test-session"]);

    // Verify all operations were called in the correct order
    expect(mockGitService.stashChanges).toHaveBeenCalledWith(tmpDir);
    expect(mockGitService.pullLatest).toHaveBeenCalledWith(tmpDir, "origin");
    expect(mockGitService.mergeBranch).toHaveBeenCalledWith(tmpDir, "main");
    expect(mockGitService.pushBranch).toHaveBeenCalledWith(tmpDir, "origin");
    expect(mockGitService.popStash).toHaveBeenCalledWith(tmpDir);
  });

  it("should handle merge conflicts gracefully", async () => {
    // Mock mergeBranch to return conflicts
    mockGitService.mergeBranch = mock(() => Promise.resolve({ workdir: tmpDir, merged: false, conflicts: true }));

    // Mock process.exit to prevent test from exiting
    const originalExit = process.exit;
    process.exit = mock(() => { throw new Error("Process exit called"); }) as any;

    try {
      // Mock console.error to prevent error output
      const originalConsoleError = console.error;
      console.error = mock(() => {});

      try {
        // Run the command expecting it to call process.exit
        await command.parseAsync(["node", "minsky", "test-session"]);
      } finally {
        // Restore console.error
        console.error = originalConsoleError;
      }
    } catch (error) {
      // Expect error about process exit
      expect(String(error)).toContain("Process exit called");
    } finally {
      // Restore process.exit
      process.exit = originalExit;
    }

    // Verify stashed changes were restored
    expect(mockGitService.popStash).toHaveBeenCalledWith(tmpDir);
  });

  it("should use current session if no session name provided", async () => {
    // Mock current directory to be in a session
    process.cwd = mock(() => "/path/to/test-session");

    // Run the command without session name
    await command.parseAsync(["node", "minsky"]);

    // Verify operations used the correct session
    expect(mockGitService.stashChanges).toHaveBeenCalledWith(tmpDir);
  });

  it("should respect --no-stash option", async () => {
    // Run the command with --no-stash
    await command.parseAsync(["node", "minsky", "test-session", "--no-stash"]);

    // Verify stash operations were not called
    expect(mockGitService.stashChanges).not.toHaveBeenCalled();
    expect(mockGitService.popStash).not.toHaveBeenCalled();
  });

  it("should respect --no-push option", async () => {
    // Run the command with --no-push
    await command.parseAsync(["node", "minsky", "test-session", "--no-push"]);

    // Verify push was not called
    expect(mockGitService.pushBranch).not.toHaveBeenCalled();
  });

  it("should use specified branch and remote", async () => {
    // Run the command with custom branch and remote
    await command.parseAsync(["node", "minsky", "test-session", "--branch", "develop", "--remote", "upstream"]);

    // Verify correct branch and remote were used
    expect(mockGitService.pullLatest).toHaveBeenCalledWith(tmpDir, "upstream");
    expect(mockGitService.mergeBranch).toHaveBeenCalledWith(tmpDir, "develop");
    expect(mockGitService.pushBranch).toHaveBeenCalledWith(tmpDir, "upstream");
  });
});
