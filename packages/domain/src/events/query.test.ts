import { describe, test, expect } from "bun:test";
import { listEvents, countEvents, buildConditions } from "./query";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import { and } from "drizzle-orm";

/**
 * Self-returning fluent-chain fake for the subset of the Drizzle query
 * builder `listEvents`/`countEvents` use: `.select().from().orderBy().limit()`
 * (listEvents) and `.select({value: count()}).from()` (countEvents), with
 * `.where()` called conditionally in both. Every chain method returns the
 * same object; `then` resolves to the configured rows so `await query` works
 * regardless of where the caller stops chaining.
 */
function makeFakeDb(rows: unknown[]): PostgresJsDatabase {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return { select: () => chain } as unknown as PostgresJsDatabase;
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    eventType: "task.status_changed",
    payload: {},
    actor: null,
    relatedTaskId: null,
    relatedSessionId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("countEvents (mt#2817)", () => {
  test("returns the count from the aggregate row", async () => {
    const db = makeFakeDb([{ value: 42 }]);
    const total = await countEvents(db, {});
    expect(total).toBe(42);
  });

  test("returns 0 when no aggregate row is returned", async () => {
    const db = makeFakeDb([]);
    const total = await countEvents(db, {});
    expect(total).toBe(0);
  });

  test("is not capped by any limit — reflects the true matching count", async () => {
    // countEvents intentionally has no `limit` in its options type; a large
    // count value proves the function doesn't clamp it the way listEvents
    // clamps to 500.
    const db = makeFakeDb([{ value: 12345 }]);
    const total = await countEvents(db, { eventType: "task.status_changed" });
    expect(total).toBe(12345);
  });
});

describe("listEvents + countEvents together (mt#2817 loud-cap invariant)", () => {
  test("a page smaller than total signals truncation via the pair of calls", async () => {
    const pageRows = [makeEventRow({ id: "a" }), makeEventRow({ id: "b" })];
    const listDb = makeFakeDb(pageRows);
    const countDb = makeFakeDb([{ value: 10 }]);

    const events = await listEvents(listDb, { limit: 2 });
    const total = await countEvents(countDb, {});

    expect(events).toHaveLength(2);
    expect(total).toBe(10);
    // This is the invariant the events.list adapter command relies on:
    // returned < total => truncated: true.
    expect(events.length < total).toBe(true);
  });

  test("a page equal to total signals no truncation", async () => {
    const rows = [makeEventRow({ id: "a" }), makeEventRow({ id: "b" })];
    const listDb = makeFakeDb(rows);
    const countDb = makeFakeDb([{ value: 2 }]);

    const events = await listEvents(listDb, { limit: 50 });
    const total = await countEvents(countDb, {});

    expect(events.length).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// Project scope (mt#4746) — documented partial-filter semantics
// ---------------------------------------------------------------------------

describe("buildConditions — project scope (mt#4746)", () => {
  const pgDialect = new PgDialect();
  const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  test("no projectScope adds no condition", () => {
    expect(buildConditions({})).toHaveLength(0);
  });

  test("projectScope adds exactly one EXISTS-subquery condition against tasks", () => {
    const conditions = buildConditions({ projectScope: PROJECT_A_ID });
    expect(conditions).toHaveLength(1);

    const { sql: rendered, params } = pgDialect.sqlToQuery(conditions[0] as never);
    expect(rendered).toContain("EXISTS");
    expect(rendered.toLowerCase()).toContain("tasks");
    expect(params).toContain(PROJECT_A_ID);
  });

  test("projectScope combines with other filters via AND (both conditions present)", () => {
    const conditions = buildConditions({
      projectScope: PROJECT_A_ID,
      relatedTaskId: "mt#1",
    });
    // relatedTaskId contributes 2 conditions (isNotNull + eq); projectScope contributes 1.
    expect(conditions).toHaveLength(3);
    const combined = and(...conditions);
    const { sql: rendered, params } = pgDialect.sqlToQuery(combined as never);
    expect(rendered).toContain("EXISTS");
    expect(params).toContain(PROJECT_A_ID);
    expect(params).toContain("mt#1");
  });
});

describe("listEvents — project scope wiring (mt#4746, two-project fixture)", () => {
  /** Same fake-chain shape as makeFakeDb, but captures the where() argument. */
  function makeCapturingDb(rows: unknown[]): {
    db: PostgresJsDatabase;
    getLastWhereArg: () => unknown;
  } {
    let lastWhereArg: unknown;
    const chain = {
      from: () => chain,
      where: (arg: unknown) => {
        lastWhereArg = arg;
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return {
      db: { select: () => chain } as unknown as PostgresJsDatabase,
      getLastWhereArg: () => lastWhereArg,
    };
  }

  const pgDialect = new PgDialect();
  const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  test("no projectScope: .where() is never called (unscoped, full read)", async () => {
    const { db, getLastWhereArg } = makeCapturingDb([makeEventRow()]);
    await listEvents(db, {});
    expect(getLastWhereArg()).toBeUndefined();
  });

  test("projectScope: .where() receives a condition carrying the resolved project uuid", async () => {
    const { db, getLastWhereArg } = makeCapturingDb([
      makeEventRow({ id: "a", relatedTaskId: "mt#1" }),
    ]);
    await listEvents(db, { projectScope: PROJECT_A_ID });

    const whereArg = getLastWhereArg();
    expect(whereArg).toBeDefined();
    const { sql: rendered, params } = pgDialect.sqlToQuery(whereArg as never);
    expect(rendered).toContain("EXISTS");
    expect(params).toContain(PROJECT_A_ID);
  });
});
