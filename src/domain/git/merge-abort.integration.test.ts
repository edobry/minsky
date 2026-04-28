/* eslint-disable custom/no-real-fs-in-tests -- integration: real git state-machine tests */
/**
 * Integration tests for mergeWithConflictPrevention and smartSessionUpdate.
 *
 * These tests use real git repos (temp dirs) because the behavior being tested
 * is specifically about the git working-tree state-machine.
 *
 * mt#1367 fix: when a 3-way merge produces conflicts, the merge is left in
 * progress (MERGE_HEAD exists, UU status, conflict markers in files) so agents
 * can resolve via session_edit_file / session_search_replace and then commit.
 * The previous behavior called git merge --abort which wiped markers, making
 * resolution impossible.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { ConflictDetectionService } from "./conflict-detection";
import type { ConflictDetectionDeps } from "./conflict-detection";
import { execAsync } from "../../utils/exec";
import type { GitExecOptions, GitExecResult } from "../../utils/git-exec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use execFileSync with argv array (not a shell string) so args containing
// spaces — like commit messages — don't get re-split by the shell.
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

/**
 * Bootstrap a minimal git repo with user identity configured.
 */
async function initRepo(dir: string): Promise<void> {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}

/**
 * Create a commit in `dir` writing `content` to `filename`.
 * Returns the new commit hash.
 */
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
  /** "origin" bare repo that both clone and session reference */
  origin: string;
  /** clone used to simulate the "base branch" (main) advancing */
  base: string;
  /** session repo (another clone of origin) */
  session: string;
}

/**
 * Set up two clones of a bare origin:
 *  - base:    where we advance main
 *  - session: where the session branch lives
 *
 * Initial state: origin has one commit on main; both clones are up-to-date.
 * The session clone has a `session-branch` checked out.
 */
