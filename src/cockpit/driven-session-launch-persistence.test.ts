/**
 * Tests for the durable driven-session persistence additions to
 * driven-session-launch.ts (mt#3038, RFC "Conversation-first drive" Phase
 * 1): createDrivenSessionPersistObserver, loadPersistedDrivenSessions,
 * orchestrateDrivenSessionResume.
 *
 * CRITICAL TESTING CONSTRAINT (inherited from ./driven-session-host.ts's
 * docblock): resume orchestration tests inject a fake `spawnFn` — no test
 * spawns the real `claude` binary.
 *
 * @see ./driven-session-launch.ts
 * @see mt#3038
 */

/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: the boot classifier and resume orchestration probe the REAL filesystem to decide whether a workspace still exists, so a row's cwd fixture has to be a real directory — there is no fs to inject through the code path under test. A per-run mkdtemp dir keeps the "fixed mock path" race the rule guards against from applying. */
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";

import {
  createDrivenSessionPersistObserver,
  loadPersistedDrivenSessions,
  orchestrateDrivenSessionResume,
} from "./driven-session-launch";
import { DrivenSessionRegistry, startDrivenSession, type ProcessLike } from "./driven-session-host";
import type { DrivenSessionRow } from "@minsky/domain/storage/schemas/driven-sessions-schema";

// ---------------------------------------------------------------------------
// Fake process double (mirrors driven-session-host.test.ts's FakeClaudeProcess)
// ---------------------------------------------------------------------------

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 999999;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
}

const FAKE_DB = {
  __marker: "fake-db",
} as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;

// mt#3397 — a resumable row's cwd must be a REAL directory: the boot classifier
// and the resume orchestration both probe it, and a made-up path now (correctly)
// classifies the row unrecoverable. MISSING_CWD is the never-created sibling
// used by the tests that assert that classification.
const TEST_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "driven-session-launch-"));
const MISSING_CWD = join(TEST_WORKSPACE_ROOT, "deleted-workspace");

const BASE_ROW: DrivenSessionRow = {
  localId: "local-1",
  harnessSessionId: "harness-1",
  cwd: TEST_WORKSPACE_ROOT,
  permissionMode: "bypassPermissions",
  taskId: "mt#3038",
  minskySessionId: "session-1",
  status: "reconnecting",
  unrecoverableReason: null,
  pid: null,
  pidCmdline: null,
  model: null,
  actuatorGeneration: 0,
  startedAt: new Date("2026-07-22T18:00:00.000Z"),
  updatedAt: new Date("2026-07-22T18:05:00.000Z"),
};

