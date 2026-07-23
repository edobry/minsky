/* eslint-disable custom/no-real-fs-in-tests -- integration: a real session workspace dir is required to exercise the git-state guard's terminal-state bypass end-to-end through applyPostMergeStateSync/cleanupSessionImpl */
/**
 * Regression tests for the mt#3021 SC2 terminal-state bypass (reviewer R1
 * finding, 2026-07-23): `cleanupSessionImpl`'s MERGE_HEAD/uncommitted-changes
 * guard was unconditional, and `applyPostMergeStateSync` calls
 * `cleanupSessionImpl` with `force: true` and no override reason on EVERY
 * merge — so a workspace with any modified tracked file or untracked
 * non-ignored file would silently fail post-merge cleanup forever (an
 * under-deletion regression, the opposite failure mode from the incident
 * this task closes).
 *
 * Fix: a session whose OWN status is already MERGED or CLOSED skips the
 * git-state check entirely (mirrors the identical skip in
 * `identifyCleanupCandidates`, session-cleanup.ts).
 *
 * `getSessionsDir()` resolves via `XDG_STATE_HOME`, so these tests redirect
 * it to a temp dir for the duration of each test.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { applyPostMergeStateSync } from "./session-merge-status-sync";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeTaskService } from "../tasks/fake-task-service";
import { SessionStatus } from "./types";
import type { SessionRecord } from "./types";
import { TASK_STATUS } from "../tasks/taskConstants";

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

const SESSION_ID = "mt3021-terminal-bypass-session";
const TASK_ID = "mt#3021";
let xdgRoot: string;
let originalXdgStateHome: string | undefined;
let workspaceDir: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), "mt3021-terminal-bypass-xdg-"));
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = xdgRoot;

  workspaceDir = join(xdgRoot, "minsky", "sessions", SESSION_ID);
  await mkdir(workspaceDir, { recursive: true });
  git(workspaceDir, "init", "-b", "main");
  git(workspaceDir, "config", "user.email", "test@test.com");
  git(workspaceDir, "config", "user.name", "Test");
  git(workspaceDir, "config", "commit.gpgsign", "false");
  await writeFile(join(workspaceDir, "a.txt"), "a");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "-m", "initial");

  // The dirty-tree condition that trips the underlying git-state guard:
  // an untracked, non-ignored file. `hasUncommittedChangesImpl` runs a bare
  // `git status --porcelain` (no `-uno`), so this counts.
  await writeFile(join(workspaceDir, "untracked-build-artifact.txt"), "leftover");
});

afterEach(async () => {
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  await rm(xdgRoot, { recursive: true, force: true });
});

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    repoName: "owner/repo",
    repoUrl: "https://github.com/owner/repo",
    createdAt: "2026-05-01T09:00:00.000Z",
    taskId: TASK_ID,
    status: SessionStatus.PR_OPEN,
    lastActivityAt: "2026-05-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("applyPostMergeStateSync — terminal-state bypass regression (mt#3021 R1)", () => {
  it("completes post-merge cleanup and removes a DIRTY workspace once the session is MERGED", async () => {
    const sessionRecord = makeSessionRecord({ status: SessionStatus.PR_OPEN });
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });
    const taskService = new FakeTaskService({
      initialTasks: [{ id: TASK_ID, title: "test", status: TASK_STATUS.IN_REVIEW }],
    });

    const result = await applyPostMergeStateSync(
      {
        sessionId: SESSION_ID,
        mergeSha: "deadbeef",
        mergedAt: "2026-07-23T00:00:00.000Z",
        cleanupSession: true,
        trigger: "session_pr_merge",
      },
      { sessionDB, taskService }
    );

    // Effect (b): session transitioned to MERGED before cleanup ran (the
    // terminal-state bypass reads this via its own getSession re-fetch
    // inside cleanupSessionImpl, AFTER this write — see the doc comment on
    // deleteSessionImpl's isTerminalSession check). Cleanup's own step 5
    // deletes the DB record on success, so we can't re-read status
    // afterward — sessionStatusUpdated:true plus the cleanup succeeding is
    // the evidence the bypass saw MERGED, not a lingering pre-merge status.
    expect(result.sessionStatusUpdated).toBe(true);

    // The regression: this must NOT be blocked by the dirty workspace.
    expect(result.sessionCleanup?.performed).toBe(true);
    expect(result.sessionCleanup?.errors).toEqual([]);
    expect(result.sessionCleanup?.directoriesRemoved.length).toBeGreaterThan(0);

    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(false);
  });
});

describe("cleanupSessionImpl — terminal-state bypass does not reopen the guard's hole (mt#3021 R1)", () => {
  it("still refuses a DIRTY workspace for a NON-terminal session, even under force:true", async () => {
    const sessionRecord = makeSessionRecord({ status: SessionStatus.ACTIVE });
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID, force: true },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("proceeds for a CLOSED session with a dirty workspace (bypass also covers CLOSED, not just MERGED)", async () => {
    const sessionRecord = makeSessionRecord({ status: SessionStatus.CLOSED });
    const sessionDB = new FakeSessionProvider({ initialSessions: [sessionRecord] });

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: TASK_ID, force: true },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(true);
    expect(result.errors).toEqual([]);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(false);
  });
});
