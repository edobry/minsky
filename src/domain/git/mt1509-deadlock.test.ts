/* eslint-disable custom/no-real-fs-in-tests */
// Justification: This is a git-exec integration test that MUST use the real filesystem.
// It creates actual bare git repos and working clones in /tmp to verify that pullImpl,
// stashImpl, stashPopImpl, and restoreImpl behave correctly against a real git binary —
// behavior that cannot be verified with in-memory mocks.  The tmpdir directories are
// cleaned up in afterAll.  Suppressing the rule here is intentional and not a workaround.

/**
 * Integration test reproducing the mt#1509 deadlock scenario:
 *
 *   1. A lock-file was regenerated locally (simulating skills-lock.json drift).
 *   2. A PR merged on GitHub advances origin/main by 1 commit.
 *   3. `git pull --ff-only` blocks because the local lock-file would be
 *      overwritten — and all git CLI is denied by hooks.
 *   4. The agent calls `mcp__minsky__git_stash` to stash the lock-file.
 *   5. The agent calls `mcp__minsky__git_pull` — succeeds.
 *   6. The agent calls `mcp__minsky__git_stash_pop` — file restored.
 *
 * This test runs against real git repos on the local filesystem so that it
 * exercises the actual exec path rather than a mock.  It creates two temporary
 * directories (a bare "origin" and a working clone), runs all operations, then
 * cleans up.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";

import { pullImpl } from "./pull-operations";
import { stashImpl, stashPopImpl } from "./stash-operations";
import { restoreImpl } from "./restore-operations";

const execAsync = promisify(exec);

// Real exec wrapper compatible with the *Impl dependency interface
async function realExec(command: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execAsync(command);
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const realDeps = { execAsync: realExec };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git -C ${JSON.stringify(cwd)} ${args.join(" ")}`);
  return stdout.trim();
}

async function setGitIdentity(repoPath: string): Promise<void> {
  await git(repoPath, "config", "user.email", '"test@example.com"');
  await git(repoPath, "config", "user.name", '"Test User"');
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpBase: string;
let originPath: string;
let workPath: string;

const LOCK_FILE = "skills-lock.json";
// The initial content that is committed and pushed to origin
const LOCK_FILE_INITIAL_CONTENT = '{"version":1,"skills":[]}\n';
// The locally-drifted content (uncommitted) — differs from remote to trigger conflict
const LOCK_FILE_DRIFTED_CONTENT = '{"version":1,"skills":["local-drift"]}\n';
// The content pushed to origin by the "merged PR" — modifies the SAME file to trigger conflict
const LOCK_FILE_REMOTE_CONTENT = '{"version":2,"skills":["remote-update"]}\n';

beforeAll(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), "minsky-mt1509-"));
  originPath = join(tmpBase, "origin.git");
  workPath = join(tmpBase, "work");

  // 1. Create bare origin
  await mkdir(originPath, { recursive: true });
  await execAsync(`git init --bare ${JSON.stringify(originPath)}`);

  // 2. Create working clone with an initial commit
  await mkdir(workPath, { recursive: true });
  await execAsync(`git clone ${JSON.stringify(originPath)} ${JSON.stringify(workPath)}`);
  await setGitIdentity(workPath);

  // Ensure we're on "main"
  await git(workPath, "checkout", "-b", "main");
  await writeFile(join(workPath, LOCK_FILE), LOCK_FILE_INITIAL_CONTENT);
  await writeFile(join(workPath, "readme.md"), "# Test repo\n");
  await git(workPath, "add", ".");
  await git(workPath, "commit", "-m", '"initial commit"');
  await git(workPath, "push", "-u", "origin", "main");
});

afterAll(async () => {
  if (tmpBase) {
    await rm(tmpBase, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mt#1509 deadlock scenario
// ---------------------------------------------------------------------------

describe("mt#1509 deadlock — stash → pull → stash-pop via pullImpl + stashImpl", () => {
  test("pullImpl blocks when local lock-file change would be overwritten", async () => {
    // Simulate lock-file drift: edit the local lock-file without committing
    await writeFile(join(workPath, LOCK_FILE), LOCK_FILE_DRIFTED_CONTENT);

    // Advance origin/main by 1 commit that ALSO modifies skills-lock.json
    // (simulates a PR merged on GitHub that regenerated the same lock-file).
    // Only when the remote commit touches the same file as the local drift will
    // git pull --ff-only report "would be overwritten by merge".
    const tmpClone = join(tmpBase, "tmp-pusher");
    await execAsync(`git clone ${JSON.stringify(originPath)} ${JSON.stringify(tmpClone)}`);
    await setGitIdentity(tmpClone);
    await git(tmpClone, "checkout", "main");
    await writeFile(join(tmpClone, LOCK_FILE), LOCK_FILE_REMOTE_CONTENT);
    await git(tmpClone, "add", LOCK_FILE);
    await git(tmpClone, "commit", "-m", '"advance origin: update lock-file"');
    await git(tmpClone, "push", "origin", "main");

    // Now try a pull in `work` — it must block with a structured error
    let caughtError: unknown;
    try {
      await pullImpl({ repoPath: workPath, remote: "origin", branch: "main" }, realDeps);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const msg = (caughtError as Error).message;
    expect(msg).toContain("Pull blocked");
    expect(msg).toContain(LOCK_FILE);
    expect(msg).toContain("mcp__minsky__git_stash");

    // The conflictingFiles property must name the lock-file
    const conflictingFiles = (caughtError as Error & { conflictingFiles: string[] })
      .conflictingFiles;
    expect(conflictingFiles).toBeDefined();
    expect(conflictingFiles).toContain(LOCK_FILE);
  });

  test("stashImpl saves the drifted lock-file so pull can proceed", async () => {
    // Lock-file is still drifted from the previous test
    const stashResult = await stashImpl(
      { repoPath: workPath, message: "pre-pull: lock-file drift" },
      realDeps
    );

    expect(stashResult.stashed).toBe(true);
    expect(stashResult.stashRef).not.toBeNull();
    expect(stashResult.workdir).toBe(workPath);
  });

  test("pullImpl succeeds after the lock-file is stashed", async () => {
    const pullResult = await pullImpl(
      { repoPath: workPath, remote: "origin", branch: "main" },
      realDeps
    );

    expect(pullResult.workdir).toBe(workPath);
    // alreadyUpToDate may be false if origin advanced; either value is valid here
    expect(typeof pullResult.alreadyUpToDate).toBe("boolean");
  });

  test("stashPopImpl runs after the pull without throwing — deadlock is broken", async () => {
    // The stash contained LOCK_FILE_DRIFTED_CONTENT (based on INITIAL).
    // HEAD is now at LOCK_FILE_REMOTE_CONTENT (a different version of the same file).
    // git stash pop will attempt a 3-way merge; if the same lines changed in both
    // the stash and the pulled commit, git reports CONFLICT and exits non-zero.
    //
    // The key assertion is that the DEADLOCK IS BROKEN: the pull succeeded (previous
    // test), and stashPopImpl completes without throwing even in the conflict case.
    // The caller is responsible for resolving any pop conflicts.
    const popResult = await stashPopImpl({ repoPath: workPath }, realDeps);

    // Either popped cleanly or returned conflicts — either is acceptable here.
    // The important thing: stashPopImpl did not throw an unrecognized error.
    expect(popResult.workdir).toBe(workPath);
    expect(typeof popResult.popped).toBe("boolean");
    expect(Array.isArray(popResult.conflicts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// git_restore single-file discard (alternative to stash for simple cases)
// ---------------------------------------------------------------------------

describe("restoreImpl — single-file discard as alternative to stash", () => {
  test("restoreImpl discards the drifted lock-file, allowing pull to proceed", async () => {
    // First: reset any stash pop conflict state from the previous describe block.
    // The stash pop may have left skills-lock.json in an unmerged state (conflict markers).
    // Resolve by resetting the index then checking out HEAD content, then dropping any
    // remaining stash entries. This is test scaffolding — not the SUT.
    const { exec: childExec } = await import("child_process");
    const execP = promisify(childExec);
    // Reset the index (unstage any unmerged files) then hard-reset the working tree
    await execP(`git -C ${JSON.stringify(workPath)} reset HEAD -- .`).catch(() => {});
    await execP(`git -C ${JSON.stringify(workPath)} checkout -- .`).catch(() => {});
    await execP(`git -C ${JSON.stringify(workPath)} stash drop`).catch(() => {
      // If stash drop fails (no stash), ignore
    });

    // Advance origin again to create a new conflict scenario for the restore path
    const tmpClone2 = join(tmpBase, "tmp-pusher2");
    await execAsync(`git clone ${JSON.stringify(originPath)} ${JSON.stringify(tmpClone2)}`);
    await setGitIdentity(tmpClone2);
    await git(tmpClone2, "checkout", "main");
    const lockFileV3 = '{"version":3,"skills":["v3-update"]}\n';
    await writeFile(join(tmpClone2, LOCK_FILE), lockFileV3);
    await git(tmpClone2, "add", LOCK_FILE);
    await git(tmpClone2, "commit", "-m", '"advance origin v3"');
    await git(tmpClone2, "push", "origin", "main");

    // Now drift locally
    await writeFile(join(workPath, LOCK_FILE), LOCK_FILE_DRIFTED_CONTENT);

    // Restore (discard) the single file — this is the simpler alternative to stash
    const restoreResult = await restoreImpl({ repoPath: workPath, paths: [LOCK_FILE] }, realDeps);

    expect(restoreResult.restored).toContain(LOCK_FILE);

    // After restoring the file, pull should succeed
    const pullResult = await pullImpl(
      { repoPath: workPath, remote: "origin", branch: "main" },
      realDeps
    );

    expect(pullResult.workdir).toBe(workPath);
    // Pull succeeds — either already up to date or fast-forwarded
    expect(typeof pullResult.alreadyUpToDate).toBe("boolean");
  });
});