describe("createDrivenSessionPersistObserver", () => {
  test("upserts a row mapping every field from the in-memory record", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });

    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });

    observer(record);
    // Fire-and-forget — allow the microtask queue to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertCalls.length).toBe(1);
    const call = upsertCalls[0] as Record<string, unknown>;
    expect(call.localId).toBe(record.localId);
    expect(call.cwd).toBe(TEST_WORKSPACE_ROOT);
    expect(call.status).toBe("spawned");
    expect(call.pidCmdline).toContain("claude");
  });

  // mt#3040 preservation (interaction fix) — the model isn't a separate
  // DrivenSessionRecord field; it's recovered from argv for persistence.
  test("extracts model from argv (mt#3040) for the persisted row", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });
    startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      model: "fable",
      spawnFn: () => new FakeClaudeProcess(),
      onStateChange: observer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upsertCalls.length).toBe(1);
    expect((upsertCalls[0] as Record<string, unknown>).model).toBe("fable");
  });

  test("persists a null model when none was selected", async () => {
    const upsertCalls: unknown[] = [];
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async (_db, input) => {
        upsertCalls.push(input);
        return "written";
      },
    });
    startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
      onStateChange: observer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((upsertCalls[0] as Record<string, unknown>).model).toBeNull();
  });

  test("logs and no-ops (never throws) when persistence is unavailable", async () => {
    const observer = createDrivenSessionPersistObserver({ getDb: async () => null });
    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(() => observer(record)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("swallows an upsert failure without throwing", async () => {
    const observer = createDrivenSessionPersistObserver({
      getDb: async () => FAKE_DB,
      upsert: async () => {
        throw new Error("simulated write failure");
      },
    });
    const { record } = startDrivenSession({
      cwd: TEST_WORKSPACE_ROOT,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(() => observer(record)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("loadPersistedDrivenSessions", () => {
  test("registers a resumable row as 'reconnecting'", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [BASE_ROW],
      registry,
    });
    expect(count).toBe(1);
    const record = registry.get("local-1");
    expect(record?.status).toBe("reconnecting");
    expect(record?.harnessSessionId).toBe("harness-1");
  });

  test("registers a never-linked row as 'unrecoverable'", async () => {
    const registry = new DrivenSessionRegistry();
    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
    });
    const record = registry.get("local-1");
    expect(record?.status).toBe("unrecoverable");
    expect(record?.unrecoverableReason).toContain("spawn-died-before-init");
  });

  test("returns 0 without throwing when persistence is unavailable", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({ getDb: async () => null, registry });
    expect(count).toBe(0);
  });

  test("returns 0 without throwing when the query fails", async () => {
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => {
        throw new Error("simulated query failure");
      },
      registry,
    });
    expect(count).toBe(0);
  });

  // mt#3269: the verdict above was computed in memory and thrown away, so a row
  // that can NEVER be resumed was re-classified from scratch at every boot and
  // re-registered forever. Persisting it is what makes the next boot skip it.
  test("PERSISTS the unrecoverable verdict so the next boot does not re-read the row", async () => {
    const registry = new DrivenSessionRegistry();
    const persisted: { localId: string; status: string; reason: string | null }[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push({
          localId: input.localId,
          status: input.status,
          reason: input.unrecoverableReason ?? null,
        });
        return "written";
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("unrecoverable");
    expect(persisted[0]?.reason).toContain("spawn-died-before-init");
  });

  // PR #2383 R1 (BLOCKING): the store upserts with `onConflictDoUpdate({ set: values })`,
  // so any field this write defaults instead of carrying through OVERWRITES the
  // stored one. The first draft passed `model: null` and silently destroyed it.
  test("preserves every other persisted field — it records a verdict, not a rewrite", async () => {
    const registry = new DrivenSessionRegistry();
    const row = {
      ...BASE_ROW,
      harnessSessionId: null,
      model: "fable",
      pid: 4242,
      pidCmdline: "claude -p --input-format stream-json",
      actuatorGeneration: 3,
    };
    const writes: Record<string, unknown>[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [row],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        writes.push(input as unknown as Record<string, unknown>);
        return "written";
      },
    });

    const written = writes[0];
    if (!written) throw new Error("expected exactly one verdict write");
    expect(written["model"]).toBe("fable");
    expect(written["pid"]).toBe(4242);
    expect(written["pidCmdline"]).toBe("claude -p --input-format stream-json");
    expect(written["actuatorGeneration"]).toBe(3);
    expect(written["cwd"]).toBe(row.cwd);
    // ...while the two fields the write exists to change did change.
    expect(written["status"]).toBe("unrecoverable");
  });

  test("does NOT persist a verdict for a resumable row — it stays available to resume", async () => {
    // The deliberate carve-out (spec §Scope): deciding when a RESUMABLE row is
    // too stale to keep offering is a policy question this task does not answer.
    const registry = new DrivenSessionRegistry();
    const persisted: string[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [BASE_ROW],
      registry,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push(input.localId);
        return "written";
      },
    });

    expect(persisted).toHaveLength(0);
    expect(registry.get("local-1")?.status).toBe("reconnecting");
  });

  test("is idempotent across boots: the second boot reads nothing for a persisted row", async () => {
    // Simulates the real database: the query excludes terminal statuses, so once
    // the verdict is written the row drops out of the next boot's result set.
    const rows = [{ ...BASE_ROW, harnessSessionId: null }];
    const terminal = new Set<string>();

    const boot = () =>
      loadPersistedDrivenSessions({
        getDb: async () => FAKE_DB,
        listNonTerminal: async () => rows.filter((r) => !terminal.has(r.localId)),
        registry: new DrivenSessionRegistry(),
        persistTerminalVerdict: async (_db, input) => {
          terminal.add(input.localId);
          return "written";
        },
      });

    expect(await boot()).toBe(1);
    expect(await boot()).toBe(0);
  });

  test("a failed verdict-persist does not break boot", async () => {
    // Boot reconciliation is best-effort by construction — a persistence hiccup
    // must not stop the daemon from registering what it did read.
    const registry = new DrivenSessionRegistry();
    const count = await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [{ ...BASE_ROW, harnessSessionId: null }],
      registry,
      persistTerminalVerdict: async () => {
        throw new Error("simulated upsert failure");
      },
    });

    expect(count).toBe(1);
    expect(registry.get("local-1")?.status).toBe("unrecoverable");
  });
});

