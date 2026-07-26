/* eslint-disable custom/no-real-fs-in-tests -- real dirs/git repos are required to exercise MERGE_HEAD/uncommitted-changes detection */
/**
 * Tests for checkWorkspaceGitStateForDelete (mt#3021 SC2).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { checkWorkspaceGitStateForDelete } from "./session-workspace-git-state-guard";

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

function realGitService() {
  return {
    hasUncommittedChanges: async (repoPath: string): Promise<boolean> => {
      const out = execFileSync("git", ["status", "--porcelain"], {
        cwd: repoPath,
        env: gitEnv(repoPath),
      }).toString();
      return out.trim().length > 0;
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mt3021-git-state-guard-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkWorkspaceGitStateForDelete", () => {
  it("does not block a clean, non-merging workspace (AT4 no-over-fire)", async () => {
    const result = await checkWorkspaceGitStateForDelete(realGitService(), dir);
    expect(result.blocked).toBe(false);
  });

  it("blocks a workspace with uncommitted changes", async () => {
    await writeFile(join(dir, "a.txt"), "modified, not committed");

    const result = await checkWorkspaceGitStateForDelete(realGitService(), dir);
    expect(result.blocked).toBe(true);
    expect(result.reasonCode).toBe("uncommitted-changes");
  });

  it("blocks a workspace with MERGE_HEAD present, even with a clean working tree (AT1: the race window)", async () => {
    // Simulate the mt#3021 incident's race shape: a merge is in progress
    // (MERGE_HEAD written) but `git status --porcelain` would read clean —
    // exactly the transient-clean window the spec's SC1 investigation
    // documented. Writing MERGE_HEAD directly (rather than driving a real
    // conflicted merge) isolates this sub-check from the uncommitted-changes
    // sub-check.
    await writeFile(join(dir, ".git", "MERGE_HEAD"), "abc123\n");

    const result = await checkWorkspaceGitStateForDelete(realGitService(), dir);
    expect(result.blocked).toBe(true);
    expect(result.reasonCode).toBe("merge-head-present");
  });

  it("does not block when the workspace directory does not exist", async () => {
    const nonexistent = join(dir, "does-not-exist");
    const result = await checkWorkspaceGitStateForDelete(realGitService(), nonexistent);
    expect(result.blocked).toBe(false);
  });

  it("fails open when the git-state probe itself errors (does not deadlock recovery)", async () => {
    // A directory that exists but isn't a git repo — git status will fail.
    const notARepo = await mkdtemp(join(tmpdir(), "mt3021-not-a-repo-"));
    try {
      const result = await checkWorkspaceGitStateForDelete(realGitService(), notARepo);
      expect(result.blocked).toBe(false);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
