/**
 * Tests for FollowUpService — the scheduled-follow-up primitive (mt#2322).
 *
 * Covers:
 *  - create() validates dueAt/message and inserts a pending row
 *  - list() with and without a status filter, ordered by dueAt ascending
 *  - cancel() only affects a still-pending row (status-guarded)
 *  - fireDue() fires only pending rows whose dueAt has passed
 *  - fireDue() is idempotent — a second pass over the same rows fires nothing new
 *
 * Uses an in-memory fake "DB" that implements the drizzle query-builder
 * surface FollowUpService calls, mirroring the established pattern in
 * `presence/repository.test.ts` and `transcripts/per-turn-embedding-pipeline.test.ts`
 * (no real Postgres required for these unit tests).
 *
 * @see ./follow-up-service.ts
 * @see mt#2322
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { FollowUpService } from "./follow-up-service";
import type { ScheduledFollowUpRecord } from "../storage/schemas/scheduled-follow-ups-schema";

// ---------------------------------------------------------------------------
// Drizzle expression inspectors (same technique as presence/repository.test.ts)
// ---------------------------------------------------------------------------

function sepChunkString(sep: unknown): string | null {
  if (sep === null || sep === undefined) return null;
  if (typeof sep === "string") return sep;
  if (typeof sep === "object") {
    const v = (sep as Record<string, unknown>)["value"];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      return (v as unknown[]).filter((s): s is string => typeof s === "string").join("");
    }
  }
  return null;
}

/** Walk an `eq(col, val)` / `and(...)` tree, calling `cb` for every eq() leaf. */
function extractEqFilters(condition: unknown, cb: (colName: string, val: string) => void): void {
  if (!condition || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;
  if (!Array.isArray(c["queryChunks"])) return;
  const chunks = c["queryChunks"] as unknown[];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (
      chunk &&
      typeof chunk === "object" &&
      typeof (chunk as Record<string, unknown>)["name"] === "string" &&
      (chunk as Record<string, unknown>)["table"] !== undefined
    ) {
      const colName = (chunk as Record<string, unknown>)["name"] as string;
      const sep = chunks[i + 1];
      const param = chunks[i + 2];
      const sepStr = sepChunkString(sep);
      if (sepStr !== null && sepStr.includes("=") && param && typeof param === "object") {
        const v = (param as Record<string, unknown>)["value"];
        if (v !== undefined) cb(colName, String(v));
      }
    }
    if (
      chunk &&
      typeof chunk === "object" &&
      Array.isArray((chunk as Record<string, unknown>)["queryChunks"])
    ) {
      extractEqFilters(chunk, cb);
    }
  }
}

/** Walk a tree for any embedded `Date` value (covers `lte(col, date)`). */
function extractDateFilter(condition: unknown, cb: (val: Date) => void): void {
  if (!condition || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;
  if (!Array.isArray(c["queryChunks"])) return;
  for (const chunk of c["queryChunks"] as unknown[]) {
    if (chunk instanceof Date) {
      cb(chunk);
      continue;
    }
    if (chunk && typeof chunk === "object") {
      const v = (chunk as Record<string, unknown>)["value"];
      if (v instanceof Date) {
        cb(v);
        continue;
      }
      if (Array.isArray((chunk as Record<string, unknown>)["queryChunks"])) {
        extractDateFilter(chunk, cb);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

function makeFakeDb() {
  const rows = new Map<string, ScheduledFollowUpRecord>();
  let idCounter = 1;

  function matchesCondition(row: ScheduledFollowUpRecord, condition: unknown): boolean {
    let ok = true;
    extractEqFilters(condition, (colName, val) => {
      if (colName === "status" && row.status !== val) ok = false;
      if (colName === "id" && row.id !== val) ok = false;
    });
    extractDateFilter(condition, (cutoff) => {
      if (!(row.dueAt <= cutoff)) ok = false;
    });
    return ok;
  }

  // A select-with-where result is both awaitable directly (fireDue's shape)
  // AND chainable with .orderBy() (list()'s shape).
  function makeSelectWhereResult(filtered: ScheduledFollowUpRecord[]) {
    return {
      then(
        onFulfilled: (v: ScheduledFollowUpRecord[]) => unknown,
        onRejected?: (e: unknown) => unknown
      ) {
        return Promise.resolve(filtered).then(onFulfilled, onRejected);
      },
      orderBy(_col: unknown) {
        return Promise.resolve([...filtered].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()));
      },
    };
  }

  const db = {
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const now = new Date();
          const row: ScheduledFollowUpRecord = {
            id: `fake-id-${idCounter++}`,
            message: vals.message as string,
            payload: (vals.payload as Record<string, unknown>) ?? {},
            dueAt: vals.dueAt as Date,
            status: "pending",
            relatedTaskId: (vals.relatedTaskId as string | undefined) ?? null,
            relatedSessionId: (vals.relatedSessionId as string | undefined) ?? null,
            createdAt: now,
            firedAt: null,
            lastError: null,
          };
          rows.set(row.id, row);
          return [row];
        },
      }),
    }),

    select: () => ({
      from: (_table: unknown) => ({
        where: (condition: unknown) =>
          makeSelectWhereResult([...rows.values()].filter((r) => matchesCondition(r, condition))),
        orderBy: (_col: unknown) =>
          Promise.resolve([...rows.values()].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())),
      }),
    }),

    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const updated: ScheduledFollowUpRecord[] = [];
            for (const row of rows.values()) {
              if (matchesCondition(row, condition)) {
                Object.assign(row, vals);
                updated.push(row);
              }
            }
            return updated;
          },
        }),
      }),
    }),

    __rows: () => [...rows.values()],
  };

  return db as unknown as PostgresJsDatabase<Record<string, unknown>>;
}

