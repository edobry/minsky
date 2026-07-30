/**
 * Unit tests for `backfill-agent-tool-call-projection.ts`'s
 * `countPendingProjectionRows` (mt#3360).
 *
 * Real Postgres jsonb semantics (`jsonb_array_length` throwing on a scalar,
 * `jsonb_typeof` never throwing) can't be meaningfully faked with a mocked
 * `db.execute` — that guard is verified live against prod instead (see the
 * mt#3360 PR body's `Execution evidence:` block: the dry-run completes
 * cleanly against the real 1,948-row double-encoded corpus). These tests
 * cover the surrounding data-flow logic that CAN be pinned without a real
 * DB: `countPendingProjectionRows` issues exactly two queries (the guarded
 * pending-rows aggregate, then the skipped-non-array count) and combines
 * their results into `PendingProjectionCounts`, defaulting gracefully to 0
 * when either query returns no rows.
 */

import { describe, it, expect, mock } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { countPendingProjectionRows } from "./backfill-agent-tool-call-projection";

function makeFakeDb(responses: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  const calls: unknown[] = [];
  const db = {
    execute: mock((query: unknown) => {
      calls.push(query);
      const response = responses[call] ?? [];
      call++;
      return Promise.resolve(response);
    }),
  };
  return { db: db as unknown as PostgresJsDatabase, calls };
}

describe("countPendingProjectionRows (mt#3360)", () => {
  it("combines the pending-rows query and the skipped-non-array query into one result", async () => {
    const { db, calls } = makeFakeDb([
      [{ pending_turns: 5, pending_rows: 8 }],
      [{ skipped_non_array: 3 }],
    ]);

    const result = await countPendingProjectionRows(db);

    expect(result).toEqual({ pendingTurns: 5, pendingRows: 8, skippedNonArray: 3 });
    // Exactly two queries: the guarded pending aggregate, then the
    // skipped-non-array count — no more, no fewer.
    expect(calls.length).toBe(2);
  });

  it("defaults every field to 0 when a query returns no rows", async () => {
    const { db } = makeFakeDb([[], []]);

    const result = await countPendingProjectionRows(db);

    expect(result).toEqual({ pendingTurns: 0, pendingRows: 0, skippedNonArray: 0 });
  });

  it("skippedNonArray is independent of pendingRows — a corpus with only non-array rows reports zero pending but a non-zero skip count", async () => {
    // Models the exact mt#3360 scenario pre-repair: every string-typed row is
    // excluded from the guarded pending-rows aggregate (it can't be measured
    // via jsonb_array_length) but IS counted by the second query.
    const { db } = makeFakeDb([
      [{ pending_turns: 0, pending_rows: 0 }],
      [{ skipped_non_array: 1948 }],
    ]);

    const result = await countPendingProjectionRows(db);

    expect(result.pendingRows).toBe(0);
    expect(result.skippedNonArray).toBe(1948);
  });
});
