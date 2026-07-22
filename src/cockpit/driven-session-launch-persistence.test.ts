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

import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
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

const BASE_ROW: DrivenSessionRow = {
  localId: "local-1",
  harnessSessionId: "harness-1",
  cwd: "/tmp/workdir",
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
      cwd: "/tmp/x",
      spawnFn: () => new FakeClaudeProcess(),
    });

    observer(record);
    // Fire-and-forget — allow the microtask queue to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upsertCalls.length).toBe(1);
    const call = upsertCalls[0] as Record<string, unknown>;
    expect(call.localId).toBe(record.localId);
    expect(call.cwd).toBe("/tmp/x");
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
      cwd: "/tmp/x",
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
      cwd: "/tmp/x",
      spawnFn: () => new FakeClaudeProcess(),
      onStateChange: observer,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((upsertCalls[0] as Record<string, unknown>).model).toBeNull();
  });

  test("logs and no-ops (never throws) when persistence is unavailable", async () => {
    const observer = createDrivenSessionPersistObserver({ getDb: async () => null });
    const { record } = startDrivenSession({
      cwd: "/tmp/x",
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
      cwd: "/tmp/x",
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
