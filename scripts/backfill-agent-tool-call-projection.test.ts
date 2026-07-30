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
import { computeArgFingerprint } from "@minsky/domain/transcripts/tool-call-projection-fields";
import {
  countPendingProjectionRows,
  runSampleReconciliation,
} from "./backfill-agent-tool-call-projection";

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

/**
 * Recursively render the LITERAL text of a drizzle `SQL` template object —
 * i.e. join every `StringChunk` segment, skipping interpolated params
 * entirely — to assert on the query's structural SHAPE without needing a
 * real Postgres connection. Verified empirically (see this file's
 * `describe("runSampleReconciliation's sample-selection query shape ...")`
 * below) against the exact `sql\`...${n}\`` shape this script builds.
 */
function renderLiteralSql(chunk: unknown, depth = 0): string {
  if (depth > 25 || chunk === null || chunk === undefined || typeof chunk !== "object") return "";
  const c = chunk as Record<string, unknown>;
  if (Array.isArray(c.queryChunks)) {
    return (c.queryChunks as unknown[]).map((sub) => renderLiteralSql(sub, depth + 1)).join("");
  }
  if (Array.isArray(c.value) && (c.value as unknown[]).every((v) => typeof v === "string")) {
    return (c.value as string[]).join("");
  }
  return ""; // interpolated param (e.g. sampleSize) — opaque, not literal text
}

describe("runSampleReconciliation (mt#3395)", () => {
  it(
    "regression: the sample-selection query wraps SELECT DISTINCT in a subquery so " +
      "ORDER BY random() applies OUTSIDE it (was invalid Postgres: " +
      '"for SELECT DISTINCT, ORDER BY expressions must appear in select list")',
    async () => {
      const { db, calls } = makeFakeDb([[]]); // empty sample -> exactly one query issued

      await runSampleReconciliation(db, 5);

      expect(calls.length).toBe(1);
      const literalSql = renderLiteralSql(calls[0]);

      // Outer SELECT (the one ORDER BY random() attaches to) does NOT carry
      // DISTINCT — it selects from a subquery aliased `s`.
      expect(literalSql).toMatch(/SELECT\s+agent_session_id\s*\n\s*FROM\s*\(/i);
      // The DISTINCT lives only in the INNER subquery.
      expect(literalSql).toMatch(/SELECT DISTINCT agent_session_id/i);
      // ORDER BY random() is applied to the subquery's result (aliased `s`),
      // i.e. OUTSIDE the DISTINCT — the shape that sidesteps the Postgres
      // restriction.
      expect(literalSql).toMatch(/\)\s*s\s*\n\s*ORDER BY random\(\)/i);
    }
  );

  it("reports a match when the stored projection rows agree with an independent re-derivation from tool_calls", async () => {
    const sessionId = "match-session";
    const input = { path: "/foo" };
    const fingerprint = computeArgFingerprint(input);

    const { db } = makeFakeDb([
      [{ agent_session_id: sessionId }], // sample-selection query
      [{ turn_index: 0, tool_calls: [{ type: "tool_use", name: "Bash", input }] }], // turnRows
      [
        {
          turn_index: 0,
          ordinal: 0,
          tool_name: "Bash",
          server: null,
          arg_fingerprint: fingerprint,
        },
      ], // actualRows
    ]);

    const result = await runSampleReconciliation(db, 1);

    expect(result.sessionsSampled).toBe(1);
    expect(result.sessionsMatched).toBe(1);
    expect(result.sessionsMismatched).toBe(0);
    expect(result.mismatchDetails).toEqual([]);
  });

  it("reports a simulated mismatch (row-count divergence) with the session id and a diagnostic detail", async () => {
    const sessionId = "mismatch-session";

    const { db } = makeFakeDb([
      [{ agent_session_id: sessionId }], // sample-selection query
      [{ turn_index: 0, tool_calls: [{ type: "tool_use", name: "Bash", input: {} }] }], // turnRows: 1 expected block
      [], // actualRows: simulated missing row -> row-count mismatch
    ]);

    const result = await runSampleReconciliation(db, 1);

    expect(result.sessionsSampled).toBe(1);
    expect(result.sessionsMatched).toBe(0);
    expect(result.sessionsMismatched).toBe(1);
    expect(result.mismatchDetails).toHaveLength(1);
    expect(result.mismatchDetails[0]).toContain(sessionId);
    expect(result.mismatchDetails[0]).toContain("row count mismatch");
  });

  it("reports a simulated mismatch (field divergence) when a stored row's fingerprint disagrees with the re-derivation", async () => {
    const sessionId = "fingerprint-mismatch-session";

    const { db } = makeFakeDb([
      [{ agent_session_id: sessionId }],
      [{ turn_index: 0, tool_calls: [{ type: "tool_use", name: "Bash", input: { a: 1 } }] }],
      [
        {
          turn_index: 0,
          ordinal: 0,
          tool_name: "Bash",
          server: null,
          arg_fingerprint: "deadbeefdeadbeef", // deliberately wrong
        },
      ],
    ]);

    const result = await runSampleReconciliation(db, 1);

    expect(result.sessionsMismatched).toBe(1);
    expect(result.mismatchDetails[0]).toContain("divergence at index 0");
  });

  it("sampleSize=0 short-circuits without issuing any query", async () => {
    const { db, calls } = makeFakeDb([]);

    const result = await runSampleReconciliation(db, 0);

    expect(calls.length).toBe(0);
    expect(result).toEqual({
      sessionsSampled: 0,
      sessionsMatched: 0,
      sessionsMismatched: 0,
      mismatchDetails: [],
    });
  });
});
