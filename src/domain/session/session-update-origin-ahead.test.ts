/**
 * Regression tests for mt#1304: session_update must refuse to push when
 * origin/<branch> has advanced beyond the local session branch.
 *
 * Background: on 2026-04-26 a session_update call orphaned 6 commits from
 * PR #799 because the push ran against a local branch that was behind the
 * remote — silently rewriting origin without merging those commits.
 *
 * Fix: after fetchLatest, use `git show-ref --verify --quiet` to confirm the
 * remote ref exists before running `git rev-list --left-right --count`. If
 * the ref does not exist (new branch / first push), skip the check entirely.
 * If it does exist and is ahead, throw a MinskyError naming the commit counts
 * and SHAs, and do NOT call push().
 *
 * The upstream ref is resolved via `git rev-parse --abbrev-ref --symbolic-full-name @{u}`
 * to handle branches that track a different remote or ref name, falling back to
 * `${remote || "origin"}/${currentBranch}` when no upstream is configured.
 */

import { describe, it, expect } from "bun:test";
import { updateSessionImpl } from "./session-update-operations";
import { FakeGitService } from "../git/fake-git-service";
import { FakeSessionProvider } from "./fake-session-provider";
import { MinskyError } from "../../errors/index";
import type { SessionRecord } from "./types";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const REV_LIST_CMD = "rev-list --left-right --count";
const SHOW_REF_CMD = "show-ref --verify --quiet";
const RECOVERY_HINT = "Fetch and integrate the remote commits";

/** Deterministic fake SHAs returned by rev-parse for local and remote HEAD. */
const LOCAL_SHA = "aabbccdd00000000000000000000000000000000";
const REMOTE_SHA = "eeff001100000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-mt-1304";
const WORKDIR = "/mock/session/workdir";

function makeSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#1304",
    branch: "task/mt-1304",
  };
}

function makeBaseParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    remote: "origin",
    noStash: true,
    noPush: false,
    force: false,
    skipConflictCheck: false,
    autoResolveDeleteConflicts: false,
    dryRun: false,
    skipIfAlreadyMerged: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a FakeGitService wired for a given remote-ahead count
// ---------------------------------------------------------------------------

/**
 * Configure a FakeGitService to report that origin/<branch> is N commits
 * ahead of the local branch (simulating a parallel agent having pushed).
 *
 * The new implementation first calls show-ref to check existence, then
 * rev-list to compare commits. Both must be configured.
 */
function makeGitService(remoteAheadCount: number, currentBranch = "task/mt-1304"): FakeGitService {
  const svc = new FakeGitService({
    defaultBranch: currentBranch,
    sessionWorkdir: WORKDIR,
  });

  // show-ref succeeds (ref exists) — the default FakeGitService handles this
  // for refs/remotes/ patterns, so no explicit override is needed.

  // Override rev-list to return localAhead=0, remoteAhead=remoteAheadCount
  svc.setCommandResponse(REV_LIST_CMD, `0\t${remoteAheadCount}`);

  // Return deterministic SHAs for rev-parse
  svc.setCommandResponse("rev-parse HEAD", LOCAL_SHA);
  svc.setCommandResponse("rev-parse origin/", REMOTE_SHA);

  return svc;
}

/**
 * Configure a FakeGitService to report that local is N commits ahead of origin
 * (remote is not ahead — the common case where a push is safe).
 */
function makeGitServiceLocalAhead(
  localAheadCount: number,
  currentBranch = "task/mt-1304"
): FakeGitService {
  const svc = new FakeGitService({
    defaultBranch: currentBranch,
    sessionWorkdir: WORKDIR,
  });

  // Override rev-list to return localAhead=N, remoteAhead=0
  svc.setCommandResponse(REV_LIST_CMD, `${localAheadCount}\t0`);

  svc.setCommandResponse("rev-parse HEAD", LOCAL_SHA);
  svc.setCommandResponse("rev-parse origin/", REMOTE_SHA);

  return svc;
}

/**
 * Configure a FakeGitService that simulates the remote ref not existing yet
 * (new branch, no previous push). show-ref fails, so rev-list is never called.
 */
