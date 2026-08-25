/* eslint-disable custom/no-real-fs-in-tests -- integration: a real workspace dir under a temp XDG root is required to assert the guarded delete removes it (the filesystem-orphan defect mt#3106 SC2 eliminates) */
/**
 * mt#3106 AT2 (integration): `session_start --recover` against a genuinely
 * not-live stale session succeeds AND removes the workspace directory — the
 * silent filesystem orphan the raw `sessionDB.deleteSession` used to leave is
 * gone, because the branch now routes through `deleteSessionImpl` (which
 * rmSyncs the workspace before deleting the DB record).
 *
 * Uses the same XDG_STATE_HOME redirection pattern as
 * session-lifecycle-destructive-guard.test.ts so `getSessionsDir()` resolves
 * into a temp root: the abandoned session gets a REAL git workspace with a
 * clean tree (so the mt#3021 git-state guard legitimately passes), and the
 * assertion is that the directory is GONE afterward.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../schemas";
import type { SessionRecord } from "../session";
import { SessionStatus } from "./types";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeWorkspaceUtils } from "../workspace/fake-workspace-utils";

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

const ABANDONED_SESSION_ID = "mt3106-abandoned-with-workspace";
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

let xdgRoot: string;
let originalXdgStateHome: string | undefined;
let workspaceDir: string;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), "mt3106-xdg-"));
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = xdgRoot;

  // A REAL workspace for the abandoned session, with a clean tree so the
  // git-state guard passes and the liveness gate is the deciding check.
  workspaceDir = join(xdgRoot, "minsky", "sessions", ABANDONED_SESSION_ID);
  await mkdir(workspaceDir, { recursive: true });
  git(workspaceDir, "init", "-b", "main");
  git(workspaceDir, "config", "user.email", "test@test.com");
  git(workspaceDir, "config", "user.name", "Test");
  git(workspaceDir, "config", "commit.gpgsign", "false");
  await writeFile(join(workspaceDir, "a.txt"), "a");
  git(workspaceDir, "add", ".");
  git(workspaceDir, "commit", "-m", "initial");
});

afterEach(async () => {
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  await rm(xdgRoot, { recursive: true, force: true });
});

function buildAbandonedSession(): SessionRecord {
  return {
    sessionId: ABANDONED_SESSION_ID,
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: new Date(Date.now() - THREE_HOURS_MS).toISOString(),
    taskId: "md#999",
    status: SessionStatus.CREATED,
    lastActivityAt: undefined,
    projectId: undefined,
  };
}

function createDeps(sessionDB: FakeSessionProvider): StartSessionDependencies {
  const gitService = new FakeGitService();
  gitService.clone = mock(async () => ({ workdir: "/tmp/work", session: "test-uuid-session" }));
  gitService.branchWithoutSession = mock(async () => ({
    workdir: "/tmp/work",
    branch: "task/md-999",
  }));
  // Remote probe: branch absent (case b — clear the record and start over).
  (gitService as { execInRepository: unknown }).execInRepository = mock(async () => "");

  const taskService = new FakeTaskService();
  taskService.getTaskStatus = mock(async () => "READY");
  taskService.setTaskStatus = mock(async () => ({ recordsAffected: 1 }));
  taskService.getTask = mock(async () => ({ id: "md#999" })) as never;

  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils: new FakeWorkspaceUtils(),
    getRepositoryBackend: mock(async () => ({
      repoUrl: "https://github.com/owner/repo.git",
      backendType: "github",
    })),
    resolveActor: async () => ({
      verdict: "not-live" as const,
      reason: "actor gone (pid 1, dead) last refreshed at 2026-07-01T00:00:00.000Z",
    }),
  } as unknown as StartSessionDependencies;
}

describe("startSessionImpl --recover — guarded delete removes the workspace (mt#3106 AT2)", () => {
  it("recovery of a genuinely not-live stale session succeeds and leaves NO filesystem orphan", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(true);

    const sessionDB = new FakeSessionProvider({ initialSessions: [buildAbandonedSession()] });
    const deps = createDeps(sessionDB);
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    const result = await startSessionImpl(params, deps);

    // The recovery produced a NEW session and cleared the old record.
    expect(result.sessionId).not.toBe(ABANDONED_SESSION_ID);
    expect(await sessionDB.getSession(ABANDONED_SESSION_ID)).toBeNull();

    // SC2: the old workspace directory is REMOVED along with the DB record —
    // the raw-delete path left it behind as a silent orphan.
    expect(existsSync(workspaceDir)).toBe(false);
  });
});
