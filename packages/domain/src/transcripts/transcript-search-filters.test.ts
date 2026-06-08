/**
 * Unit tests for the shared transcript-search date-window filter + coverage.
 *
 * The headline regression (mt#2319): the date window must bind the TURN's
 * started_at (agent_transcript_turns.started_at), NOT the parent session's
 * (agent_transcripts.started_at). We assert this by rendering the generated SQL
 * via PgDialect and inspecting which qualified column the predicate references —
 * a deterministic check that needs no live database.
 *
 * @see mt#2319
 */

import { describe, test, expect } from "bun:test";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildTurnDateRangeConditions, assessWindowCoverage } from "./transcript-search-filters";

// Qualified columns the date predicate may bind. The fix (mt#2319) is that it
// binds the TURN column, never the parent-session column.
const TURN_STARTED_AT = '"agent_transcript_turns"."started_at"';
const SESSION_STARTED_AT = '"agent_transcripts"."started_at"';

// Render an array of SQL conditions to a concrete SQL string for inspection.
function renderConditions(conds: ReturnType<typeof buildTurnDateRangeConditions>): string {
  const combined = and(...conds);
  if (!combined) return "";
  return new PgDialect().sqlToQuery(combined).sql;
}

describe("buildTurnDateRangeConditions", () => {
  test("binds the TURN's started_at, not the parent session's (mt#2319)", () => {
    const sqlStr = renderConditions(
      buildTurnDateRangeConditions({ from: new Date("2026-06-05"), to: new Date("2026-06-07") })
    );
    // The predicate must reference the turn table's column...
    expect(sqlStr).toContain(TURN_STARTED_AT);
    // ...and must NOT reference the parent session's started_at.
    expect(sqlStr).not.toContain(SESSION_STARTED_AT);
  });

  test("from-only produces a single >= condition on the turn column", () => {
    const conds = buildTurnDateRangeConditions({ from: new Date("2026-06-05") });
    expect(conds).toHaveLength(1);
    const sqlStr = renderConditions(conds);
    expect(sqlStr).toContain(TURN_STARTED_AT);
    expect(sqlStr).toContain(">=");
    expect(sqlStr).not.toContain("<=");
  });

  test("to-only produces a single <= condition on the turn column", () => {
    const conds = buildTurnDateRangeConditions({ to: new Date("2026-06-07") });
    expect(conds).toHaveLength(1);
    const sqlStr = renderConditions(conds);
    expect(sqlStr).toContain(TURN_STARTED_AT);
    expect(sqlStr).toContain("<=");
    expect(sqlStr).not.toContain(">=");
  });

  test("both bounds produce two conditions", () => {
    const conds = buildTurnDateRangeConditions({
      from: new Date("2026-06-05"),
      to: new Date("2026-06-07"),
    });
    expect(conds).toHaveLength(2);
  });

  test("no dateRange (undefined) produces no conditions", () => {
    expect(buildTurnDateRangeConditions(undefined)).toHaveLength(0);
  });

  test("empty dateRange object produces no conditions", () => {
    expect(buildTurnDateRangeConditions({})).toHaveLength(0);
  });
});

// ── assessWindowCoverage ────────────────────────────────────────────────────

/**
 * Minimal fake DB whose `.select(...).from(...).where(...)` resolves to a single
 * `{ count }` row (or rejects, to exercise the fail-safe path).
 */
function fakeCoverageDb(count: number, opts: { throws?: boolean } = {}): PostgresJsDatabase {
  const whereFn = () =>
    opts.throws ? Promise.reject(new Error("db unavailable")) : Promise.resolve([{ count }]);
  return {
    select: () => ({ from: () => ({ where: whereFn }) }),
  } as unknown as PostgresJsDatabase;
}

/** A fake DB whose select() throws if ever called (to prove the no-window short-circuit). */
function unusableDb(): PostgresJsDatabase {
  return {
    select: () => {
      throw new Error("select should not be called");
    },
  } as unknown as PostgresJsDatabase;
}

describe("assessWindowCoverage", () => {
  test("reports the un-indexed session count + note when the window has a gap", async () => {
    const coverage = await assessWindowCoverage(fakeCoverageDb(3), {
      from: new Date("2026-06-04"),
      to: new Date("2026-06-08"),
    });
    expect(coverage.unindexedSessionsInWindow).toBe(3);
    expect(coverage.note).toBeDefined();
    expect(coverage.note).toContain("index-embeddings");
  });

  test("returns 0 with no note when every in-window session is indexed", async () => {
    const coverage = await assessWindowCoverage(fakeCoverageDb(0), {
      from: new Date("2026-06-04"),
    });
    expect(coverage.unindexedSessionsInWindow).toBe(0);
    expect(coverage.note).toBeUndefined();
  });

  test("short-circuits (does not query) when no date window is supplied", async () => {
    const coverage = await assessWindowCoverage(unusableDb(), undefined);
    expect(coverage.unindexedSessionsInWindow).toBe(0);
  });

  test("short-circuits on an empty date-range object", async () => {
    const coverage = await assessWindowCoverage(unusableDb(), {});
    expect(coverage.unindexedSessionsInWindow).toBe(0);
  });

  test("fails safe (returns 0) when the coverage query throws", async () => {
    const coverage = await assessWindowCoverage(fakeCoverageDb(5, { throws: true }), {
      from: new Date("2026-06-04"),
    });
    expect(coverage.unindexedSessionsInWindow).toBe(0);
  });

  test("coerces a string count from the pg driver to a number", async () => {
    const coverage = await assessWindowCoverage(
      // pg may return count as a string; assessWindowCoverage must coerce.
      fakeCoverageDb("4" as unknown as number),
      { from: new Date("2026-06-04") }
    );
    expect(coverage.unindexedSessionsInWindow).toBe(4);
  });
});
