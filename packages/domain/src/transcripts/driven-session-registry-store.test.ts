/**
 * Tests for driven-session-registry-store (mt#3038 — durable driven-session
 * persistence + cross-process resume lock).
 *
 * Uses an in-memory fake for the DB — no real Postgres access (mirrors
 * driven-session-cost-writer.test.ts's fake convention). Reads go through
 * `db.execute(sql...)`, so the fake only needs to implement `.execute()`,
 * `.insert().values().onConflictDoUpdate()`, and `.transaction()` — no
 * query-builder chain faking required (see the module's docblock for why raw
 * SQL was chosen for reads).
 *
 * @see ./driven-session-registry-store.ts
 * @see mt#3038
 */

import { describe, test, expect } from "bun:test";

import {
  upsertDrivenSessionRecord,
  getDrivenSessionRecord,
  listNonTerminalDrivenSessions,
  withDrivenSessionResumeLock,
  mapRawDrivenSessionRow,
  type UpsertDrivenSessionInput,
} from "./driven-session-registry-store";
import { drivenSessionsTable } from "../storage/schemas/driven-sessions-schema";

interface FakeRow {
  localId: string;
  harnessSessionId: string | null;
  cwd: string;
  permissionMode: string;
  taskId: string | null;
  minskySessionId: string | null;
  status: string;
  unrecoverableReason: string | null;
  pid: number | null;
  pidCmdline: string | null;
  actuatorGeneration: number;
  startedAt: Date;
  updatedAt: Date;
}

interface FakeStores {
  rows: FakeRow[];
  /** Queued raw execute() results, consumed one call at a time. */
  executeResults: unknown[];
  executeCalls: number;
  advisoryLockAcquired: boolean;
}

function makeStores(): FakeStores {
  return { rows: [], executeResults: [], executeCalls: 0, advisoryLockAcquired: true };
}

function toRawRow(row: FakeRow) {
  return {
    local_id: row.localId,
    harness_session_id: row.harnessSessionId,
    cwd: row.cwd,
    permission_mode: row.permissionMode,
    task_id: row.taskId,
    minsky_session_id: row.minskySessionId,
    status: row.status,
    unrecoverable_reason: row.unrecoverableReason,
    pid: row.pid,
    pid_cmdline: row.pidCmdline,
    actuator_generation: row.actuatorGeneration,
    started_at: row.startedAt,
    updated_at: row.updatedAt,
  };
}

/** Fake DB: routes insert/upsert by table identity (mirrors the cost-writer fake). */
function makeDb(
  stores: FakeStores,
  opts?: { throwOnInsert?: boolean; throwOnExecute?: boolean; queuedSelectRows?: FakeRow[] }
) {
  return {
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          return {
            onConflictDoUpdate(_conf: unknown): Promise<void> {
              if (table !== drivenSessionsTable) {
                return Promise.reject(new Error("insert against an unexpected table"));
              }
              if (opts?.throwOnInsert) {
                return Promise.reject(new Error("simulated insert error"));
              }
              const idx = stores.rows.findIndex((r) => r.localId === (v as FakeRow).localId);
              if (idx >= 0) stores.rows[idx] = v as FakeRow;
              else stores.rows.push(v as FakeRow);
              return Promise.resolve();
            },
          };
        },
      };
    },
    async execute(_query: unknown): Promise<unknown> {
      stores.executeCalls += 1;
      if (opts?.throwOnExecute) throw new Error("simulated execute error");
      const queued = opts?.queuedSelectRows;
      if (queued) return queued.map(toRawRow);
      return [];
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        execute: async (_q: unknown) => [{ acquired: stores.advisoryLockAcquired }],
      };
      return fn(tx);
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

const BYPASS_PERMISSIONS = "bypassPermissions";

const BASE_INPUT: UpsertDrivenSessionInput = {
  localId: "local-1",
  harnessSessionId: null,
  cwd: "/tmp/workdir",
  permissionMode: BYPASS_PERMISSIONS,
  taskId: "mt#3038",
  minskySessionId: "session-1",
  status: "spawned",
  startedAt: new Date("2026-07-22T18:00:00.000Z").toISOString(),
};

describe("upsertDrivenSessionRecord", () => {
  test("inserts a new row on first call", async () => {
    const stores = makeStores();
    const outcome = await upsertDrivenSessionRecord(asPg(makeDb(stores)), BASE_INPUT);
    expect(outcome).toBe("written");
    expect(stores.rows.length).toBe(1);
    expect(stores.rows[0]?.localId).toBe("local-1");
    expect(stores.rows[0]?.status).toBe("spawned");
  });

  test("upserts (same localId updates in place, not a second row)", async () => {
    const stores = makeStores();
    const db = asPg(makeDb(stores));
    await upsertDrivenSessionRecord(db, BASE_INPUT);
    await upsertDrivenSessionRecord(db, {
      ...BASE_INPUT,
      status: "running",
      harnessSessionId: "harness-abc",
    });
    expect(stores.rows.length).toBe(1);
    expect(stores.rows[0]?.status).toBe("running");
    expect(stores.rows[0]?.harnessSessionId).toBe("harness-abc");
  });

  test("returns 'error' (never throws) when the insert fails", async () => {
    const stores = makeStores();
    const outcome = await upsertDrivenSessionRecord(
      asPg(makeDb(stores, { throwOnInsert: true })),
      BASE_INPUT
    );
    expect(outcome).toBe("error");
    expect(stores.rows.length).toBe(0);
  });

  test("defaults actuatorGeneration to 0 when omitted", async () => {
    const stores = makeStores();
    await upsertDrivenSessionRecord(asPg(makeDb(stores)), BASE_INPUT);
    expect(stores.rows[0]?.actuatorGeneration).toBe(0);
  });
});