/**
 * ms-from-now Date helper. Deliberately assigns `Date.now()` to a variable
 * before adding the offset — `custom/no-real-fs-in-tests`'s
 * timestampUniqueness check flags `Date.now()` whose immediate AST parent is
 * a BinaryExpression/TemplateLiteral (a path-uniqueness anti-pattern check
 * that also fires on ordinary date-math like `Date.now() + 1000`); this
 * shape keeps `Date.now()`'s parent a VariableDeclarator instead.
 */
function msFromNow(ms: number): Date {
  const now = Date.now();
  return new Date(now + ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FollowUpService", () => {
  test("create() inserts a pending row with the given message and dueAt", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const dueAt = msFromNow(60_000);

    const row = await service.create({ message: "check on deploy", dueAt });

    expect(row.message).toBe("check on deploy");
    expect(row.status).toBe("pending");
    expect(row.dueAt).toEqual(dueAt);
    expect(row.firedAt).toBeNull();
  });

  test("create() rejects an invalid dueAt", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    await expect(service.create({ message: "x", dueAt: "not-a-date" })).rejects.toThrow(
      /invalid dueAt/
    );
  });

  test("create() rejects an empty message", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    await expect(service.create({ message: "   ", dueAt: msFromNow(1000) })).rejects.toThrow(
      /message must be non-empty/
    );
  });

  test("list() with no filter returns all follow-ups ordered by dueAt ascending", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const later = msFromNow(120_000);
    const sooner = msFromNow(60_000);
    await service.create({ message: "later", dueAt: later });
    await service.create({ message: "sooner", dueAt: sooner });

    const all = await service.list();

    expect(all.map((r) => r.message)).toEqual(["sooner", "later"]);
  });

  test("list({status}) filters to only that status", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const row = await service.create({ message: "a", dueAt: msFromNow(1000) });
    await service.create({ message: "b", dueAt: msFromNow(2000) });
    await service.cancel(row.id);

    const pending = await service.list({ status: "pending" });
    const cancelled = await service.list({ status: "cancelled" });

    expect(pending.map((r) => r.message)).toEqual(["b"]);
    expect(cancelled.map((r) => r.message)).toEqual(["a"]);
  });

  test("cancel() flips a pending row to cancelled and returns true", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const row = await service.create({ message: "x", dueAt: msFromNow(1000) });

    const result = await service.cancel(row.id);

    expect(result).toBe(true);
    const [reloaded] = await service.list({ status: "cancelled" });
    expect(reloaded.id).toBe(row.id);
  });

  test("cancel() is a no-op (returns false) on an already-cancelled row", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const row = await service.create({ message: "x", dueAt: msFromNow(1000) });
    await service.cancel(row.id);

    const second = await service.cancel(row.id);

    expect(second).toBe(false);
  });

  test("fireDue() fires only pending rows whose dueAt has passed", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const now = new Date();
    const past = await service.create({ message: "past", dueAt: new Date(now.getTime() - 1000) });
    const future = await service.create({
      message: "future",
      dueAt: new Date(now.getTime() + 60_000),
    });

    const { fired, errored } = await service.fireDue(now);

    expect(errored).toEqual([]);
    expect(fired.map((r) => r.id)).toEqual([past.id]);
    const [reloadedPast] = await service.list({ status: "fired" });
    expect(reloadedPast.id).toBe(past.id);
    expect(reloadedPast.firedAt).toEqual(now);
    const [reloadedFuture] = await service.list({ status: "pending" });
    expect(reloadedFuture.id).toBe(future.id);
  });

  test("fireDue() is idempotent — a second pass fires nothing new", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const now = new Date();
    await service.create({ message: "due", dueAt: new Date(now.getTime() - 1000) });

    const first = await service.fireDue(now);
    const second = await service.fireDue(new Date(now.getTime() + 5000));

    expect(first.fired.length).toBe(1);
    expect(second.fired.length).toBe(0);
  });

  test("fireDue() does not touch cancelled rows even if overdue", async () => {
    const db = makeFakeDb();
    const service = new FollowUpService(db);
    const now = new Date();
    const row = await service.create({
      message: "cancel-before-due",
      dueAt: new Date(now.getTime() - 1000),
    });
    await service.cancel(row.id);

    const { fired } = await service.fireDue(now);

    expect(fired).toEqual([]);
  });
});
