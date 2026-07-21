/**
 * Unit tests for `backfill-session-short-ids.ts` (mt#2967).
 *
 * Two layers:
 *   - `planBackfillAssignments`'s pure planning logic — no DB, no I/O —
 *     mirrors `scripts/backfill-memory-short-ids.test.ts` (mt#2966): sequential
 *     `ws#N` assignment ordered by createdAt ascending, idempotent skip of
 *     already-assigned rows, continuing the sequence after the highest
 *     already-assigned number.
 *   - `tryAcquireBackfillLock` / `releaseBackfillLock` — the advisory-lock
 *     concurrency guard — exercised against a fake `db.execute` so the
 *     acquire/already-held/release contract is pinned without a real
 *     Postgres connection.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  planBackfillAssignments,
  tryAcquireBackfillLock,
  releaseBackfillLock,
  BACKFILL_ADVISORY_LOCK_KEY,
  type BackfillCandidateRow,
} from "./backfill-session-short-ids";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

function row(
  sessionId: string,
  createdAt: string,
  shortId: string | null = null
): BackfillCandidateRow {
  return { sessionId, shortId, createdAt };
}

describe("planBackfillAssignments (mt#2967)", () => {
  it("assigns ws#1, ws#2, ... in createdAt-ascending order", () => {
    const rows = [
      row("uuid-c", "2026-01-03T00:00:00.000Z"),
      row("uuid-a", "2026-01-01T00:00:00.000Z"),
      row("uuid-b", "2026-01-02T00:00:00.000Z"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.total).toBe(3);
    expect(plan.alreadyAssigned).toBe(0);
    expect(plan.assignments).toEqual([
      { sessionId: "uuid-a", shortId: "ws#1" },
      { sessionId: "uuid-b", shortId: "ws#2" },
      { sessionId: "uuid-c", shortId: "ws#3" },
    ]);
  });

  it("is idempotent: rows that already have a short_id are skipped, not reassigned", () => {
    const rows = [
      row("uuid-a", "2026-01-01T00:00:00.000Z", "ws#1"),
      row("uuid-b", "2026-01-02T00:00:00.000Z", null),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.total).toBe(2);
    expect(plan.alreadyAssigned).toBe(1);
    // Only the missing row is planned; the already-assigned row is untouched
    // and does not appear in `assignments` at all.
    expect(plan.assignments).toEqual([{ sessionId: "uuid-b", shortId: "ws#2" }]);
  });

  it("continues the sequence after the highest already-assigned ws#N, not from 1", () => {
    // Simulates: sessions created via mint-on-create (mt#2967) after
    // migration deploy but before this backfill ran — the backfill must not
    // reissue ws#1..ws#5.
    const rows = [
      row("uuid-old", "2026-01-01T00:00:00.000Z", null),
      row("uuid-new-1", "2026-02-01T00:00:00.000Z", "ws#5"),
      row("uuid-new-2", "2026-02-02T00:00:00.000Z", "ws#6"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.alreadyAssigned).toBe(2);
    expect(plan.assignments).toEqual([{ sessionId: "uuid-old", shortId: "ws#7" }]);
  });

  it("returns an empty plan when every row already has a short_id", () => {
    const rows = [
      row("uuid-a", "2026-01-01T00:00:00.000Z", "ws#1"),
      row("uuid-b", "2026-01-02T00:00:00.000Z", "ws#2"),
    ];

    const plan = planBackfillAssignments(rows);

    expect(plan.assignments).toEqual([]);
    expect(plan.alreadyAssigned).toBe(2);
    expect(plan.total).toBe(2);
  });

  it("returns an empty plan for an empty table", () => {
    const plan = planBackfillAssignments([]);
    expect(plan).toEqual({ assignments: [], alreadyAssigned: 0, total: 0 });
  });

  it("handles a malformed createdAt by sorting it last rather than crashing", () => {
    const rows = [row("uuid-good", "2026-01-01T00:00:00.000Z"), row("uuid-bad", "not-a-date")];

    const plan = planBackfillAssignments(rows);

    expect(plan.assignments.map((a) => a.sessionId)).toEqual(["uuid-good", "uuid-bad"]);
  });

  it("produces distinct, monotonically increasing short ids within one batch", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`uuid-${i}`, new Date(2026, 0, i + 1).toISOString())
    );

    const plan = planBackfillAssignments(rows);

    const shortIds = plan.assignments.map((a) => a.shortId);
    expect(new Set(shortIds).size).toBe(shortIds.length);
    expect(shortIds).toEqual(Array.from({ length: 10 }, (_, i) => `ws#${i + 1}`));
  });
});

describe("advisory-lock concurrency guard (mt#2967)", () => {
  function makeFakeDb(acquireResult: boolean) {
    const calls: unknown[] = [];
    const db = {
      execute: mock((query: unknown) => {
        calls.push(query);
        // First call in each test is the acquire attempt; subsequent calls
        // (release) don't need a meaningful return value.
        if (calls.length === 1) {
          return Promise.resolve([{ pg_try_advisory_lock: acquireResult }]);
        }
        return Promise.resolve([]);
      }),
    };
    return { db: db as unknown as PostgresJsDatabase, calls };
  }

  it("tryAcquireBackfillLock returns true when the lock is free", async () => {
    const { db, calls } = makeFakeDb(true);
    const acquired = await tryAcquireBackfillLock(db);
    expect(acquired).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("tryAcquireBackfillLock returns false when another session already holds the lock", async () => {
    const { db } = makeFakeDb(false);
    const acquired = await tryAcquireBackfillLock(db);
    expect(acquired).toBe(false);
  });

  it("releaseBackfillLock issues a pg_advisory_unlock call", async () => {
    const { db, calls } = makeFakeDb(true);
    await tryAcquireBackfillLock(db);
    await releaseBackfillLock(db);
    // acquire + release = 2 execute() calls total.
    expect(calls.length).toBe(2);
  });

  it("uses a stable, non-zero advisory lock key", () => {
    // Pinning the key's shape (not its exact value) guards against an
    // accidental change to `bigint` -> `number` or a collision with another
    // script's key range.
    expect(typeof BACKFILL_ADVISORY_LOCK_KEY).toBe("bigint");
    expect(BACKFILL_ADVISORY_LOCK_KEY > 0n).toBe(true);
  });

  it("a second concurrent acquire attempt against an already-held lock is refused, not blocked", async () => {
    // Simulates two --execute invocations racing: the first acquires; a
    // fake db shared between both calls but scripted to report the lock as
    // already-held on subsequent calls models the second process's view.
    let firstCallDone = false;
    const db = {
      execute: mock(() => {
        // Once the first "process" has acquired, every subsequent
        // tryAcquireBackfillLock call (representing a second invocation)
        // observes the lock as held.
        const result = firstCallDone
          ? [{ pg_try_advisory_lock: false }]
          : [{ pg_try_advisory_lock: true }];
        firstCallDone = true;
        return Promise.resolve(result);
      }),
    } as unknown as PostgresJsDatabase;

    const first = await tryAcquireBackfillLock(db);
    const second = await tryAcquireBackfillLock(db);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
