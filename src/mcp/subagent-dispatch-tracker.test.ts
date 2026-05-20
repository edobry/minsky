/**
 * SubagentDispatchTracker unit tests (mt#1736)
 *
 * Verifies:
 *   - Insert/upsert behavior: row appears after recordSubagentInvocation;
 *     calling again with the same subagentSessionId updates rather than inserts.
 *   - byOutcome aggregation: seed 20 rows across the 6 outcome classes.
 *   - byHourLast24h aggregation: rows bucketed by hour correctly, 24h window enforced.
 *   - byAgentType aggregation: counts per agentType string.
 *   - Escalation tiers:
 *       3 partial-uncommitted-no-handoff in one session → "session"
 *       6 partial-uncommitted-no-handoff in last 24h → "daily"
 *       4 rate-limited in last 24h → "daily"
 *       below all thresholds → "none"
 *
 * All tests use an in-memory fake DB — no real Postgres. The fake implements
 * the drizzle query builder surface used by the tracker: select, insert, update,
 * with WHERE clause support via PgDialect-rendered SQL parsing. This approach
 * avoids needing to parse drizzle AST objects directly.
 *
 * @see mt#1736 — this test
 * @see src/mcp/subagent-dispatch-tracker.ts — implementation
 */

/* eslint-disable custom/no-real-fs-in-tests -- BLOCKING #2 regression guard needs readFileSync */

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  SubagentDispatchTracker,
  SESSION_PARTIAL_UNCOMMITTED_THRESHOLD,
  DAILY_PARTIAL_UNCOMMITTED_THRESHOLD,
  DAILY_RATE_LIMITED_THRESHOLD,
  type SubagentInvocationInput,
} from "./subagent-dispatch-tracker";
import type { SubagentInvocationOutcome } from "../domain/storage/schemas/subagent-invocations-schema";
import { SUBAGENT_INVOCATION_OUTCOME_VALUES } from "../domain/storage/schemas/subagent-invocations-schema";

// ---------------------------------------------------------------------------
// Outcome class constants (used in tests to avoid magic-string duplication)
// ---------------------------------------------------------------------------

const OUTCOME_COMPLETED_WITH_PR: SubagentInvocationOutcome = "completed-with-pr";
const OUTCOME_COMMITTED_NO_PR: SubagentInvocationOutcome = "committed-no-pr";
const OUTCOME_PARTIAL_COMMITTED_HANDOFF: SubagentInvocationOutcome =
  "partial-committed-handoff-written";
const OUTCOME_PARTIAL_UNCOMMITTED: SubagentInvocationOutcome = "partial-uncommitted-no-handoff";
const OUTCOME_CRASHED: SubagentInvocationOutcome = "crashed-no-output";
const OUTCOME_RATE_LIMITED: SubagentInvocationOutcome = "rate-limited";

// ---------------------------------------------------------------------------
// Row type + ID counter
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  taskId: string;
  sessionId: string | null;
  agentSessionId: string | null;
  parentSessionId: string | null;
  parentTaskId: string | null;
  subagentSessionId: string | null;
  agentType: string;
  suggestedModel: string | null;
  actualModel: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  toolUseCount: number | null;
  totalTokens: number | null;
  outcome: SubagentInvocationOutcome;
  errorSummary: string | null;
  summary: string | null;
  prUrl: string | null;
  lastCommitHash: string | null;
  handoffWritten: boolean | null;
}

let nextId = 1;

function inputToRow(input: SubagentInvocationInput): FakeRow {
  return {
    id: input.id ?? `fake-id-${nextId++}`,
    taskId: input.taskId,
    sessionId: input.sessionId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    subagentSessionId: input.subagentSessionId ?? null,
    agentType: input.agentType,
    suggestedModel: input.suggestedModel ?? null,
    actualModel: input.actualModel ?? null,
    startedAt:
      input.startedAt instanceof Date ? input.startedAt : new Date(input.startedAt ?? Date.now()),
    endedAt:
      input.endedAt instanceof Date
        ? input.endedAt
        : input.endedAt
          ? new Date(input.endedAt)
          : null,
    durationMs: input.durationMs ?? null,
    toolUseCount: input.toolUseCount ?? null,
    totalTokens: input.totalTokens ?? null,
    outcome: input.outcome,
    errorSummary: input.errorSummary ?? null,
    summary: input.summary ?? null,
    prUrl: input.prUrl ?? null,
    lastCommitHash: input.lastCommitHash ?? null,
    handoffWritten: input.handoffWritten ?? null,
  };
}

