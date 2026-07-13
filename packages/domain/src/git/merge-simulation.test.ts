/* eslint-disable custom/no-real-fs-in-tests -- integration: real git state-machine tests */
/**
 * Regression tests for simulateMergeImpl HEAD restoration (mt#1217).
 *
 * The bug: finally-block checked out targetBranch (a remote-tracking ref like
 * `origin/main`) instead of restoring the caller's original HEAD, detaching HEAD
 * on every dry-run path.
 *
 * These tests use real git repos (temp dirs) because the invariant under test
 * is the git working-tree state-machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { simulateMergeImpl } from "./merge-simulation";

// ---------------------------------------------------------------------------
// Helpers (same idiom as merge-abort.integration.test.ts)
// ---------------------------------------------------------------------------

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(cwd) })
    .toString()
    .trim();
}

async function initRepo(dir: string): Promise<void> {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}

async function writeCommit(
  dir: string,
  filename: string,
  content: string,
  message: string
): Promise<string> {
  await writeFile(join(dir, filename), content);
  git(dir, "add", filename);
  git(dir, "commit", "-m", message);
  return gitOut(dir, "rev-parse", "HEAD");
}

interface TestRepos {
  origin: string;
  workspace: string;
  session: string;
}

/**
 * Set up a bare origin and a working clone. The clone has:
 *  - `main` tracking `origin/main`
 *  - `session` branch (checked out) with at least one commit ahead of main
 *  - `origin/main` advanced past the session branch's base (diverged)
 */
async function setupDivergedRepos(rootDir: string): Promise<TestRepos> {
  const origin = join(rootDir, "origin.git");
  const session = join(rootDir, "session");

  // Init bare origin
  execFileSync("git", ["init", "--bare", "-b", "main", origin], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

  // Init a temp workspace to make the initial commit and push
  const workspace = join(rootDir, "workspace");
  execFileSync("git", ["clone", origin, workspace], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await initRepo(workspace);
  await writeCommit(workspace, "README.md", "initial\n", "chore: initial commit");
  git(workspace, "push", "origin", "main");

  // Clone session repo and create session branch
  execFileSync("git", ["clone", origin, session], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await initRepo(session);
  git(session, "checkout", "-b", "session");

  // Add a commit on session branch (before main diverges)
  await writeCommit(session, "session.txt", "session work\n", "feat: session work");
  git(session, "push", "-u", "origin", "session");

  // Advance main in workspace and push (diverges from session base)
  await writeCommit(workspace, "upstream.txt", "upstream\n", "feat: upstream change");
  git(workspace, "push", "origin", "main");

  // Fetch in session repo so origin/main is up-to-date
  git(session, "fetch", "origin");

  return { origin, workspace, session };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let rootDir: string;
let repos: TestRepos;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "minsky-sim-"));
  repos = await setupDivergedRepos(rootDir);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("simulateMergeImpl — HEAD restoration (mt#1217)", () => {
  it("no-conflict path: HEAD is restored to session branch after simulation", async () => {
    const { session } = repos;

    // Confirm we're on session before the call
    expect(gitOut(session, "symbolic-ref", "--short", "HEAD")).toBe("session");

    // No conflicting changes — merge should succeed cleanly
    const conflicts = await simulateMergeImpl(session, "session", "origin/main");

    expect(conflicts).toHaveLength(0);

    // Critical regression assertion: must still be on 'session', not detached
    const headRef = gitOut(session, "symbolic-ref", "--short", "HEAD");
    expect(headRef).toBe("session");
  });

  it("conflict path: HEAD is restored to session branch even when conflicts exist", async () => {
    const { session, workspace } = repos;

    // Create a UU (both-modified) conflict: both sides modify a pre-existing file.
    // First push the shared file to origin/main from workspace.
    await writeCommit(workspace, "shared.txt", "original content\n", "feat: add shared file");
    git(workspace, "push", "origin", "main");

    // Fetch in session so session branch has the shared file in its history
    git(session, "fetch", "origin");
    // Merge origin/main into session so session has the shared file
    git(session, "merge", "origin/main");

    // Now both sides modify shared.txt with different content
    await writeCommit(workspace, "shared.txt", "base version\n", "feat: base changes shared");
    git(workspace, "push", "origin", "main");

    await writeCommit(session, "shared.txt", "session version\n", "feat: session changes shared");

    // Fetch so origin/main is current in the session repo
    git(session, "fetch", "origin");

    expect(gitOut(session, "symbolic-ref", "--short", "HEAD")).toBe("session");

    const conflicts = await simulateMergeImpl(session, "session", "origin/main");

    // Should have detected conflict(s)
    expect(conflicts.length).toBeGreaterThan(0);

    // Critical regression assertion: must still be on 'session'
    const headRef = gitOut(session, "symbolic-ref", "--short", "HEAD");
    expect(headRef).toBe("session");
  });

  it("detached-HEAD caller: HEAD is restored to original SHA after simulation", async () => {
    const { session } = repos;

    // Detach HEAD at the current session commit
    const sha = gitOut(session, "rev-parse", "HEAD");
    git(session, "checkout", "--detach", sha);

    // Verify detached state
    let isDetached = false;
    try {
      gitOut(session, "symbolic-ref", "--short", "HEAD");
    } catch {
      isDetached = true;
    }
    expect(isDetached).toBe(true);

    await simulateMergeImpl(session, sha, "origin/main");

    // After simulation HEAD should still be detached at the same SHA
    const restoredSha = gitOut(session, "rev-parse", "HEAD");
    expect(restoredSha).toBe(sha);

    // Confirm still detached (symbolic-ref should throw)
    let stillDetached = false;
    try {
      gitOut(session, "symbolic-ref", "--short", "HEAD");
    } catch {
      stillDetached = true;
    }
    expect(stillDetached).toBe(true);
  });
});