describe("orchestrateDrivenSessionResume", () => {
  test("returns not-found when persistence is unavailable", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", { getDb: async () => null });
    expect(outcome).toEqual({ outcome: "not-found" });
  });

  test("returns not-found when no persisted row exists", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => null,
    });
    expect(outcome).toEqual({ outcome: "not-found" });
  });

  test("returns unrecoverable when the row never linked a harness session id", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, harnessSessionId: null }),
    });
    expect(outcome.outcome).toBe("unrecoverable");
  });

  test("returns unrecoverable when the row is already marked unrecoverable", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({
        ...BASE_ROW,
        status: "unrecoverable",
        unrecoverableReason: "deleted cwd",
      }),
    });
    expect(outcome).toEqual({ outcome: "unrecoverable", reason: "deleted cwd" });
  });

  test("returns locked when another process already holds the resume lock", async () => {
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async () => ({ acquired: false }),
    });
    expect(outcome).toEqual({ outcome: "locked" });
  });

  test("resumes and returns the new record when the lock is acquired", async () => {
    const registry = new DrivenSessionRegistry();
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
    });
    expect(outcome.outcome).toBe("resumed");
    if (outcome.outcome === "resumed") {
      expect(outcome.record.localId).toBe("local-1");
      expect(outcome.record.harnessSessionId).toBe("harness-1");
      expect(outcome.record.actuatorGeneration).toBe(1);
      expect(registry.get("local-1")).toBe(outcome.record);
    }
  });

  // Reviewer round 1 (PR #2179) BLOCKING finding — R1 delta #4's orphan-PID
  // cleanup was implemented (process-identity.ts) but never WIRED into the
  // resume path. Fixed: orchestrateDrivenSessionResume calls it, inside the
  // lock, before resumeDrivenSession.
  test("calls the orphan-cleanup kill for the persisted pid before resuming", async () => {
    const registry = new DrivenSessionRegistry();
    const killCalls: unknown[] = [];
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: 42424 }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async (pid, expectedCmdSubstring, signal) => {
        killCalls.push({ pid, expectedCmdSubstring, signal });
        return true;
      },
    });
    expect(outcome.outcome).toBe("resumed");
    expect(killCalls).toEqual([{ pid: 42424, expectedCmdSubstring: "claude", signal: "SIGKILL" }]);
  });

  // Reviewer round 2 (PR #2179) non-blocking — prefer the persisted full
  // command line (a stricter identity check) over the bare binary name.
  test("prefers the persisted pidCmdline over the bare binary name for identity", async () => {
    const registry = new DrivenSessionRegistry();
    const killCalls: unknown[] = [];
    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({
        ...BASE_ROW,
        pid: 42424,
        pidCmdline: "claude -p --resume harness-1 --dangerously-skip-permissions",
      }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async (pid, expectedCmdSubstring, signal) => {
        killCalls.push({ pid, expectedCmdSubstring, signal });
        return true;
      },
    });
    expect(killCalls).toEqual([
      {
        pid: 42424,
        expectedCmdSubstring: "claude -p --resume harness-1 --dangerously-skip-permissions",
        signal: "SIGKILL",
      },
    ]);
  });

  test("skips the orphan-cleanup kill when no pid was persisted", async () => {
    const registry = new DrivenSessionRegistry();
    let killCalled = false;
    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: null }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async () => {
        killCalled = true;
        return true;
      },
    });
    expect(killCalled).toBe(false);
  });

  test("proceeds with the resume even when the orphan-cleanup kill attempt throws", async () => {
    const registry = new DrivenSessionRegistry();
    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => ({ ...BASE_ROW, pid: 42424 }),
      withResumeLock: async (_db, _conversationId, fn) => ({ acquired: true, result: await fn() }),
      registry,
      spawnFn: () => new FakeClaudeProcess(),
      killOrphan: async () => {
        throw new Error("simulated ps failure");
      },
    });
    expect(outcome.outcome).toBe("resumed");
  });
});