// ---------------------------------------------------------------------------
// WHERE clause evaluator
//
// Uses PgDialect to render drizzle condition objects to SQL + params, then
// parses the rendered SQL to build JavaScript predicates.
//
// Column name → FakeRow field mapping
// ---------------------------------------------------------------------------

const COLUMN_TO_FIELD: Record<string, keyof FakeRow> = {
  id: "id",
  outcome: "outcome",
  started_at: "startedAt",
  parent_session_id: "parentSessionId",
  subagent_session_id: "subagentSessionId",
  agent_type: "agentType",
  task_id: "taskId",
  session_id: "sessionId",
};

const pgDialect = new PgDialect();

/**
 * Render a drizzle condition to `{ sql, params }` using PgDialect.
 * Wraps the condition in a dummy SELECT so the dialect can render it.
 */
function renderCondition(condition: unknown): { sqlStr: string; params: unknown[] } {
  try {
    // Use drizzle's sql template to wrap the condition
    const rendered = pgDialect.sqlToQuery(
      sql`SELECT 1 WHERE ${condition as Parameters<typeof sql>[0]}`
    );
    return { sqlStr: rendered.sql, params: rendered.params };
  } catch {
    return { sqlStr: "", params: [] };
  }
}

/**
 * Parse a rendered SQL WHERE clause into a JavaScript predicate function.
 *
 * Supports patterns produced by the tracker:
 *   - `"col" = $N`                (eq)
 *   - `"col" >= $N`               (gte)
 *   - `"col" is not null`         (isNotNull)
 *   - `(cond1 and cond2)`         (and — compound)
 *
 * Column names in the SQL are fully qualified: `"table_name"."col_name"`.
 * The column extractor strips the table prefix.
 */
function buildPredicate(condition: unknown): (row: FakeRow) => boolean {
  if (!condition) {
    throw new Error("buildPredicate: condition is null/undefined — refusing permissive default");
  }

  const { sqlStr, params } = renderCondition(condition);
  if (!sqlStr) {
    throw new Error(
      "buildPredicate: PgDialect could not render condition — refusing permissive default"
    );
  }

  // Extract just the WHERE clause
  const whereIdx = sqlStr.toUpperCase().indexOf("WHERE");
  const whereClause = whereIdx >= 0 ? sqlStr.slice(whereIdx + 5).trim() : sqlStr;

  return parseWhere(whereClause, params);
}