function makeGitServiceNoRemoteRef(currentBranch = "task/mt-1304"): FakeGitService {
  const svc = new FakeGitService({
    defaultBranch: currentBranch,
    sessionWorkdir: WORKDIR,
  });

  // show-ref fails — remote tracking ref does not exist
  svc.setCommandError(
    SHOW_REF_CMD,
    new Error("fatal: 'refs/remotes/origin/task/mt-1304' - not a valid ref")
  );

  // rev-list should NOT be called when show-ref fails, but configure it to
  // throw an unexpected error so we can detect if the code ever invokes it.
  svc.setCommandError(REV_LIST_CMD, new Error("fatal: bad revision 'origin/task/mt-1304'"));

  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateSessionImpl — pre-push origin-ahead safety check (mt#1304)", () => {
  it("throws MinskyError when origin has advanced beyond local", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeGitService(6);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Message must name the remote ref, commit count, and recovery hint
    expect(msg).toContain("origin/task/mt-1304");
    expect(msg).toContain("6 commit");
    expect(msg).toContain(RECOVERY_HINT);
  });

  it("does not call push() when origin has advanced", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeGitService(6);

    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch {
      // expected to throw
    }

    // Verify push() was never called — FakeGitService.pushedCalls records every push() invocation
    expect(gitService.pushedCalls).toHaveLength(0);
  });

  it("proceeds normally when origin is not ahead (0 remote commits)", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    // remoteAheadCount = 0 means parity — no orphan risk
    const gitService = makeGitService(0);

    // Must complete without throwing
    await expect(
      updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();

    // Push must have been invoked exactly once
    expect(gitService.pushedCalls).toHaveLength(1);
  });

  it("skips the safety check when force=true", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    // Remote is 3 ahead, but force=true should bypass the guard
    const gitService = makeGitService(3);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams({ force: true }), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    // force=true bypasses the safety check, so the guard must NOT have fired
    if (caughtError !== undefined) {
      const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
      expect(msg).not.toContain(RECOVERY_HINT);
    }

    // Confirm that show-ref was NOT executed when force=true
    const showRefCmds = gitService.recordedCommands.filter((c) => c.command.includes(SHOW_REF_CMD));
    expect(showRefCmds).toHaveLength(0);

    // Also confirm that rev-list --left-right --count was NOT executed when force=true
    const revListCmds = gitService.recordedCommands.filter((c) => c.command.includes(REV_LIST_CMD));
    expect(revListCmds).toHaveLength(0);
  });

  it("skips the safety check when noPush=true (no push will happen)", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    // Remote is 4 ahead, but noPush=true means we won't push so the guard is irrelevant
    const gitService = makeGitService(4);

    // Must complete without throwing our safety-guard error
    await expect(
      updateSessionImpl(makeBaseParams({ noPush: true }), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();

    // No push should have happened
    expect(gitService.pushedCalls).toHaveLength(0);
  });

  it("does not throw when local is ahead of origin (safe to push)", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    // localAhead=3, remoteAhead=0 — the normal push scenario
    const gitService = makeGitServiceLocalAhead(3);

    // Must complete without throwing
    await expect(
      updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();

    // Push must have been invoked exactly once
    expect(gitService.pushedCalls).toHaveLength(1);
  });

  it("proceeds when remote ref does not exist (new branch, no push yet) — benign path", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });

    // show-ref fails (ref does not exist); rev-list errors with "bad revision" to
    // confirm that the code never reaches it when show-ref reports non-existence.
    const gitService = makeGitServiceNoRemoteRef();

    // Must complete without throwing any safety-check error
    await expect(
      updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      })
    ).resolves.toBeDefined();

    // Push should still be called for the new branch (no remote guard triggered)
    expect(gitService.pushedCalls).toHaveLength(1);

    // rev-list must NOT have been called since show-ref indicated the ref was absent
    const revListCmds = gitService.recordedCommands.filter((c) => c.command.includes(REV_LIST_CMD));
    expect(revListCmds).toHaveLength(0);
  });

  it("re-throws non-benign rev-list errors (unexpected failure)", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });

    // show-ref succeeds (ref exists), then rev-list fails with an unrelated error
    const gitService = new FakeGitService({
      defaultBranch: "task/mt-1304",
      sessionWorkdir: WORKDIR,
    });
    gitService.setCommandError(
      REV_LIST_CMD,
      new Error("fatal: internal git error: object database is corrupt")
    );

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    // Must throw — unrelated rev-list errors should NOT be silently swallowed
    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);
    // The error should bubble up (wrapped or unwrapped) — not be mistaken for benign
    expect(msg).not.toContain(RECOVERY_HINT);
    // The error must be present in the thrown message
    expect(msg).toMatch(/object database is corrupt|Failed to update session/);
  });

  it("error message includes local SHA, remote SHA, and commit count", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });
    const gitService = makeGitService(2);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // Must contain both SHAs returned by the fake rev-parse calls
    expect(msg).toContain(LOCAL_SHA.slice(0, 8));
    expect(msg).toContain(REMOTE_SHA.slice(0, 8));
    expect(msg).toContain("2 commit");
  });

  it("uses actual upstream ref when branch tracking is configured", async () => {
    const sessionRecord = makeSessionRecord();
    const sessionDB = new FakeSessionProvider({
      initialSessions: [sessionRecord],
      sessionWorkdir: WORKDIR,
    });

    // Simulate a branch tracking a non-standard upstream (e.g. "upstream/feature-branch")
    const gitService = new FakeGitService({
      defaultBranch: "task/mt-1304",
      sessionWorkdir: WORKDIR,
    });
    // @{u} resolves to a custom upstream
    gitService.setCommandResponse("@{u}", "upstream/feature-branch");
    // show-ref for the custom upstream ref succeeds
    gitService.setCommandResponse(
      "show-ref --verify --quiet refs/remotes/upstream/feature-branch",
      "abc123 refs/remotes/upstream/feature-branch"
    );
    // rev-list returns remote ahead = 5
    gitService.setCommandResponse(REV_LIST_CMD, "0\t5");
    gitService.setCommandResponse("rev-parse HEAD", LOCAL_SHA);
    gitService.setCommandResponse("rev-parse upstream/", REMOTE_SHA);

    let caughtError: unknown;
    try {
      await updateSessionImpl(makeBaseParams(), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(MinskyError);
    const msg = caughtError instanceof Error ? caughtError.message : String(caughtError);

    // The error message must reference the actual upstream ref, not origin/<currentBranch>
    expect(msg).toContain("upstream/feature-branch");
    expect(msg).toContain("5 commit");
    expect(msg).toContain(RECOVERY_HINT);
  });
});
