/**
 * Regression tests for mt#3205 Gap 1 (the must-fix): `updateSessionImpl`'s
 * push step — reached directly by `session_update` and, via STEP 6 of
 * `session_pr_create` (which hardcodes `noPush: false`), on EVERY PR
 * creation — previously called the raw unbounded `deps.gitService.push()`.
 * That is the exact bug class mt#3177 fixed for `session_commit` and the
 * standalone `git.push` MCP command: an unbounded push can hang until the
 * MCP transport itself aborts at ~1800s.
 *
 * `GitService.push()` (git.ts) now delegates to `pushWithConfirmation`
 * internally (mt#3177's primitive), so every caller reaching it through the
 * injected `GitServiceInterface.push()` inherits the bound automatically.
 * These tests exercise `updateSessionImpl` end-to-end with a REAL push
 * against a REAL bare "remote" whose `pre-receive` hook sleeps — proving
 * the acceptance test's literal claim ("a forced hang ... returns a
 * bounded, explicit unconfirmed result rather than blocking to the
 * transport idle-timeout"), not just that the field-handling logic is
 * wired correctly against a canned mock.
 *
 * Strategy: `FakeGitService`/`FakeSessionProvider` provide fast, in-memory
 * behavior for every step BEFORE push (merge, stash, dependency-refresh
 * checks — none of which touch the real filesystem), while `push` itself is
 * overridden to delegate to the REAL `pushWithConfirmation` against a real
 * temp git repo + bare remote, mirroring `session-commit-push-outcome.test.ts`'s
 * hook-based timeout pattern.
 *
 * A second describe block below exercises the SAME `updateSessionImpl`
 * behavior through `FakeGitService`'s own (now widened) `push()` — using
 * `setPushOutcomes` to script a `pushUnconfirmed` outcome directly, no real
 * git subprocess involved. This is the project's main test seam for
 * `session-update-*` tests generally; before this task it could only ever
 * return `{pushed: true}`, so no test injecting `FakeGitService` had any way
 * to exercise the confirmation paths this task adds — a fidelity gap
 * independent of (and complementary to) the real-hang tests above.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required because we need a genuine git repository
// + bare remote for updateSessionImpl's push step to exercise the actual
// pushWithConfirmation path end-to-end.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { updateSessionImpl } from "./session-update-operations";
import { pushWithConfirmation } from "../git/push-operations";
import { execAsync } from "@minsky/shared/exec";
import { FakeGitService } from "../git/fake-git-service";
import { FakeSessionProvider } from "./fake-session-provider";
import { MinskyError } from "../errors/index";
import type { SessionRecord } from "./types";
import type { PushOptions } from "../git/types";
import type { PushWithConfirmationConfig } from "../git/push-operations";

const SESSION_ID = "test-session-mt-3205";

function makeSessionRecord(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#3205",
    branch: "task/mt-3205",
  };
}

function makeBaseParams(workdir: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    remote: "origin",
    noStash: false,
    noPush: false,
    force: false,
    skipConflictCheck: false,
    autoResolveDeleteConflicts: false,
    dryRun: false,
    skipIfAlreadyMerged: false,
    ...overrides,
  };
}

/** Real temp git repo with one commit — enough for a real `git push` to run against. */
async function makeTmpGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-session-update-push-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Bare-clone the repo as its own origin, with a `pre-receive` hook that
 * sleeps `sleepSeconds` before accepting the push — fires BEFORE the remote
 * updates its ref, so a client-side timeout during the sleep is genuinely
 * correct that the push has NOT landed (the AT1 shape: `pushUnconfirmed`).
 * Mirrors `addLocalRemoteWithHook` in session-commit-push-outcome.test.ts.
 */
async function addHangingBareRemote(repoDir: string, sleepSeconds: number): Promise<string> {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  const hookPath = join(bareDir, "hooks", "pre-receive");
  const hookScript = ["#!/bin/sh", `sleep ${sleepSeconds}`, "exit 0", ""].join("\n");
  await writeFile(hookPath, hookScript); // eslint-disable-line custom/no-real-fs-in-tests -- real git hook for a real temp bare repo
  execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  return bareDir;
}

/** Plain bare remote (no hook) — the fast-success control case. */
function addPlainBareRemote(repoDir: string): string {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  return bareDir;
}

/**
 * A FakeGitService whose `push()` delegates to the REAL `pushWithConfirmation`
 * (real subprocess, real timeout race) instead of the fake's instant canned
 * `{pushed: true}` — every other method stays on the fast in-memory default.
 */
function makeRealPushGitService(): FakeGitService {
  const svc = new FakeGitService({ defaultBranch: "task/mt-3205" });
  svc.push = async (options: PushOptions, config?: PushWithConfirmationConfig) =>
    pushWithConfirmation(options, { execAsync }, config);
  return svc;
}

function makeSessionDB(workdir: string): FakeSessionProvider {
  return new FakeSessionProvider({
    initialSessions: [makeSessionRecord()],
    sessionWorkdir: workdir,
  });
}

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