function parseWhere(clause: string, params: unknown[]): (row: FakeRow) => boolean {
  clause = clause.trim();

  // Strip outer parentheses: `(expr)` → `expr`
  if (clause.startsWith("(") && clause.endsWith(")")) {
    clause = clause.slice(1, -1).trim();
  }

  // AND clause: `(A and B)` — split on top-level " and "
  // After stripping outer parens, find " and " not inside parens
  const andIdx = findTopLevelAnd(clause);
  if (andIdx >= 0) {
    const left = clause.slice(0, andIdx).trim();
    const right = clause.slice(andIdx + 4).trim(); // " and ".length = 5, but we advance 4 after stripping spaces
    const leftPred = parseWhere(left, params);
    const rightPred = parseWhere(right, params);
    return (row) => leftPred(row) && rightPred(row);
  }

  // IS NOT NULL: `"table"."col" is not null`
  const isNotNullMatch = clause.match(/"[^"]+"\."([^"]+)" is not null/i);
  if (isNotNullMatch) {
    const colName = isNotNullMatch[1];
    if (!colName) {
      throw new Error(`parseWhere: malformed IS NOT NULL clause: ${clause}`);
    }
    const field = COLUMN_TO_FIELD[colName];
    if (!field) {
      throw new Error(`parseWhere: unknown column in IS NOT NULL clause: ${colName}`);
    }
    return (row) => row[field] != null;
  }

  // Comparison: `"table"."col" >= $N` or `"table"."col" = $N`
  const cmpMatch = clause.match(/"[^"]+"\."([^"]+)"\s*(=|>=|<=|>|<)\s*\$(\d+)/);
  if (cmpMatch) {
    const colName = cmpMatch[1];
    const op = cmpMatch[2];
    const paramIdxStr = cmpMatch[3];
    if (!colName || !op || !paramIdxStr) {
      throw new Error(`parseWhere: malformed comparison clause: ${clause}`);
    }
    const paramIdx = parseInt(paramIdxStr, 10) - 1; // $1 → params[0]
    const paramVal = params[paramIdx];
    const field = COLUMN_TO_FIELD[colName];
    if (!field) {
      throw new Error(`parseWhere: unknown column in comparison clause: ${colName}`);
    }

    return (row) => {
      const rowVal = row[field];
      if (rowVal == null) return false;
      // Date comparison
      if (
        paramVal instanceof Date ||
        (typeof paramVal === "string" && !isNaN(Date.parse(paramVal as string)))
      ) {
        const rowDate = rowVal instanceof Date ? rowVal : new Date(rowVal as string);
        const paramDate = paramVal instanceof Date ? paramVal : new Date(paramVal as string);
        switch (op) {
          case "=":
            return rowDate.getTime() === paramDate.getTime();
          case ">=":
            return rowDate.getTime() >= paramDate.getTime();
          case ">":
            return rowDate.getTime() > paramDate.getTime();
          case "<=":
            return rowDate.getTime() <= paramDate.getTime();
          case "<":
            return rowDate.getTime() < paramDate.getTime();
          default:
            return false;
        }
      }
      // String/number comparison
      switch (op) {
        case "=":
          return rowVal === paramVal;
        case ">=":
          return (rowVal as string | number) >= (paramVal as string | number);
        case ">":
          return (rowVal as string | number) > (paramVal as string | number);
        case "<=":
          return (rowVal as string | number) <= (paramVal as string | number);
        case "<":
          return (rowVal as string | number) < (paramVal as string | number);
        default:
          return false;
      }
    };
  }

  // Unrecognized WHERE shape — fail-fast rather than silently pass all rows.
  // Reviewer-bot R1 NON-BLOCKING (PR #1046): permissive default could mask
  // future query changes (extra OR/IN/NOT, mismatched column names) by not
  // filtering at all in tests. If you hit this throw, update parseWhere to
  // handle the new shape or assert the test against the rendered SQL string.
  throw new Error(`parseWhere: unrecognized WHERE shape (no test coverage): ${clause}`);
}

/** Find the index of a top-level " and " (not nested inside parentheses). */
function findTopLevelAnd(clause: string): number {
  let depth = 0;
  for (let i = 0; i < clause.length - 4; i++) {
    const c = clause[i];
    if (!c) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && clause.slice(i, i + 5).toLowerCase() === " and ") {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Fake DB builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Drizzle DB backed by the given `store`. Tests can
 * read/write `store` directly to verify INSERT/UPDATE behavior.
 *
 * Implements the query builder surface used by SubagentDispatchTracker:
 *   - select().from().where().groupBy().orderBy().limit() → Promise<rows>
 *   - insert().values() → Promise<void>
 *   - update().set().where() → Promise<void>
 */
function makeFakeDb(store: Map<string, FakeRow>): PostgresJsDatabase {
  function rows(): FakeRow[] {
    return Array.from(store.values());
  }

  type QueryCtx = {
    selectedFields: Record<string, unknown>;
    wherePred: ((row: FakeRow) => boolean) | null;
    groupByFn: ((row: FakeRow) => string) | null;
    orderByDescStartedAt: boolean;
    limitVal: number | null;
    countField: string | null; // "total" or "cnt" — signals a count() aggregation
  };

  function makeSelectChain(ctx: QueryCtx): unknown {
    const chain = {
      from(_table: unknown) {
        return chain;
      },
      where(condition: unknown) {
        ctx.wherePred = buildPredicate(condition);
        return chain;
      },
      groupBy(_col: unknown) {
        ctx.groupByFn = buildGroupByFn(ctx.selectedFields);
        return chain;
      },
      orderBy(_col: unknown) {
        ctx.orderByDescStartedAt = true;
        return chain;
      },
      limit(n: number) {
        ctx.limitVal = n;
        return chain;
      },
      innerJoin(_t: unknown, _c: unknown) {
        return chain;
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void): Promise<unknown> {
        return executeSelect(ctx).then(resolve, reject);
      },
    };
    return chain;
  }

  function buildGroupByFn(
    selectedFields: Record<string, unknown>
  ): ((row: FakeRow) => string) | null {
    if ("outcome" in selectedFields) {
      return (row) => row.outcome;
    }
    if ("agentType" in selectedFields) {
      return (row) => row.agentType;
    }
    if ("hour" in selectedFields) {
      // Truncate to UTC hour
      return (row) => {
        const d = row.startedAt;
        return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00Z`;
      };
    }
    return null;
  }

  async function executeSelect(ctx: QueryCtx): Promise<unknown[]> {
    let rs = rows();

    // Apply WHERE filter
    if (ctx.wherePred) {
      rs = rs.filter(ctx.wherePred);
    }

    // Apply groupBy
    if (ctx.groupByFn) {
      const groups = new Map<string, FakeRow[]>();
      for (const row of rs) {
        const key = ctx.groupByFn(row);
        const bucket = groups.get(key) ?? [];
        bucket.push(row);
        groups.set(key, bucket);
      }

      const result: Array<Record<string, unknown>> = [];
      for (const [key, groupRows] of groups) {
        const firstRow = groupRows[0];
        const entry: Record<string, unknown> = { cnt: groupRows.length };
        if ("outcome" in ctx.selectedFields && firstRow) entry.outcome = firstRow.outcome;
        if ("agentType" in ctx.selectedFields && firstRow) entry.agentType = firstRow.agentType;
        if ("hour" in ctx.selectedFields) entry.hour = key;
        result.push(entry);
      }
      return result;
    }

    // Apply orderBy (desc startedAt — this is the only ordering used in the tracker)
    if (ctx.orderByDescStartedAt) {
      rs = [...rs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }

    // Apply limit
    if (ctx.limitVal !== null) {
      rs = rs.slice(0, ctx.limitVal);
    }

    // count() aggregation: when selected fields contain "total" or "cnt"
    if (ctx.countField) {
      return [{ [ctx.countField]: rs.length }];
    }

    return rs;
  }

  const db = {
    select(fields: Record<string, unknown> = {}) {
      // Detect count() by checking for "total" or "cnt" keys
      const countField = "total" in fields ? "total" : "cnt" in fields ? "cnt" : null;

      const ctx: QueryCtx = {
        selectedFields: fields,
        wherePred: null,
        groupByFn: null,
        orderByDescStartedAt: false,
        limitVal: null,
        countField,
      };

      return makeSelectChain(ctx);
    },

    insert(_table: unknown) {
      return {
        values(input: SubagentInvocationInput) {
          const row = inputToRow(input);
          store.set(row.id, row);
          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              return Promise.resolve();
            },
            then(resolve: (v: void) => void, _reject: (e: unknown) => void): Promise<void> {
              return Promise.resolve().then(resolve);
            },
          };
        },
      };
    },

    update(_table: unknown) {
      return {
        set(updates: Partial<SubagentInvocationInput>) {
          return {
            where(condition: unknown): Promise<void> {
              // Parse the WHERE condition and update only matching rows.
              // PR #1046 R1 BLOCKING #3 fix: tracker now UPDATEs by primary
              // key (id) instead of subagentSessionId, so the fake must honor
              // the actual condition rather than the prior session-id hack.
              const pred = buildPredicate(condition);
              for (const [id, row] of store) {
                if (pred(row)) {
                  store.set(id, { ...row, ...(updates as Partial<FakeRow>) } as FakeRow);
                }
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return db as unknown as PostgresJsDatabase;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date("2026-05-11T12:00:00.000Z");

function hoursAgo(n: number): Date {
  return new Date(BASE_DATE.getTime() - n * 60 * 60 * 1000);
}

function makeInput(overrides: Partial<SubagentInvocationInput> = {}): SubagentInvocationInput {
  return {
    taskId: "mt#1736",
    agentType: "general-purpose",
    outcome: "completed-with-pr",
    startedAt: BASE_DATE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubagentDispatchTracker", () => {
  let store: Map<string, FakeRow>;
  let tracker: SubagentDispatchTracker;

  beforeEach(() => {
    store = new Map<string, FakeRow>();
    nextId = 1;
    tracker = new SubagentDispatchTracker(makeFakeDb(store));
  });

  // -------------------------------------------------------------------------
  // recordSubagentInvocation — insert/upsert behavior
  // -------------------------------------------------------------------------

  describe("recordSubagentInvocation", () => {
    test("inserts a row when subagentSessionId is null", async () => {
      await tracker.recordSubagentInvocation(makeInput({ subagentSessionId: null }));
      expect(store.size).toBe(1);
    });

    test("inserts a new row on each call when subagentSessionId is null", async () => {
      await tracker.recordSubagentInvocation(makeInput({ subagentSessionId: null }));
      await tracker.recordSubagentInvocation(makeInput({ subagentSessionId: null }));
      expect(store.size).toBe(2);
    });

    test("inserts a row when subagentSessionId is provided (first time)", async () => {
      await tracker.recordSubagentInvocation(
        makeInput({ subagentSessionId: "session-abc", taskId: "mt#100" })
      );
      expect(store.size).toBe(1);
      const row = Array.from(store.values())[0];
      expect(row).toBeDefined();
      expect(row?.taskId).toBe("mt#100");
      expect(row?.subagentSessionId).toBe("session-abc");
    });

    test("updates existing row when subagentSessionId matches (upsert — no second row)", async () => {
      // First insert
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "session-xyz",
          outcome: OUTCOME_PARTIAL_UNCOMMITTED,
          taskId: "mt#200",
        })
      );
      expect(store.size).toBe(1);

      // Second call with same subagentSessionId — should update, not insert
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "session-xyz",
          outcome: OUTCOME_COMPLETED_WITH_PR,
          taskId: "mt#200",
          prUrl: "https://github.com/edobry/minsky/pull/999",
        })
      );
      // Row count should still be 1 (updated, not inserted)
      expect(store.size).toBe(1);
      // The row should reflect the updated outcome and prUrl
      const row = Array.from(store.values())[0];
      expect(row?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
      expect(row?.prUrl).toBe("https://github.com/edobry/minsky/pull/999");
    });

    test("different subagentSessionIds produce separate rows", async () => {
      await tracker.recordSubagentInvocation(makeInput({ subagentSessionId: "session-1" }));
      await tracker.recordSubagentInvocation(makeInput({ subagentSessionId: "session-2" }));
      expect(store.size).toBe(2);
    });

    // ─── PR #1046 R1 BLOCKING #1 regression: startedAt preservation on upsert ───
    test("upsert UPDATE preserves startedAt even when new input has a different value", async () => {
      const originalStarted = new Date("2026-05-11T10:00:00.000Z");
      const laterStarted = new Date("2026-05-11T15:00:00.000Z");

      // First call: insert with the original startedAt.
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "preserve-test",
          startedAt: originalStarted,
          outcome: OUTCOME_PARTIAL_UNCOMMITTED,
        })
      );
      expect(store.size).toBe(1);

      // Second call: upsert with a DIFFERENT startedAt (simulating SubagentStop
      // hook firing later in the dispatch lifecycle with `now()` rather than
      // the original dispatch time). The UPDATE must NOT overwrite startedAt —
      // lastDispatch and byHourLast24h depend on dispatch-time chronology.
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "preserve-test",
          startedAt: laterStarted,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          prUrl: "https://example.com/pr/1",
        })
      );

      // Still one row.
      expect(store.size).toBe(1);
      const row = Array.from(store.values())[0];
      // startedAt MUST equal the original — never overwritten by upsert.
      expect(row?.startedAt.toISOString()).toBe(originalStarted.toISOString());
      // Other fields DID update.
      expect(row?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
      expect(row?.prUrl).toBe("https://example.com/pr/1");
    });

    // ─── PR #1046 R1 BLOCKING #3 regression: UPDATE targets selected id only ───
    test("upsert UPDATE targets only the selected row when duplicates share subagentSessionId", async () => {
      // The schema intentionally has no UNIQUE constraint on subagent_session_id.
      // Seed two rows with the SAME subagentSessionId directly into the fake's
      // store (bypassing the tracker's upsert logic) to simulate the historical-
      // duplicates case the reviewer flagged.
      const duplicateSessionId = "duplicate-session";
      const baseStarted = new Date("2026-05-11T08:00:00.000Z");
      const newerStarted = new Date("2026-05-11T09:00:00.000Z");

      const olderRow = inputToRow(
        makeInput({
          subagentSessionId: duplicateSessionId,
          startedAt: baseStarted,
          outcome: OUTCOME_PARTIAL_UNCOMMITTED,
          taskId: "mt#older",
        })
      );
      const newerRow = inputToRow(
        makeInput({
          subagentSessionId: duplicateSessionId,
          startedAt: newerStarted,
          outcome: OUTCOME_PARTIAL_UNCOMMITTED,
          taskId: "mt#newer",
        })
      );
      store.set(olderRow.id, olderRow);
      store.set(newerRow.id, newerRow);
      expect(store.size).toBe(2);

      // Call tracker.recordSubagentInvocation with the same session id.
      // The tracker does SELECT id ... LIMIT 1, picks ONE row, then UPDATE by id.
      // It must NOT update both rows (the bug the BLOCKING finding caught).
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: duplicateSessionId,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          taskId: "mt#updated",
        })
      );

      // Still two rows — UPDATE did not insert a third.
      expect(store.size).toBe(2);

      // Exactly ONE row was updated to COMPLETED_WITH_PR; the other retains
      // its original outcome. Without the id-targeting fix, BOTH would update.
      const rows = Array.from(store.values());
      const updatedCount = rows.filter((r) => r.outcome === OUTCOME_COMPLETED_WITH_PR).length;
      const unchangedCount = rows.filter((r) => r.outcome === OUTCOME_PARTIAL_UNCOMMITTED).length;
      expect(updatedCount).toBe(1);
      expect(unchangedCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — total + lastDispatch
  // -------------------------------------------------------------------------

  describe("getCadence - total and lastDispatch", () => {
    test("returns total=0 and lastDispatch=null for empty table", async () => {
      const cadence = await tracker.getCadence();
      expect(cadence.total).toBe(0);
      expect(cadence.lastDispatch).toBeNull();
    });

    test("returns correct total after inserts", async () => {
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(2) }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(1) }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: BASE_DATE }));
      const cadence = await tracker.getCadence();
      expect(cadence.total).toBe(3);
    });

    test("lastDispatch is the most recent startedAt", async () => {
      const older = hoursAgo(5);
      const newer = hoursAgo(1);
      await tracker.recordSubagentInvocation(makeInput({ startedAt: older }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: newer }));
      const cadence = await tracker.getCadence();
      expect(cadence.lastDispatch).toBe(newer.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — byOutcome
  // -------------------------------------------------------------------------

  describe("getCadence - byOutcome", () => {
    test("all 6 outcome classes present with zero counts for empty table", async () => {
      const cadence = await tracker.getCadence();
      for (const outcome of SUBAGENT_INVOCATION_OUTCOME_VALUES) {
        expect(cadence.byOutcome[outcome]).toBe(0);
      }
    });

    test("counts 20 rows distributed across 6 outcome classes", async () => {
      // Seed 20 rows: distribute across the 6 outcome classes
      const distribution: Array<[SubagentInvocationOutcome, number]> = [
        [OUTCOME_COMPLETED_WITH_PR, 5],
        [OUTCOME_COMMITTED_NO_PR, 4],
        [OUTCOME_PARTIAL_COMMITTED_HANDOFF, 3],
        [OUTCOME_PARTIAL_UNCOMMITTED, 4],
        [OUTCOME_CRASHED, 2],
        [OUTCOME_RATE_LIMITED, 2],
      ];
      for (const [outcome, n] of distribution) {
        for (let i = 0; i < n; i++) {
          await tracker.recordSubagentInvocation(makeInput({ outcome }));
        }
      }
      expect(store.size).toBe(20);
      const cadence = await tracker.getCadence();
      expect(cadence.byOutcome[OUTCOME_COMPLETED_WITH_PR]).toBe(5);
      expect(cadence.byOutcome[OUTCOME_COMMITTED_NO_PR]).toBe(4);
      expect(cadence.byOutcome[OUTCOME_PARTIAL_COMMITTED_HANDOFF]).toBe(3);
      expect(cadence.byOutcome[OUTCOME_PARTIAL_UNCOMMITTED]).toBe(4);
      expect(cadence.byOutcome[OUTCOME_CRASHED]).toBe(2);
      expect(cadence.byOutcome[OUTCOME_RATE_LIMITED]).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — byAgentType
  // -------------------------------------------------------------------------

  describe("getCadence - byAgentType", () => {
    test("groups counts by agentType", async () => {
      await tracker.recordSubagentInvocation(makeInput({ agentType: "refactorer" }));
      await tracker.recordSubagentInvocation(makeInput({ agentType: "refactorer" }));
      await tracker.recordSubagentInvocation(makeInput({ agentType: "auditor" }));
      await tracker.recordSubagentInvocation(makeInput({ agentType: "general-purpose" }));

      const cadence = await tracker.getCadence();
      expect(cadence.byAgentType["refactorer"]).toBe(2);
      expect(cadence.byAgentType["auditor"]).toBe(1);
      expect(cadence.byAgentType["general-purpose"]).toBe(1);
    });

    test("byAgentType is empty for empty table", async () => {
      const cadence = await tracker.getCadence();
      expect(Object.keys(cadence.byAgentType)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — byHourLast24h
  // -------------------------------------------------------------------------

  describe("getCadence - byHourLast24h", () => {
    test("buckets rows by UTC hour within last 24h", async () => {
      // Insert 3 rows in hour 0 (BASE_DATE), 2 in hour -2, 1 in hour -5
      for (let i = 0; i < 3; i++) {
        await tracker.recordSubagentInvocation(makeInput({ startedAt: BASE_DATE }));
      }
      for (let i = 0; i < 2; i++) {
        await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(2) }));
      }
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(5) }));

      const cadence = await tracker.getCadence();
      expect(cadence.byHourLast24h.length).toBeGreaterThanOrEqual(1);

      // Find bucket for BASE_DATE's hour
      const baseHour = `${String(BASE_DATE.getUTCFullYear())}-${String(BASE_DATE.getUTCMonth() + 1).padStart(2, "0")}-${String(BASE_DATE.getUTCDate()).padStart(2, "0")}T${String(BASE_DATE.getUTCHours()).padStart(2, "0")}:00:00Z`;
      const baseBucket = cadence.byHourLast24h.find((b) => b.hour === baseHour);
      expect(baseBucket?.count).toBe(3);

      const twoHourAgoDate = hoursAgo(2);
      const twoHourHour = `${String(twoHourAgoDate.getUTCFullYear())}-${String(twoHourAgoDate.getUTCMonth() + 1).padStart(2, "0")}-${String(twoHourAgoDate.getUTCDate()).padStart(2, "0")}T${String(twoHourAgoDate.getUTCHours()).padStart(2, "0")}:00:00Z`;
      const twoBucket = cadence.byHourLast24h.find((b) => b.hour === twoHourHour);
      expect(twoBucket?.count).toBe(2);
    });

    test("excludes rows older than 24h from byHourLast24h", async () => {
      // Insert one row 25h ago (outside the window) and one in current hour
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(25) }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: BASE_DATE }));

      const cadence = await tracker.getCadence();
      // Total should be 2 (all-time, no time window)
      expect(cadence.total).toBe(2);
      // byHourLast24h should only include the current-hour bucket (1 row)
      const total24h = cadence.byHourLast24h.reduce((sum, b) => sum + b.count, 0);
      expect(total24h).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getEscalation
  // -------------------------------------------------------------------------

  describe("getEscalation", () => {
    test('returns "none" when table is empty', async () => {
      expect(await tracker.getEscalation()).toBe("none");
    });

    test('returns "none" below all thresholds (AT session threshold, not above)', async () => {
      // Insert exactly SESSION_PARTIAL_UNCOMMITTED_THRESHOLD rows in one session
      // AT threshold means NOT above, so escalation should not fire
      for (let i = 0; i < SESSION_PARTIAL_UNCOMMITTED_THRESHOLD; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: "session-A",
            startedAt: hoursAgo(1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("none");
    });

    test('returns "session" when partial-uncommitted exceeds session threshold', async () => {
      // Insert SESSION_PARTIAL_UNCOMMITTED_THRESHOLD + 1 rows in one session
      for (let i = 0; i <= SESSION_PARTIAL_UNCOMMITTED_THRESHOLD; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: "session-B",
            startedAt: hoursAgo(1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("session");
    });

    test('threshold: exactly 3 partial-uncommitted in one session → "session" (SESSION_THRESHOLD=2)', async () => {
      // Verify the concrete threshold used in tests (3 rows > threshold of 2)
      expect(SESSION_PARTIAL_UNCOMMITTED_THRESHOLD).toBe(2);
      for (let i = 0; i < 3; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: "session-C",
            startedAt: hoursAgo(1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("session");
    });

    test('returns "daily" when partial-uncommitted-no-handoff exceeds daily threshold in last 24h', async () => {
      // Insert DAILY_PARTIAL_UNCOMMITTED_THRESHOLD + 1 rows in last 24h
      // spread across different sessions to avoid session threshold triggering
      for (let i = 0; i <= DAILY_PARTIAL_UNCOMMITTED_THRESHOLD; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: `session-${i}`,
            startedAt: hoursAgo(i + 1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("daily");
    });

    test('threshold: 6 partial-uncommitted in last 24h → "daily" (DAILY_THRESHOLD=5)', async () => {
      expect(DAILY_PARTIAL_UNCOMMITTED_THRESHOLD).toBe(5);
      for (let i = 0; i < 6; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: `session-daily-${i}`,
            startedAt: hoursAgo(i + 1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("daily");
    });

    test('returns "daily" when rate-limited exceeds daily threshold in last 24h', async () => {
      // Insert DAILY_RATE_LIMITED_THRESHOLD + 1 rate-limited rows
      for (let i = 0; i <= DAILY_RATE_LIMITED_THRESHOLD; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_RATE_LIMITED,
            startedAt: hoursAgo(i + 1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("daily");
    });

    test('threshold: 4 rate-limited in last 24h → "daily" (RATE_LIMITED_THRESHOLD=3)', async () => {
      expect(DAILY_RATE_LIMITED_THRESHOLD).toBe(3);
      for (let i = 0; i < 4; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_RATE_LIMITED,
            startedAt: hoursAgo(i + 1),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("daily");
    });

    test("rows older than 24h do not count toward daily threshold", async () => {
      // Insert many partial-uncommitted rows older than 24h — should not trigger daily
      for (let i = 0; i < DAILY_PARTIAL_UNCOMMITTED_THRESHOLD + 5; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            startedAt: hoursAgo(25 + i),
          })
        );
      }
      expect(await tracker.getEscalation()).toBe("none");
    });

    test("session check only considers the most recent parentSessionId", async () => {
      // Session A (older, 26h ago — outside 24h window): above session threshold.
      // Using startedAt outside the 24h window ensures these rows don't affect
      // the daily threshold check, only the session check (which looks at all-time).
      // The session check looks at the most recent parentSessionId in the table,
      // so these older rows from "session-old" should NOT trigger session escalation
      // because "session-new" is the most recently seen session.
      for (let i = 0; i < SESSION_PARTIAL_UNCOMMITTED_THRESHOLD + 2; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: "session-old",
            startedAt: hoursAgo(26 + i), // outside 24h window
          })
        );
      }
      // Session B (newer): at or below session threshold for partial-uncommitted
      for (let i = 0; i < SESSION_PARTIAL_UNCOMMITTED_THRESHOLD; i++) {
        await tracker.recordSubagentInvocation(
          makeInput({
            outcome: OUTCOME_PARTIAL_UNCOMMITTED,
            parentSessionId: "session-new",
            startedAt: hoursAgo(1),
          })
        );
      }
      // Most recent parentSessionId is "session-new" (most recent startedAt)
      // Session check: "session-new" count = SESSION_THRESHOLD (AT, not above) → no session escalation
      // Daily check: only "session-new" rows are within 24h → 2 rows < DAILY_THRESHOLD(5) → no daily
      const result = await tracker.getEscalation();
      expect(result).toBe("none");
    });
  });

  // -------------------------------------------------------------------------
  // PR #1046 R1 BLOCKING #2 regression: byHourLast24h enforces UTC
  //
  // Postgres `date_trunc('hour', ts)` operates in the session time zone, not
  // UTC, even when the column type is `timestamp with time zone`. Without an
  // explicit `AT TIME ZONE 'UTC'` normalization, hour buckets shift on non-UTC
  // servers and DST boundaries produce incorrect counts. The fix wraps the
  // truncation in `AT TIME ZONE 'UTC' ... AT TIME ZONE 'UTC'`.
  //
  // We can't directly simulate a non-UTC session in this unit test (the fake
  // DB has no notion of session time zone). Instead, guard against accidental
  // removal of the fix via a source-text assertion: the production module
  // MUST contain `AT TIME ZONE 'UTC'` in the byHourLast24h query. If this
  // guard fires, the fix has been regressed and DST/non-UTC behavior breaks
  // in production.
  // -------------------------------------------------------------------------

  describe("byHourLast24h UTC enforcement (source-text regression guard)", () => {
    /* eslint-disable custom/no-real-fs-in-tests -- reading shipped source IS the point of the regression guard */
    const trackerSourcePath = join(import.meta.dir, "subagent-dispatch-tracker.ts");

    test("production source contains AT TIME ZONE 'UTC' (BLOCKING #2 fix)", () => {
      const src = readFileSync(trackerSourcePath).toString();
      // Must enforce UTC explicitly when truncating the timestamp.
      expect(src).toContain("AT TIME ZONE 'UTC'");
    });

    test("production source uses the hourExpr alias for groupBy/orderBy/select consistency", () => {
      const src = readFileSync(trackerSourcePath).toString();
      // The fix factors out the hour expression into a single `hourExpr`
      // constant used by select/groupBy/orderBy. Asserting on the variable
      // name catches accidental divergence between the three callsites.
      expect(src).toContain("const hourExpr =");
    });
    /* eslint-enable custom/no-real-fs-in-tests */
  });

  // -------------------------------------------------------------------------
  // Threshold constants (exported for easy tuning)
  // -------------------------------------------------------------------------

  describe("threshold constants", () => {
    test("SESSION_PARTIAL_UNCOMMITTED_THRESHOLD is exported and positive", () => {
      expect(typeof SESSION_PARTIAL_UNCOMMITTED_THRESHOLD).toBe("number");
      expect(SESSION_PARTIAL_UNCOMMITTED_THRESHOLD).toBeGreaterThan(0);
    });

    test("DAILY_PARTIAL_UNCOMMITTED_THRESHOLD is exported and positive", () => {
      expect(typeof DAILY_PARTIAL_UNCOMMITTED_THRESHOLD).toBe("number");
      expect(DAILY_PARTIAL_UNCOMMITTED_THRESHOLD).toBeGreaterThan(0);
    });

    test("DAILY_RATE_LIMITED_THRESHOLD is exported and positive", () => {
      expect(typeof DAILY_RATE_LIMITED_THRESHOLD).toBe("number");
      expect(DAILY_RATE_LIMITED_THRESHOLD).toBeGreaterThan(0);
    });
  });
});
