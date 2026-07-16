import { describe, test, expect } from "bun:test";
import { listEvents, countEvents } from "./query";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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