async function setupTwoClones(rootDir: string): Promise<TestRepos> {
  const origin = join(rootDir, "origin.git");
  const base = join(rootDir, "base");
  const session = join(rootDir, "session");

  // 1. Init bare origin
  execFileSync("git", ["init", "--bare", "-b", "main", origin], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

  // 2. Init base clone, make initial commit, push to origin
  execFileSync("git", ["clone", origin, base], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await initRepo(base); // sets user config; init already done by clone
  await writeCommit(base, "README.md", "initial\n", "chore: initial commit");
  git(base, "push", "origin", "main");

  // 3. Clone session repo from origin and create session branch
  execFileSync("git", ["clone", origin, session], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await initRepo(session); // sets user config
  git(session, "checkout", "-b", "session-branch");
  git(session, "push", "-u", "origin", "session-branch");

  return { origin, base, session };
}

/**
 * Build a ConflictDetectionDeps object whose gitFetchWithTimeout stub runs
 * `git fetch origin` synchronously inside `sessionDir` and returns the
 * minimal GitExecResult shape that the type requires.
 */
function makeDeps(sessionDir: string): ConflictDetectionDeps {
  return {
    execAsync,
    gitFetchWithTimeout: async (
      _remote?: string,
      _branch?: string,
      _opts: GitExecOptions = {}
    ): Promise<GitExecResult> => {
      git(sessionDir, "fetch", "origin");
      return { stdout: "", stderr: "", command: "git fetch origin", executionTimeMs: 0 };
    },
    log: {
      debug: (_msg: string, _ctx?: Record<string, unknown>) => {},
      warn: (_msg: string, _ctx?: Record<string, unknown>) => {},
      error: (_msg: string, _ctx?: Record<string, unknown>) => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let rootDir: string;
let repos: TestRepos;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "minsky-merge-abort-"));
  repos = await setupTwoClones(rootDir);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeWithConflictPrevention — working tree state after merge", () => {
  it("happy path: fast-forward merge, session commit preserved", async () => {
    const { base, session } = repos;

    // Advance main in base and push to origin
    await writeCommit(base, "upstream.txt", "upstream change\n", "feat: upstream change");
    git(base, "push", "origin", "main");

    // Record session HEAD before update
    const sessionHeadBefore = gitOut(session, "rev-parse", "HEAD");

    // Fetch origin in session repo so we can reference origin/main
    git(session, "fetch", "origin");

    // Since session-branch has no diverging commits, this should fast-forward
    const result = await ConflictDetectionService.mergeWithConflictPrevention(
      session,
      "origin/main",
      "session-branch",
      { skipConflictCheck: true }
    );

    expect(result.conflicts).toBe(false);
    expect(result.merged).toBe(true);

    // Session HEAD should have advanced
    const sessionHeadAfter = gitOut(session, "rev-parse", "HEAD");
    expect(sessionHeadAfter).not.toBe(sessionHeadBefore);

    // Working tree must be clean
    const status = gitOut(session, "status", "--porcelain");
    expect(status).toBe("");
  });

  it("conflict path: conflict markers are present in working tree (merge left in progress)", async () => {
    const { base, session } = repos;

    // Both sides modify the same file with conflicting content
    await writeCommit(base, "shared.txt", "base version\n", "feat: base changes shared.txt");
    git(base, "push", "origin", "main");

    await writeCommit(
      session,
      "shared.txt",
      "session version\n",
      "feat: session changes shared.txt"
    );

    // Fetch origin so session repo has origin/main
    git(session, "fetch", "origin");

    const result = await ConflictDetectionService.mergeWithConflictPrevention(
      session,
      "origin/main",
      "session-branch",
      { skipConflictCheck: true }
    );

    // Should report conflict
    expect(result.conflicts).toBe(true);
    expect(result.merged).toBe(false);

    // mt#1367: the merge is left in progress so agents can resolve markers.
    // Working tree must show a conflict status (UU=both-modified, AA=both-added)
    // and MERGE_HEAD must exist.
    const status = gitOut(session, "status", "--porcelain");
    const hasConflictStatus =
      status.includes("UU") || status.includes("AA") || status.includes("DD");
    expect(hasConflictStatus).toBe(true);

    // MERGE_HEAD must exist (merge is in progress)
    const mergeHeadExists = await execAsync(
      `test -f ${join(session, ".git", "MERGE_HEAD")} && echo yes || echo no`
    );
    expect(mergeHeadExists.stdout.trim()).toBe("yes");

    // conflictedFiles must list the conflicted path
    expect(result.conflictedFiles).toBeDefined();
    expect(result.conflictedFiles).toContain("shared.txt");
  });
});

describe("smartSessionUpdate — end-to-end scenarios", () => {
  it("already-merged short-circuit: skips when session changes are in base", async () => {
    const { base, session } = repos;

    // Make a commit on session branch
    await writeCommit(session, "feat.txt", "my feature\n", "feat: add feature");
    git(session, "push", "origin", "session-branch");

    // Simulate the session changes being cherry-picked / merged into base (main)
    // by making an identical commit on base
    await writeCommit(base, "feat.txt", "my feature\n", "feat: add feature");
    git(base, "push", "origin", "main");

    // Now smartSessionUpdate should short-circuit (already merged)
    const result = await ConflictDetectionService.smartSessionUpdate(
      session,
      "session-branch",
      "main",
      { skipIfAlreadyMerged: true },
      makeDeps(session)
    );

    expect(result.skipped).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain("already");
  });

  it("happy path: fast-forward when session is behind base", async () => {
    const { base, session } = repos;

    // Advance main with a new commit that doesn't conflict
    await writeCommit(base, "base-only.txt", "base only content\n", "feat: base-only commit");
    git(base, "push", "origin", "main");

    const result = await ConflictDetectionService.smartSessionUpdate(
      session,
      "session-branch",
      "main",
      {},
      makeDeps(session)
    );

    expect(result.updated).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toMatch(/fast.forward|merge/i);

    // Working tree should be clean
    const status = gitOut(session, "status", "--porcelain");
    expect(status).toBe("");
  });

  it("conflict path: returns conflict details and leaves markers in working tree", async () => {
    const { base, session } = repos;

    // Both sides modify the same file with conflicting content
    await writeCommit(base, "conflict.txt", "base content\n", "feat: base changes conflict.txt");
    git(base, "push", "origin", "main");

    await writeCommit(
      session,
      "conflict.txt",
      "session content\n",
      "feat: session changes conflict.txt"
    );

    const result = await ConflictDetectionService.smartSessionUpdate(
      session,
      "session-branch",
      "main",
      {},
      makeDeps(session)
    );

    // Should surface conflict
    expect(result.updated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.conflictDetails).toBeDefined();
    expect(result.reason).toContain("conflict");

    // mt#1367: merge is left in progress so markers are visible in the working tree.
    // Agents can resolve them via session_edit_file / session_search_replace.
    const status = gitOut(session, "status", "--porcelain");
    const hasConflictStatus =
      status.includes("UU") || status.includes("AA") || status.includes("DD");
    expect(hasConflictStatus).toBe(true);

    // MERGE_HEAD must exist (merge in progress)
    const mergeHeadExists = await execAsync(
      `test -f ${join(session, ".git", "MERGE_HEAD")} && echo yes || echo no`
    );
    expect(mergeHeadExists.stdout.trim()).toBe("yes");

    // conflictedFiles must be populated
    expect(result.conflictedFiles).toBeDefined();
    expect(result.conflictedFiles).toContain("conflict.txt");
  });
});
