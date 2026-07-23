/* eslint-disable custom/no-real-fs-in-tests -- integration: real session workspace dirs are required to exercise the MERGE_HEAD/uncommitted-changes guard end-to-end through deleteSessionImpl/cleanupSessionImpl */
/**
 * Integration tests for mt#3021 SC2's acceptance tests: deleteSessionImpl
 * and cleanupSessionImpl refuse to touch a session workspace with an
 * in-progress merge or uncommitted changes, absent an explicit
 * destructiveOverrideReason — and do NOT permanently block a genuinely
 * abandoned session's recovery once the override is supplied.
 *
 * `getSessionsDir()` resolves via `XDG_STATE_HOME`, so these tests redirect
 * it to a temp dir for the duration of each test rather than touching the
 * real `~/.local/state/minsky/sessions`.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { deleteSessionImpl, cleanupSessionImpl } from "./session-lifecycle-operations";
import type { SessionRecord } from "./types";

const gitEnv = (cwd: string) => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: cwd,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: gitEnv(cwd) });
}

function makeSessionDB(sessions: SessionRecord[]) {
  const store = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    getSession: mock(async (id: string) => store.get(id) ?? null),
    getSessionByTaskId: mock(async () => null),
    listSessions: mock(async () => Array.from(store.values())),
    addSession: mock(async () => {}),
    updateSession: mock(async () => {}),
    deleteSession: mock(async (id: string) => {
      const existed = store.has(id);
      store.delete(id);
      return existed;
    }),
    getRepoPath: mock(async () => "/mock/repo"),
    getSessionWorkdir: mock(async (id: string) => `/mock/sessions/${id}`),
  };
}

const SESSION_ID = "mt3021-guard-session";
let xdgRoot: string;
let originalXdgStateHome: string | undefined;
let workspaceDir: string;
let sessionRecord: SessionRecord;

beforeEach(async () => {
  xdgRoot = await mkdtemp(join(tmpdir(), "mt3021-xdg-"));
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

  sessionRecord = {
    sessionId: SESSION_ID,
    repoUrl: "https://github.com/edobry/minsky.git",
    repoName: "minsky",
    taskId: "mt#3021",
    createdAt: new Date().toISOString(),
  };
});

afterEach(async () => {
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  await rm(xdgRoot, { recursive: true, force: true });
});

describe("deleteSessionImpl — mt#3021 SC2 acceptance tests", () => {
  it("AT1: refuses to delete a workspace with MERGE_HEAD present; the directory still exists afterward", async () => {
    await writeFile(join(workspaceDir, ".git", "MERGE_HEAD"), "deadbeef\n");
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl({ sessionId: SESSION_ID, force: true }, { sessionDB });

    expect(result.deleted).toBe(false);
    expect(result.error).toContain("MERGE_HEAD");
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(true);
    // DB record must also be preserved — the guard fires before any deletion.
    expect(await sessionDB.getSession(SESSION_ID)).not.toBeNull();
  });

  it("AT1 (uncommitted-changes variant): refuses to delete a workspace with uncommitted changes", async () => {
    await writeFile(join(workspaceDir, "a.txt"), "modified, not committed");
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl({ sessionId: SESSION_ID, force: true }, { sessionDB });

    expect(result.deleted).toBe(false);
    expect(result.error).toContain("uncommitted changes");
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("AT4: proceeds unchanged for a clean, non-merging workspace (no-over-fire)", async () => {
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl({ sessionId: SESSION_ID, force: false }, { sessionDB });

    expect(result.deleted).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("AT5 + AT6: an abandoned-session recovery (MERGE_HEAD present) completes via the override, and records a queryable audit event carrying the reason", async () => {
    await writeFile(join(workspaceDir, ".git", "MERGE_HEAD"), "deadbeef\n");
    const sessionDB = makeSessionDB([sessionRecord]);

    const insertValues = mock(() => Promise.resolve());
    const fakeDb = { insert: () => ({ values: insertValues }) } as any;
    const persistenceProvider = { getDatabaseConnection: async () => fakeDb } as any;

    const result = await deleteSessionImpl(
      {
        sessionId: SESSION_ID,
        force: false,
        destructiveOverrideReason: "session confirmed abandoned; recovering disk space",
      },
      { sessionDB, persistenceProvider }
    );

    expect(result.deleted).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(false);

    // AT6: queryable audit record carrying the reason.
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.eventType).toBe("guard.overridden");
    expect(insertedRow.payload).toMatchObject({
      guard: "session-delete-git-state",
      reason: "session confirmed abandoned; recovering disk space",
      reasonCode: "merge-head-present",
    });
  });

  it("a bare force:true (the pre-existing flag) does NOT satisfy the new guard on its own", async () => {
    await writeFile(join(workspaceDir, ".git", "MERGE_HEAD"), "deadbeef\n");
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await deleteSessionImpl({ sessionId: SESSION_ID, force: true }, { sessionDB });

    expect(result.deleted).toBe(false);
  });
});

describe("cleanupSessionImpl — mt#3021 SC2 acceptance tests", () => {
  it("refuses cleanup of a workspace with MERGE_HEAD present EVEN WITH force:true (the applyPostMergeStateSync shape)", async () => {
    await writeFile(join(workspaceDir, ".git", "MERGE_HEAD"), "deadbeef\n");
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: sessionRecord.taskId, force: true },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(false);
    expect(result.errors.some((e) => e.includes("MERGE_HEAD"))).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it("proceeds when overridden with a reason, even under force:true", async () => {
    await writeFile(join(workspaceDir, ".git", "MERGE_HEAD"), "deadbeef\n");
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await cleanupSessionImpl(
      {
        sessionId: SESSION_ID,
        taskId: sessionRecord.taskId,
        force: true,
        destructiveOverrideReason: "confirmed abandoned via presence check",
      },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("proceeds unchanged for a clean workspace (no-over-fire)", async () => {
    const sessionDB = makeSessionDB([sessionRecord]);

    const result = await cleanupSessionImpl(
      { sessionId: SESSION_ID, taskId: sessionRecord.taskId, force: false },
      { sessionDB }
    );

    expect(result.sessionDeleted).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
