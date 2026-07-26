/**
 * Regression tests for mt#3049: session_commit can time out without
 * confirming whether its push completed — commit lands locally, remote/PR
 * HEAD stays stale.
 *
 * Covers:
 *   1. raceAgainstTimeout (pure) — the timeout branch wins deterministically
 *      when injected with an instantly-resolving signal, with no real
 *      wall-clock wait (mt#2980-style injectable timing, not a real sleep).
 *   2. sessionCommit: push fails after a successful commit → RETURNS (does
 *      not throw) a structured partial outcome: commitHash set, pushed:false,
 *      pushError carrying the underlying failure (Acceptance Test 1).
 *   3. sessionCommit: a repeat call on an otherwise-clean tree with a
 *      pending (never-landed) push completes it — resumedPush:true,
 *      pushed:true, commitHash unchanged (Acceptance Test 2).
 *   4. sessionCommit: a repeat call on a tree that is ALREADY fully in sync
 *      with origin still returns the historical plain no-op (no spurious
 *      push attempt) — pins the fail-open fallback.
 *   5. sessionCommit: commit phase exceeding commitTimeoutMs throws
 *      SessionCommitPhaseTimeoutError naming phase:"commit".
 *
 * Also covers two pre-existing, previously-undiscovered bugs found as a
 * side effect of implementing (and actually testing) the above, both in the
 * exact same function this task modifies:
 *   6. The commit-metadata `git log -1 --pretty=format:%h|%s|%an|%ae|%aI`
 *      call had UNQUOTED pipe characters, which `execInRepository`'s
 *      shell-backed execution interpreted as real shell pipes — so this
 *      call threw on every single session_commit invocation, silently
 *      degrading shortHash/subject/authorName/authorEmail/timestamp to
 *      undefined (caught, logged at debug, never surfaced). No prior test
 *      asserted these fields were populated.
 *   7. The mt#1522 branch-freshness CAS check's `resolveRefSha` used
 *      `git rev-parse -- <ref>`, and `--` makes git treat everything after
 *      it as a PATHSPEC, not a revision — so it never resolved to a SHA,
 *      `checkFreshnessCas` always saw `resolveRefSha` return `null`, and
 *      classified every single push as `bypass: "ref-unresolvable"`. The
 *      CAS check (meant to abort a push when `origin/main` advanced since
 *      the freshness hook's allow decision) had been silently inert since
 *      mt#1522 shipped.
 *
 * Strategy mirrors session-commit-no-files.test.ts / session-commit-push-
 * credential.test.ts: real temp git repos with a local bare remote, because
 * sessionCommit shells out to git.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required because we need a genuine git repository
// for the tests to exercise the actual commit/push paths end-to-end.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import {
  sessionCommit,
  raceAgainstTimeout,
  SessionCommitPhaseTimeoutError,
  FreshnessCasError,
} from "./session-commands";
import { writeFreshnessMarker } from "./freshness-marker";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";

// Guard against ambient GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/GIT_COMMITTER_NAME/
// GIT_COMMITTER_EMAIL env vars leaking into this file's git subprocesses.
// Git itself sets these when invoking hooks (pre-commit, commit-msg) for the
// OUTER commit being made — so when THIS test file is picked up by
// `run-related-tests.ts` as part of an actual `session_commit`-driven
// pre-commit run, `sessionCommit()`'s internal `git commit` call (via
// `child_process.exec`, which inherits `process.env` by default) silently
// picks up the OUTER commit's real identity instead of the isolated temp
// repo's LOCAL `user.name`/`user.email` config — env vars always override
// local config. Reproduced deterministically by setting these 4 vars before
// running this file directly; not a bug in `sessionCommit` this task needs to
// fix (out of mt#3177's scope — this task is about push confirmation, not
// commit identity), just a test-isolation gap this file needs regardless of
// invocation context.
for (const key of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]) {
  delete process.env[key];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "test-session-uuid",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#3049",
    agentId: "com.anthropic.claude-code:proc:test-agent",
    ...overrides,
  };
}

function makeSessionProvider(record: SessionRecord, workdir: string): FakeSessionProvider {
  return new FakeSessionProvider({
    initialSessions: [record],
    sessionWorkdir: workdir,
  });
}

/** Create a temp git repo with one initial commit and a staged pending change. */
async function makeTmpDirtyGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-push-outcome-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
  execSync("git add pending.txt", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** Bare-clone the repo as its own origin so push succeeds locally. */
function addLocalRemote(repoDir: string): string {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  return bareDir;
}

/**
 * Install a real `.git/hooks/pre-commit` that sleeps before succeeding —
 * used to exercise the commit-phase timeout deterministically: set
 * `commitTimeoutMs` far below the sleep duration so the timeout always wins,
 * with no reliance on scheduling jitter (the sleep duration only needs to be
 * "long enough to comfortably outlast a tiny injected timeout", not tuned to
 * real-world pre-commit cost).
 */
async function makeTmpCleanGitRepoWithSlowPreCommitHook(sleepSeconds: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-push-outcome-slow-hook-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  const hookPath = join(dir, ".git", "hooks", "pre-commit");
  const hookScript = ["#!/bin/sh", `sleep ${sleepSeconds}`, "exit 0", ""].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return dir;
}

/**
 * Bare-clone the repo as its own origin (like `addLocalRemote`) but install a
 * hook INSIDE the bare "remote" that sleeps for `sleepSeconds` — used to
 * force a genuine, deterministic push-phase timeout for the mt#3177 tests
 * below without any network dependency or fake server.
 *
 * `hookName` picks WHERE in the remote's push lifecycle the sleep happens,
 * which is what distinguishes the two mt#3177 acceptance-test shapes:
 *   - "pre-receive" fires BEFORE the remote updates its refs — sleeping here
 *     delays the ref update itself, so a client-side timeout that fires
 *     during the sleep is genuinely correct that the push has NOT landed yet
 *     (AT1: pushUnconfirmed).
 *   - "post-receive" fires AFTER the remote has ALREADY updated its refs —
 *     sleeping here reproduces the exact mt#3177 recurrence shape: the push
 *     has already landed server-side, but the client (waiting for the git
 *     process to return) is still blocked (AT2: pushConfirmedVia).
 */
async function addLocalRemoteWithHook(
  repoDir: string,
  hookName: "pre-receive" | "post-receive",
  sleepSeconds: number
): Promise<string> {
  const bareDir = addLocalRemote(repoDir);
  const hookPath = join(bareDir, "hooks", hookName);
  const hookScript = ["#!/bin/sh", `sleep ${sleepSeconds}`, "exit 0", ""].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp bare repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return bareDir;
}

/** `git log --oneline -N` in `dir`, as a string — shared helper (was duplicated
 * across several tests below; `custom/no-magic-string-duplication` flags the
 * repeated literal command strings). */
function gitLogOneline(dir: string, count: number): string {
  return execSync(`git log --oneline -${count}`, { cwd: dir }).toString();
}

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

// ---------------------------------------------------------------------------
// raceAgainstTimeout (pure, instant — no real wall-clock wait)
// ---------------------------------------------------------------------------

describe("raceAgainstTimeout", () => {
  test("resolves with the operation's value when it wins the race", async () => {
    const result = await raceAgainstTimeout(Promise.resolve("done"), 10_000);
    expect(result).toEqual({ timedOut: false, value: "done" });
  });

  test("resolves with timedOut:true when an injected instant timeout signal wins", async () => {
    // The operation never resolves on its own; the injected timeout signal
    // resolves immediately regardless of the requested ms, so this is
    // deterministic and takes ~0ms — no real sleep involved (mt#2980 style).
    const neverResolves = new Promise<string>(() => {});
    const instantTimeout = async (): Promise<{ timedOut: true }> => ({ timedOut: true });

    const result = await raceAgainstTimeout(neverResolves, 999_999, instantTimeout);
    expect(result).toEqual({ timedOut: true });
  });
});

// ---------------------------------------------------------------------------
// sessionCommit: push fails after a successful commit (AT1)
// ---------------------------------------------------------------------------

describe("sessionCommit push-failure structured partial outcome (mt#3049 AT1)", () => {
  test("push failure after successful commit returns (not throws) commitHash + pushed:false + pushError", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);
    // Point origin at a path that does not exist — `git push` fails fast
    // with a real git error, simulating "push fails after commit lands"
    // without needing a real hang.
    execSync(`git remote add origin "${repoDir}/does-not-exist.bare"`, {
      cwd: repoDir,
      stdio: "ignore",
    });

    const record = makeSessionRecord({ sessionId: "push-fail-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "push-fail-session", message: "test: push should fail", all: true },
      sessionProvider
    );

    // The commit succeeded and MUST be reported, even though push did not.
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(typeof result.commitHash).toBe("string");
    expect(result.pushed).toBe(false);
    expect(result.pushError).toBeTruthy();
    expect(result.pushTimedOut).toBeFalsy();

    // The commit really did land locally (this is the "committed but push
    // omitted" gap mt#3049 closes — verify it's not a fabricated sha).
    const log = gitLogOneline(repoDir, 2);
    expect(log).toContain("push should fail");
  });
});