describe("updateSessionImpl push-timeout confirmation (mt#3205 AT1)", () => {
  test("a forced hang on the push path throws a bounded, explicit MinskyError naming the unconfirmed push, well under the transport idle-timeout", async () => {
    const repoDir = await makeTmpGitRepo();
    tmpDirs.push(repoDir);
    // Clone the bare remote BEFORE the pending commit below, so its ref
    // only has "init" — the local repo's HEAD is then genuinely AHEAD of
    // the remote at push time (simulating the real scenario: a session
    // commit exists locally that session_update/session_pr_create is
    // trying to push). Without this divergence, the remote's ref would
    // already equal the local HEAD from the moment of cloning, and
    // verifyRemoteRefAdvanced's SHA comparison would trivially "confirm"
    // regardless of whether any push occurred.
    const bareDir = await addHangingBareRemote(repoDir, 2);
    tmpDirs.push(bareDir);
    execSync('git commit --allow-empty -m "pending change"', { cwd: repoDir, stdio: "ignore" });

    const gitService = makeRealPushGitService();
    const sessionDB = makeSessionDB(repoDir);

    const start = Date.now();
    let caught: unknown;
    try {
      await updateSessionImpl(
        // pushTimeoutMs (20ms) is far below the hook's 2s sleep, so the
        // timeout deterministically wins — proving boundedness, not
        // relying on scheduling luck.
        makeBaseParams(repoDir, { pushTimeoutMs: 20 }),
        { gitService, sessionDB, getCurrentSession: async () => undefined }
      );
    } catch (err) {
      caught = err;
    }
    // Wall-clock ELAPSED TIME for the boundedness assertion below, not
    // path/fixture uniqueness (the no-real-fs-in-tests rule's actual
    // target) — no race-condition risk.
    const elapsedMs = Date.now() - start; // eslint-disable-line custom/no-real-fs-in-tests

    // The whole call completed in well under a second — nowhere near the
    // ~1800s MCP-transport idle-timeout this task exists to avoid.
    expect(elapsedMs).toBeLessThan(5000);

    expect(caught).toBeInstanceOf(MinskyError);
    const message = (caught as MinskyError).message;
    expect(message).toContain("pushUnconfirmed");
    expect(message).toContain("Failed to push changes to remote during session update");
    // mt#3939 (AT2): this is the FIRST of the two pushes session_pr_create
    // runs, and it never produces the git-exec timeout template. mt#3939's
    // spec originally claimed the opposite — that a hang in this step surfaced
    // as "Git push operation timed out" — and the fix rested on that being
    // false. Pin it so a future change to this path cannot quietly make the
    // two failure surfaces indistinguishable again.
    expect(message).not.toContain("Git Operation Timeout");
    expect(message).not.toContain("Git push operation timed out");
  }, 15000);

  test("a normal (non-hanging) push completes successfully and the pending commit reaches the remote", async () => {
    const repoDir = await makeTmpGitRepo();
    tmpDirs.push(repoDir);
    const bareDir = addPlainBareRemote(repoDir);
    tmpDirs.push(bareDir);
    execSync('git commit --allow-empty -m "pending change reaches remote"', {
      cwd: repoDir,
      stdio: "ignore",
    });

    const gitService = makeRealPushGitService();
    const sessionDB = makeSessionDB(repoDir);

    const result = await updateSessionImpl(makeBaseParams(repoDir), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    expect(result).toBeDefined();
    // The commit really did land on the remote — not a fabricated success.
    const remoteLog = execSync("git log --oneline -1", { cwd: bareDir }).toString();
    expect(remoteLog).toContain("pending change reaches remote");
  });
});

describe("updateSessionImpl push-timeout confirmation via FakeGitService.setPushOutcomes (mt#3205)", () => {
  test("a scripted pushUnconfirmed outcome throws — the caller never treats it as success", async () => {
    const gitService = new FakeGitService({ defaultBranch: "task/mt-3205" });
    gitService.setPushOutcomes([{ pushed: false, pushUnconfirmed: true }]);
    const sessionDB = makeSessionDB("/mock/session/workdir");

    let caught: unknown;
    try {
      await updateSessionImpl(makeBaseParams("/mock/session/workdir"), {
        gitService,
        sessionDB,
        getCurrentSession: async () => undefined,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MinskyError);
    expect((caught as MinskyError).message).toContain("pushUnconfirmed");
    // The fake actually recorded a push attempt — this isn't a vacuous pass
    // from the call never reaching push().
    expect(gitService.pushedCalls).toHaveLength(1);
  });

  test("a scripted pushConfirmedVia:'remote-check' outcome (pushed:true) does not throw", async () => {
    const gitService = new FakeGitService({ defaultBranch: "task/mt-3205" });
    gitService.setPushOutcomes([
      { pushed: true, pushTimedOut: true, pushConfirmedVia: "remote-check" },
    ]);
    const sessionDB = makeSessionDB("/mock/session/workdir");

    const result = await updateSessionImpl(makeBaseParams("/mock/session/workdir"), {
      gitService,
      sessionDB,
      getCurrentSession: async () => undefined,
    });

    expect(result).toBeDefined();
    expect(gitService.pushedCalls).toHaveLength(1);
  });
});