// ---------------------------------------------------------------------------
// Deleted-workspace classification (mt#3397)
// ---------------------------------------------------------------------------

describe("deleted workspace cwd (mt#3397)", () => {
  const DELETED_ROW = { ...BASE_ROW, cwd: MISSING_CWD };

  // Acceptance test 3.
  test("boot reconciliation classifies a linked row with a deleted cwd as unrecoverable", async () => {
    const registry = new DrivenSessionRegistry();

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      // harnessSessionId is NON-null — under the pre-mt#3397 classifier this row
      // was "reconnecting", and every resume of it crashed.
      listNonTerminal: async () => [DELETED_ROW],
      registry,
      persistTerminalVerdict: async () => "written",
    });

    const record = registry.get("local-1");
    expect(record?.status).toBe("unrecoverable");
    expect(record?.unrecoverableReason).toContain(MISSING_CWD);
    expect(record?.unrecoverableReason).toContain("deleted cwd");
  });

  // Acceptance test 2.
  test("boot reconciliation PERSISTS the deleted-cwd verdict so it is not re-derived forever", async () => {
    const persisted: { status: string; reason: string | null }[] = [];

    await loadPersistedDrivenSessions({
      getDb: async () => FAKE_DB,
      listNonTerminal: async () => [DELETED_ROW],
      registry: new DrivenSessionRegistry(),
      persistTerminalVerdict: async (_db, input) => {
        persisted.push({
          status: input.status,
          reason: input.unrecoverableReason ?? null,
        });
        return "written";
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("unrecoverable");
    expect(persisted[0]?.reason).toContain(MISSING_CWD);
  });

  test("orchestrateDrivenSessionResume refuses the resume and never spawns", async () => {
    const spawns: string[] = [];

    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => DELETED_ROW,
      persistTerminalVerdict: async () => "written",
      spawnFn: (command) => {
        spawns.push(command);
        return new FakeClaudeProcess();
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(outcome.outcome).toBe("unrecoverable");
    expect(outcome.outcome === "unrecoverable" && outcome.reason).toContain(MISSING_CWD);
    expect(spawns).toHaveLength(0);
  });

  test("orchestrateDrivenSessionResume writes the verdict back, and never takes the resume lock", async () => {
    const persisted: string[] = [];
    let lockTaken = false;

    await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => DELETED_ROW,
      persistTerminalVerdict: async (_db, input) => {
        persisted.push(input.unrecoverableReason ?? "");
        return "written";
      },
      // Refusing BEFORE the lock is the point: a session that cannot come back
      // must not serialize other daemons behind a lock to find that out.
      withResumeLock: async () => {
        lockTaken = true;
        return { acquired: false };
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(lockTaken).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain(MISSING_CWD);
  });

  test("a row whose cwd still exists is unaffected — it resumes as before", async () => {
    const spawns: string[] = [];

    const outcome = await orchestrateDrivenSessionResume("local-1", {
      getDb: async () => FAKE_DB,
      getPersisted: async () => BASE_ROW,
      withResumeLock: async (_db, _key, fn) => ({ acquired: true, result: await fn() }),
      spawnFn: (command) => {
        spawns.push(command);
        return new FakeClaudeProcess();
      },
      registry: new DrivenSessionRegistry(),
    });

    expect(outcome.outcome).toBe("resumed");
    expect(spawns).toHaveLength(1);
  });
});