// ---------------------------------------------------------------------------
// sessionCommit: resumable push (AT2)
// ---------------------------------------------------------------------------

describe("sessionCommit resumable push (mt#3049 AT2)", () => {
  test("a repeat call on a clean tree with a pending push completes it", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);

    // Create the "eventually correct" bare remote from the CURRENT state —
    // pending.txt is only staged (not committed) at this point, so the bare
    // clone captures just the "init" commit. This is the remote origin will
    // be pointed at AFTER the first (failed) push, and it genuinely lacks
    // the commit the first call is about to create — the precondition the
    // resumable path needs to have something real to detect and complete.
    const bareDir = `${repoDir}.bare`;
    execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
    tmpDirs.push(bareDir);

    // Point origin at a BROKEN path for the first call, forcing its push to
    // fail (same shape as the AT1 test above). Tree is clean afterward
    // (nothing new staged) — the local commit landed but never reached any
    // remote.
    const brokenRemote = `${repoDir}/does-not-exist.bare`;
    execSync(`git remote add origin "${brokenRemote}"`, { cwd: repoDir, stdio: "ignore" });

    const RESUME_PUSH_SESSION_ID = "resume-push-session";
    const record = makeSessionRecord({ sessionId: RESUME_PUSH_SESSION_ID });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const first = await sessionCommit(
      { session: RESUME_PUSH_SESSION_ID, message: "test: pending push", all: true },
      sessionProvider
    );
    expect(first.success).toBe(true);
    expect(first.pushed).toBe(false);
    expect(first.commitHash).toBeTruthy();

    // Fix the remote — point origin at the pre-existing bare clone (which
    // still only has "init"), simulating the underlying transient problem
    // resolving before the follow-up call.
    execSync(`git remote set-url origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });

    // Second call: tree is clean (no new changes) — this is the resumable
    // path: it must detect the still-unpushed first commit and complete it,
    // NOT silently report "nothing to commit" again.
    const second = await sessionCommit(
      { session: RESUME_PUSH_SESSION_ID, message: "test: should not be used" },
      sessionProvider
    );

    expect(second.success).toBe(true);
    expect(second.resumedPush).toBe(true);
    expect(second.pushed).toBe(true);
    // No NEW commit was created — same sha as the first call's commit.
    expect(second.commitHash).toBe(first.commitHash);

    // Verify the commit actually reached the (now-fixed) remote.
    const remoteLog = gitLogOneline(bareDir, 3);
    expect(remoteLog).toContain("pending push");
  });

  test("a repeat call on a tree already fully in sync with origin returns the plain no-op", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = `${repoDir}.bare`;
    execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
    execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "in-sync-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    // First call commits AND pushes successfully — HEAD and origin/<branch>
    // end up in agreement.
    const first = await sessionCommit(
      { session: "in-sync-session", message: "test: fully synced", all: true },
      sessionProvider
    );
    expect(first.success).toBe(true);
    expect(first.pushed).toBe(true);

    // Second call on the now-clean, fully-synced tree — nothing pending,
    // must fall back to the historical plain no-op (no resumedPush, no
    // spurious push attempt).
    const second = await sessionCommit(
      { session: "in-sync-session", message: "test: should not commit" },
      sessionProvider
    );

    expect(second.success).toBe(true);
    expect(second.nothingToCommit).toBe(true);
    expect(second.resumedPush).toBeFalsy();
    expect(second.pushed).toBe(false);
    expect(second.commitHash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionCommit: push-phase timeout + remote-ref confirmation (mt#3177)
// ---------------------------------------------------------------------------

describe("sessionCommit push-timeout remote confirmation (mt#3177 acceptance tests)", () => {
  test("AT1: push times out and the remote genuinely has not advanced -> pushUnconfirmed:true, pushed:false", async () => {
    // pre-receive fires BEFORE the remote updates its ref, so a client-side
    // timeout that fires during the sleep is genuinely correct: the push has
    // NOT landed. pushTimeoutMs (20ms) is far below the hook's sleep (2s), so
    // the timeout deterministically wins. Sleep kept short (not the 5-8s used
    // by an earlier revision) to minimize how long the abandoned background
    // push subprocess lingers after this test returns — raceAgainstTimeout
    // does not kill it (see pushWithConfirmation's doc comment), and a longer
    // lingering orphan raised observed cross-test flakiness under load.
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);
    const bareDir = await addLocalRemoteWithHook(repoDir, "pre-receive", 2);
    tmpDirs.push(bareDir);

    const record = makeSessionRecord({ sessionId: "push-unconfirmed-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      {
        session: "push-unconfirmed-session",
        message: "test: push should time out unconfirmed",
        all: true,
        pushTimeoutMs: 20,
      },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushUnconfirmed).toBe(true);
    expect(result.pushConfirmedVia).toBeUndefined();

    // No consumer can mistake this for success: never both pushed:true and
    // pushUnconfirmed:true at once.
    expect(result.pushed && result.pushUnconfirmed).toBeFalsy();
  }, 15000);

  test("AT2: push times out but the remote already landed it -> pushed:true, pushConfirmedVia:'remote-check'", async () => {
    // post-receive fires AFTER the remote has ALREADY updated its ref —
    // reproducing the exact mt#3177 recurrence shape: the push has landed
    // server-side, but the client (waiting for git to return) is still
    // blocked. pushTimeoutMs (500ms) needs to be LONGER than the actual
    // transfer + ref-update (tens of ms for this tiny repo) so the remote
    // genuinely has the new ref by the time our client-side bound fires, but
    // far shorter than the hook's 3s sleep so the timeout still deterministically
    // wins (session_commit's own confirmation never waits for the hook to
    // finish) — the remote-ref check run immediately after is what discovers
    // the ref already advanced. Sleep kept short for the same lingering-orphan
    // reason noted on AT1 above.
    const repoDir = await makeTmpDirtyGitRepo();
    tmpDirs.push(repoDir);
    const bareDir = await addLocalRemoteWithHook(repoDir, "post-receive", 3);
    tmpDirs.push(bareDir);

    const record = makeSessionRecord({ sessionId: "push-confirmed-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      {
        session: "push-confirmed-session",
        message: "test: push confirmed via remote check",
        all: true,
        pushTimeoutMs: 500,
      },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
    expect(result.pushed).toBe(true);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushConfirmedVia).toBe("remote-check");
    expect(result.pushUnconfirmed).toBeUndefined();

    // Verify the commit really did land on the remote (not a fabricated
    // confirmation) — read the bare repo's ref directly.
    const remoteLog = gitLogOneline(bareDir, 2);
    expect(remoteLog).toContain("push confirmed via remote check");
  }, 15000);
});

// ---------------------------------------------------------------------------
// sessionCommit: commit-phase timeout
// ---------------------------------------------------------------------------

describe("sessionCommit commit-phase timeout (mt#3049)", () => {
  test("commit phase exceeding commitTimeoutMs throws SessionCommitPhaseTimeoutError naming phase:'commit'", async () => {
    // Hook sleeps for a few seconds; the injected commitTimeoutMs is a tiny
    // fraction of that, so the timeout deterministically wins without the
    // test needing to wait anywhere near the hook's full sleep duration.
    const repoDir = await makeTmpCleanGitRepoWithSlowPreCommitHook(5);
    tmpDirs.push(repoDir);

    const record = makeSessionRecord({ sessionId: "commit-timeout-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);
    await writeFile(join(repoDir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
    execSync("git add pending.txt", { cwd: repoDir, stdio: "ignore" });

    let caught: unknown;
    try {
      await sessionCommit(
        {
          session: "commit-timeout-session",
          message: "test: commit should time out",
          all: true,
          commitTimeoutMs: 100,
        },
        sessionProvider
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SessionCommitPhaseTimeoutError);
    const err = caught as SessionCommitPhaseTimeoutError;
    expect(err.phase).toBe("commit");
    expect(err.timeoutMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing bug #6: commit-metadata fields were always undefined
// ---------------------------------------------------------------------------

describe("sessionCommit commit metadata population (mt#3049 regression)", () => {
  test("shortHash/subject/authorName/authorEmail/timestamp are populated, not silently undefined", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "metadata-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "metadata-session", message: "test: metadata should populate", all: true },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    // Before the fix, EVERY one of these was undefined on every call (the
    // git log call threw due to unquoted `|`, caught and logged at debug).
    expect(result.shortHash).toBeTruthy();
    expect(result.subject).toBe("test: metadata should populate");
    expect(result.authorName).toBe("Test");
    expect(result.authorEmail).toBe("test@example.com");
    expect(result.timestamp).toBeTruthy();
  });

  // Review R1 (PR #2183): a `|`-delimited split corrupts fields when the
  // commit SUBJECT itself contains a `|` — distinct from (and found only
  // after fixing) the unquoted-pipe shell bug above. NUL (`%x00`) cannot
  // appear in git's rendered plain-text fields, so it's an unambiguous
  // delimiter regardless of subject content.
  test("a commit subject containing '|' does not corrupt subsequent metadata fields", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "pipe-subject-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      {
        session: "pipe-subject-session",
        message: "test: A|B|C should not shift fields",
        all: true,
      },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.subject).toBe("test: A|B|C should not shift fields");
    expect(result.authorName).toBe("Test");
    expect(result.authorEmail).toBe("test@example.com");
    expect(result.timestamp).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Pre-existing bug #7: the freshness CAS check never actually resolved a ref
// ---------------------------------------------------------------------------

describe("sessionCommit branch-freshness CAS check (mt#3049 regression)", () => {
  test("a stale freshness marker actually blocks the push with FreshnessCasError", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const branch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir }).toString().trim();

    // Write a freshness marker claiming a WRONG (stale) sha for origin/<branch>
    // — the real origin/<branch> sha (captured further below, after fetch)
    // will differ, so `checkFreshnessCas` must detect the mismatch and abort.
    // Before the fix, `resolveRefSha`'s `git rev-parse -- <ref>` never
    // resolved anything, so this always bypassed as "ref-unresolvable" and
    // the push proceeded regardless of what the marker claimed.
    writeFreshnessMarker(repoDir, {
      mainRef: `origin/${branch}`,
      sha: "0".repeat(40),
      toolName: "mcp__minsky__session_commit",
      ts: new Date().toISOString(),
    });

    const record = makeSessionRecord({ sessionId: "cas-block-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    let caught: unknown;
    try {
      await sessionCommit(
        { session: "cas-block-session", message: "test: should be CAS-blocked", all: true },
        sessionProvider
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FreshnessCasError);
    const err = caught as FreshnessCasError;
    expect(err.capturedSha).toBe("0".repeat(40));
    // Review R1 (PR #2183): checkFreshnessCas now threads mainRef back
    // instead of the caller receiving an empty string, losing which ref
    // advanced.
    expect(err.mainRef).toBe(`origin/${branch}`);
    // The commit itself lands locally (freshness is checked AFTER commit,
    // BEFORE push) — the CAS check exists to stop the PUSH, not the commit.
    const log = gitLogOneline(repoDir, 2);
    expect(log).toContain("should be CAS-blocked");
    // And critically, it must NOT have reached the remote.
    const remoteLog = gitLogOneline(bareDir, 3);
    expect(remoteLog).not.toContain("should be CAS-blocked");
  });

  test("a freshness marker matching the real origin sha allows the push through", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const branch = execSync("git symbolic-ref --short HEAD", { cwd: repoDir }).toString().trim();
    const realSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

    writeFreshnessMarker(repoDir, {
      mainRef: `origin/${branch}`,
      sha: realSha,
      toolName: "mcp__minsky__session_commit",
      ts: new Date().toISOString(),
    });

    const record = makeSessionRecord({ sessionId: "cas-allow-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "cas-allow-session", message: "test: should pass CAS", all: true },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
  });
});