describe("mapRawDrivenSessionRow", () => {
  test("maps snake_case columns to the camelCase row shape", () => {
    const mapped = mapRawDrivenSessionRow({
      local_id: "local-1",
      harness_session_id: "harness-1",
      cwd: "/tmp/x",
      permission_mode: "default",
      task_id: "mt#3038",
      minsky_session_id: "sess-1",
      status: "reconnecting",
      unrecoverable_reason: null,
      pid: 1234,
      pid_cmdline: "claude -p ...",
      actuator_generation: 2,
      started_at: new Date("2026-07-22T18:00:00.000Z"),
      updated_at: new Date("2026-07-22T18:05:00.000Z"),
    });
    expect(mapped.localId).toBe("local-1");
    expect(mapped.harnessSessionId).toBe("harness-1");
    expect(mapped.status).toBe("reconnecting");
    expect(mapped.actuatorGeneration).toBe(2);
  });
});

describe("getDrivenSessionRecord", () => {
  test("returns null when no row matches", async () => {
    const stores = makeStores();
    const result = await getDrivenSessionRecord(asPg(makeDb(stores)), "missing-id");
    expect(result).toBeNull();
  });

  test("returns the mapped row when one exists", async () => {
    const stores = makeStores();
    const row: FakeRow = {
      localId: "local-1",
      harnessSessionId: "harness-1",
      cwd: "/tmp/x",
      permissionMode: BYPASS_PERMISSIONS,
      taskId: null,
      minskySessionId: null,
      status: "reconnecting",
      unrecoverableReason: null,
      pid: null,
      pidCmdline: null,
      actuatorGeneration: 1,
      startedAt: new Date("2026-07-22T18:00:00.000Z"),
      updatedAt: new Date("2026-07-22T18:00:00.000Z"),
    };
    const result = await getDrivenSessionRecord(
      asPg(makeDb(stores, { queuedSelectRows: [row] })),
      "local-1"
    );
    expect(result?.localId).toBe("local-1");
    expect(result?.status).toBe("reconnecting");
  });

  test("returns null (never throws) when the query fails", async () => {
    const stores = makeStores();
    const result = await getDrivenSessionRecord(
      asPg(makeDb(stores, { throwOnExecute: true })),
      "local-1"
    );
    expect(result).toBeNull();
  });
});

describe("listNonTerminalDrivenSessions", () => {
  test("returns an empty array when nothing is persisted", async () => {
    const stores = makeStores();
    const result = await listNonTerminalDrivenSessions(asPg(makeDb(stores)));
    expect(result).toEqual([]);
  });

  test("maps every returned row", async () => {
    const stores = makeStores();
    const rows: FakeRow[] = [
      {
        localId: "local-1",
        harnessSessionId: "harness-1",
        cwd: "/tmp/a",
        permissionMode: BYPASS_PERMISSIONS,
        taskId: "mt#1",
        minskySessionId: "sess-1",
        status: "reconnecting",
        unrecoverableReason: null,
        pid: null,
        pidCmdline: null,
        actuatorGeneration: 1,
        startedAt: new Date(),
        updatedAt: new Date(),
      },
      {
        localId: "local-2",
        harnessSessionId: null,
        cwd: "/tmp/b",
        permissionMode: "default",
        taskId: null,
        minskySessionId: null,
        status: "spawned",
        unrecoverableReason: null,
        pid: 42,
        pidCmdline: "claude -p",
        actuatorGeneration: 0,
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const result = await listNonTerminalDrivenSessions(
      asPg(makeDb(stores, { queuedSelectRows: rows }))
    );
    expect(result.length).toBe(2);
    expect(result.map((r) => r.localId)).toEqual(["local-1", "local-2"]);
  });

  test("returns an empty array (never throws) when the query fails", async () => {
    const stores = makeStores();
    const result = await listNonTerminalDrivenSessions(
      asPg(makeDb(stores, { throwOnExecute: true }))
    );
    expect(result).toEqual([]);
  });
});

describe("withDrivenSessionResumeLock", () => {
  test("invokes fn and returns its result when the lock is acquired", async () => {
    const stores = makeStores();
    stores.advisoryLockAcquired = true;
    let called = false;
    const outcome = await withDrivenSessionResumeLock(asPg(makeDb(stores)), "conv-1", async () => {
      called = true;
      return "resumed";
    });
    expect(called).toBe(true);
    expect(outcome).toEqual({ acquired: true, result: "resumed" });
  });

  test("does NOT invoke fn when the lock is already held by another process", async () => {
    const stores = makeStores();
    stores.advisoryLockAcquired = false;
    let called = false;
    const outcome = await withDrivenSessionResumeLock(asPg(makeDb(stores)), "conv-1", async () => {
      called = true;
      return "resumed";
    });
    expect(called).toBe(false);
    expect(outcome).toEqual({ acquired: false });
  });
});
