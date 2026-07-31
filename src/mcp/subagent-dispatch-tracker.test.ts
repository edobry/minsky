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
  UNKNOWN_AGENT_TYPE,
  UNKNOWN_TASK_ID,
  type SubagentInvocationInput,
} from "./subagent-dispatch-tracker";
import type { SubagentInvocationOutcome } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import {
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
  subagentInvocationsTable,
} from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { NoopEventEmitter } from "@minsky/domain/events/emitter";

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
  resumedFromInvocationId: string | null;
  attemptNumber: number;
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
    resumedFromInvocationId: input.resumedFromInvocationId ?? null,
    attemptNumber: input.attemptNumber ?? 1,
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
  ended_at: "endedAt",
  parent_session_id: "parentSessionId",
  subagent_session_id: "subagentSessionId",
  agent_type: "agentType",
  task_id: "taskId",
  session_id: "sessionId",
  actual_model: "actualModel",
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

  // IS NULL: `"table"."col" is null` (mt#2831 — isNull(endedAt) in the
  // heuristic upsert target selector). Checked after IS NOT NULL above so a
  // literal "is not null" clause is never mis-parsed here.
  const isNullMatch = clause.match(/"[^"]+"\."([^"]+)" is null/i);
  if (isNullMatch) {
    const colName = isNullMatch[1];
    if (!colName) {
      throw new Error(`parseWhere: malformed IS NULL clause: ${clause}`);
    }
    const field = COLUMN_TO_FIELD[colName];
    if (!field) {
      throw new Error(`parseWhere: unknown column in IS NULL clause: ${colName}`);
    }
    return (row) => row[field] == null;
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
    // mt#2831 R1 NB #4: `getInvocationChainForTask` orders ASC (bare column, no
    // `desc()` wrapper) while every pre-existing caller orders DESC — the fake must
    // distinguish direction, not always assume DESC. `null` = no orderBy called.
    orderDirection: "asc" | "desc" | null;
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
      orderBy(col: unknown) {
        // Identity check: every production callsite orders by either the bare
        // `subagentInvocationsTable.startedAt` column (ASC — drizzle's default
        // when a column is passed unwrapped) or `desc(subagentInvocationsTable.startedAt)`
        // (a distinct wrapper object). Bare-column reference is the ONLY case that
        // means ascending across this file's callers.
        ctx.orderDirection = col === subagentInvocationsTable.startedAt ? "asc" : "desc";
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
    if ("model" in selectedFields) {
      return (row) => row.actualModel ?? "";
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
        if ("model" in ctx.selectedFields && firstRow) entry.model = firstRow.actualModel;
        if ("hour" in ctx.selectedFields) entry.hour = key;
        result.push(entry);
      }
      return result;
    }

    // Apply orderBy — startedAt, ASC or DESC per the identity check in orderBy() above.
    if (ctx.orderDirection === "desc") {
      rs = [...rs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    } else if (ctx.orderDirection === "asc") {
      rs = [...rs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
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
        orderDirection: null,
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
            // mt#2831: recordDispatchRecoveryAttempt calls `.returning({ id: ... })`
            // after `.values(...)`. The fake ignores the requested field shape and
            // always returns the row's real id — sufficient for the tests that use it.
            returning(_fields?: unknown): Promise<Array<{ id: string }>> {
              return Promise.resolve([{ id: row.id }]);
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

// Fixed reference "now" for this suite. All getCadence()/getEscalation()
// calls below pass this explicitly as the injected clock (mt#2654) — the
// tracker's 24h-window cutoffs are computed relative to whatever `now` is
// passed in, so pinning it here makes every assertion independent of the
// real wall clock. Without this, a hardcoded BASE_DATE compared against
// `new Date()` (real time) inside the tracker silently drifts out of the
// "last 24h" window as real time advances past BASE_DATE + 24h, producing
// date-dependent test failures unrelated to any code change.
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

/**
 * mt#2831: `recordSubagentInvocation` returns void, but several retry-linkage tests need the
 * freshly-inserted row's id (to pass as `resumedFromInvocationId` to a follow-up
 * `recordDispatchRecoveryAttempt` call). Records the input, then reads back the row via
 * `getLatestInvocationForTask` — safe in these tests because each caller uses a distinct
 * `taskId`/`startedAt` per call so "most recent" is unambiguous.
 */
async function recordAndGetId(
  tracker: SubagentDispatchTracker,
  input: SubagentInvocationInput
): Promise<string> {
  await tracker.recordSubagentInvocation(input);
  const row = await tracker.getLatestInvocationForTask(input.taskId);
  if (!row) throw new Error(`recordAndGetId: no row found for taskId ${input.taskId}`);
  return row.id;
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

    // ─── mt#2653 regression: SubagentStop upsert must not clobber the real
    // dispatch-time agentType with the "unknown" sentinel ───
    test("upsert UPDATE preserves dispatch-time agentType when the caller sends the unknown sentinel", async () => {
      // First call: dispatch-time INSERT with the real agentType (mirrors
      // src/adapters/shared/commands/tasks/dispatch-command.ts's pending-row write).
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "agent-type-preserve-test",
          agentType: "refactorer",
          outcome: OUTCOME_CRASHED, // pessimistic dispatch-time default
        })
      );
      expect(store.size).toBe(1);
      expect(Array.from(store.values())[0]?.agentType).toBe("refactorer");

      // Second call: SubagentStop-style upsert that only knows the "unknown"
      // sentinel (mirrors .claude/hooks/record-subagent-invocation.ts, which
      // has no way to recover the real dispatch-time agentType from the
      // workspace alone). Before mt#2653 this unconditionally clobbered the
      // real value with "unknown".
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "agent-type-preserve-test",
          agentType: UNKNOWN_AGENT_TYPE,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          prUrl: "https://example.com/pr/2",
        })
      );

      expect(store.size).toBe(1);
      const row = Array.from(store.values())[0];
      // The dispatch-time agentType MUST survive the upsert.
      expect(row?.agentType).toBe("refactorer");
      // Other fields DID update, proving this isn't a no-op UPDATE.
      expect(row?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
      expect(row?.prUrl).toBe("https://example.com/pr/2");
    });

    // ─── mt#3019 regression: SubagentStop upsert must not clobber the real
    // dispatch-time taskId with the "unknown" sentinel ───
    test("upsert UPDATE preserves dispatch-time taskId when the caller sends the unknown sentinel", async () => {
      // Dispatch-time INSERT carries the real task ID.
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "task-id-preserve-test",
          taskId: "mt#3019",
          agentType: "implementer",
          outcome: OUTCOME_CRASHED,
        })
      );
      expect(store.size).toBe(1);
      expect(Array.from(store.values())[0]?.taskId).toBe("mt#3019");

      // SubagentStop-style upsert from a hook that could NOT resolve the task
      // ID (workspace gone, branch unreadable, session lookup failed). Before
      // mt#3019 the hook's only options were to invent a placeholder — which
      // this UPDATE path would have written over "mt#3019" — or to drop the
      // write entirely, which is what it did (the mt#2315 bug).
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "task-id-preserve-test",
          taskId: UNKNOWN_TASK_ID,
          agentType: UNKNOWN_AGENT_TYPE,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          prUrl: "https://example.com/pr/3",
        })
      );

      expect(store.size).toBe(1);
      const row = Array.from(store.values())[0];
      // The dispatch-time taskId MUST survive the upsert.
      expect(row?.taskId).toBe("mt#3019");
      // Other fields DID update, proving this isn't a no-op UPDATE — this is
      // the whole point: the Stop event's real information still lands.
      expect(row?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
      expect(row?.prUrl).toBe("https://example.com/pr/3");
    });

    test("upsert UPDATE still applies a real (non-sentinel) taskId", async () => {
      // The fix special-cases ONLY the sentinel: a caller that genuinely knows
      // a corrected task ID at update time must still be able to write it.
      await tracker.recordSubagentInvocation(
        makeInput({ subagentSessionId: "task-id-real-update-test", taskId: "mt#1000" })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ subagentSessionId: "task-id-real-update-test", taskId: "mt#2000" })
      );

      expect(store.size).toBe(1);
      expect(Array.from(store.values())[0]?.taskId).toBe("mt#2000");
    });

    test("INSERT path writes the sentinel taskId (satisfies the NOT NULL column)", async () => {
      // An orphan Stop with no matching dispatch row still has to insert
      // SOMETHING for task_id — the column is NOT NULL. The sentinel is that
      // something, and it must reach the row rather than being dropped.
      await tracker.recordSubagentInvocation(
        makeInput({ subagentSessionId: "task-id-orphan-insert-test", taskId: UNKNOWN_TASK_ID })
      );

      expect(store.size).toBe(1);
      expect(Array.from(store.values())[0]?.taskId).toBe(UNKNOWN_TASK_ID);
    });

    test("upsert UPDATE still applies a real (non-sentinel) agentType", async () => {
      // A caller that genuinely knows a corrected/refined agentType at
      // update time (not the "unknown" sentinel) should still be able to
      // update it — the fix only special-cases the sentinel value.
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "agent-type-real-update-test",
          agentType: "general-purpose",
        })
      );
      await tracker.recordSubagentInvocation(
        makeInput({
          subagentSessionId: "agent-type-real-update-test",
          agentType: "auditor",
        })
      );
      expect(store.size).toBe(1);
      expect(Array.from(store.values())[0]?.agentType).toBe("auditor");
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
      const cadence = await tracker.getCadence(BASE_DATE);
      expect(cadence.total).toBe(0);
      expect(cadence.lastDispatch).toBeNull();
    });

    test("returns correct total after inserts", async () => {
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(2) }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: hoursAgo(1) }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: BASE_DATE }));
      const cadence = await tracker.getCadence(BASE_DATE);
      expect(cadence.total).toBe(3);
    });

    test("lastDispatch is the most recent startedAt", async () => {
      const older = hoursAgo(5);
      const newer = hoursAgo(1);
      await tracker.recordSubagentInvocation(makeInput({ startedAt: older }));
      await tracker.recordSubagentInvocation(makeInput({ startedAt: newer }));
      const cadence = await tracker.getCadence(BASE_DATE);
      expect(cadence.lastDispatch).toBe(newer.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — byOutcome
  // -------------------------------------------------------------------------

  describe("getCadence - byOutcome", () => {
    test("all 6 outcome classes present with zero counts for empty table", async () => {
      const cadence = await tracker.getCadence(BASE_DATE);
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
      const cadence = await tracker.getCadence(BASE_DATE);
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

      const cadence = await tracker.getCadence(BASE_DATE);
      expect(cadence.byAgentType["refactorer"]).toBe(2);
      expect(cadence.byAgentType["auditor"]).toBe(1);
      expect(cadence.byAgentType["general-purpose"]).toBe(1);
    });

    test("byAgentType is empty for empty table", async () => {
      const cadence = await tracker.getCadence(BASE_DATE);
      expect(Object.keys(cadence.byAgentType)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getCadence — byModel (mt#2796)
  // -------------------------------------------------------------------------

  describe("getCadence - byModel", () => {
    test("groups counts by actualModel, excluding null", async () => {
      await tracker.recordSubagentInvocation(makeInput({ actualModel: "claude-sonnet-5" }));
      await tracker.recordSubagentInvocation(makeInput({ actualModel: "claude-sonnet-5" }));
      await tracker.recordSubagentInvocation(makeInput({ actualModel: "claude-opus-4-8" }));
      // No actualModel — not yet Stop-classified. Must not appear in byModel.
      await tracker.recordSubagentInvocation(makeInput());

      const cadence = await tracker.getCadence(BASE_DATE);
      expect(cadence.byModel["claude-sonnet-5"]).toBe(2);
      expect(cadence.byModel["claude-opus-4-8"]).toBe(1);
      expect(Object.keys(cadence.byModel)).toHaveLength(2);
    });

    test("byModel is empty for empty table", async () => {
      const cadence = await tracker.getCadence(BASE_DATE);
      expect(Object.keys(cadence.byModel)).toHaveLength(0);
    });

    test("byModel is empty when no row has a classified actualModel", async () => {
      await tracker.recordSubagentInvocation(makeInput());
      await tracker.recordSubagentInvocation(makeInput());

      const cadence = await tracker.getCadence(BASE_DATE);
      expect(Object.keys(cadence.byModel)).toHaveLength(0);
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

      const cadence = await tracker.getCadence(BASE_DATE);
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

      const cadence = await tracker.getCadence(BASE_DATE);
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("none");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("none");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("session");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("session");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("daily");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("daily");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("daily");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("daily");
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
      expect(await tracker.getEscalation(BASE_DATE)).toBe("none");
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
      const result = await tracker.getEscalation(BASE_DATE);
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

  // -------------------------------------------------------------------------
  // Dispatch-recovery retry linkage (mt#2831)
  // -------------------------------------------------------------------------

  describe("dispatch-recovery retry linkage (mt#2831)", () => {
    test("getLatestInvocationForTask returns null for a task with no rows", async () => {
      const result = await tracker.getLatestInvocationForTask("mt#9999");
      expect(result).toBeNull();
    });

    test("getLatestInvocationForTask returns the most recently started row", async () => {
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(2), outcome: OUTCOME_CRASHED })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(1), outcome: OUTCOME_COMMITTED_NO_PR })
      );
      const result = await tracker.getLatestInvocationForTask("mt#2831");
      expect(result?.outcome).toBe(OUTCOME_COMMITTED_NO_PR);
    });

    test("getInvocationChainForTask returns every row for the task, none for others", async () => {
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(3) })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(2) })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#0001", startedAt: hoursAgo(1) })
      );
      const chain = await tracker.getInvocationChainForTask("mt#2831");
      expect(chain).toHaveLength(2);
      expect(chain.every((row) => row.taskId === "mt#2831")).toBe(true);
    });

    test("getInvocationChainForTask returns rows oldest -> newest (ordering contract, mt#2831 R1 NB #4)", async () => {
      // Insert deliberately OUT of chronological order — the method's contract is
      // "always ASC by startedAt", not "insertion order". Each row is INSERT-only
      // (no shared subagentSessionId, so no upsert collision) and distinguished by
      // its own attemptNumber, read back via the chain itself rather than via
      // per-insert id capture (which would be ambiguous here — recordAndGetId's
      // "most recently started row" lookup would keep re-matching whichever row
      // happens to have the latest startedAt across these deliberately-reordered
      // inserts, not necessarily the one just written).
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(1), attemptNumber: 2 })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(3), attemptNumber: 1 })
      );
      await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", startedAt: hoursAgo(0.5), attemptNumber: 3 })
      );

      const chain = await tracker.getInvocationChainForTask("mt#2831");

      expect(chain).toHaveLength(3);
      expect(chain.map((row) => row.attemptNumber)).toEqual([1, 2, 3]);
      // chain[0] is always the original (oldest startedAt); chain[chain.length - 1]
      // is always the most recent attempt.
      expect(chain[0]?.attemptNumber).toBe(1);
      expect(chain[chain.length - 1]?.attemptNumber).toBe(3);
      // Monotonic startedAt ASC across the whole array — the actual contract.
      for (let i = 1; i < chain.length; i++) {
        const prev = chain[i - 1];
        const curr = chain[i];
        expect(prev && curr && curr.startedAt.getTime() >= prev.startedAt.getTime()).toBe(true);
      }
    });

    test("recordDispatchRecoveryAttempt INSERTs a NEW row rather than upserting over the original", async () => {
      const originalId = await recordAndGetId(
        tracker,
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: "shared-session",
          outcome: OUTCOME_CRASHED,
          startedAt: hoursAgo(1),
        })
      );

      const resumedId = await tracker.recordDispatchRecoveryAttempt({
        taskId: "mt#2831",
        subagentSessionId: "shared-session",
        agentType: "implementer",
        outcome: OUTCOME_COMMITTED_NO_PR,
        startedAt: BASE_DATE,
        resumedFromInvocationId: originalId,
        attemptNumber: 2,
      });

      expect(resumedId).not.toBeNull();
      expect(resumedId).not.toBe(originalId);

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      expect(chain).toHaveLength(2);
      const resumedRow = chain.find((row) => row.id === resumedId);
      expect(resumedRow?.attemptNumber).toBe(2);
      expect((resumedRow as unknown as FakeRow).resumedFromInvocationId).toBe(originalId);

      // The original row is untouched — a plain insert, not an upsert clobber.
      const originalRow = chain.find((row) => row.id === originalId);
      expect(originalRow?.outcome).toBe(OUTCOME_CRASHED);
    });

    test("recordSubagentInvocation upsert targets the MOST RECENT row when a subagentSessionId has multiple rows", async () => {
      const SHARED_SESSION_ID = "shared-session-2";
      const originalId = await recordAndGetId(
        tracker,
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_CRASHED,
          startedAt: hoursAgo(2),
        })
      );
      const resumedId = await tracker.recordDispatchRecoveryAttempt({
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: "implementer",
        outcome: OUTCOME_CRASHED,
        startedAt: hoursAgo(1),
        resumedFromInvocationId: originalId,
        attemptNumber: 2,
      });

      // A later upsert (e.g. the SubagentStop hook classifying the resumed attempt)
      // must land on the RESUMED row, not the original — this is the ordering fix
      // (orderBy startedAt DESC before limit(1) in the upsert's SELECT).
      await tracker.recordSubagentInvocation(
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          startedAt: BASE_DATE,
        })
      );

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      const original = chain.find((row) => row.id === originalId);
      const resumed = chain.find((row) => row.id === resumedId);
      expect(original?.outcome).toBe(OUTCOME_CRASHED);
      expect(resumed?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic attribution (mt#2831 R1 BLOCKING #1)
  //
  // PR #2028 R1 finding: after a recovery insert, the subagentSessionId-keyed
  // upsert's "most recent row" selection can attribute a Stop-time update to
  // the WRONG invocation row — e.g. a delayed SubagentStop event for the
  // ORIGINAL attempt, arriving AFTER a RESUMED attempt's row was already
  // inserted, would land on the (more recently started) resumed row instead
  // of the original one it actually describes.
  // -------------------------------------------------------------------------

  describe("deterministic attribution (mt#2831 R1 BLOCKING #1)", () => {
    test("strong binding via `id`: a late Stop event for the ORIGINAL updates the ORIGINAL row, not the newer RESUMED row it would otherwise match by subagentSessionId recency", async () => {
      const SHARED_SESSION_ID = "attribution-session-1";

      // Original dispatch (attempt 1), still open (endedAt null — it went
      // silent without a normal Stop classification, which is WHY it was
      // recovered).
      const originalId = await recordAndGetId(
        tracker,
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_CRASHED,
          startedAt: hoursAgo(2),
        })
      );

      // Recovery closes the original (mirrors dispatch-recover-command.ts's
      // fix: the recover command now UPDATEs the original row by id — via
      // the SAME strong-binding path this test exercises — before inserting
      // the resumed row) and inserts the resumed attempt, which starts LATER
      // than the original (so a subagentSessionId + startedAt-DESC lookup
      // would prefer it).
      await tracker.recordSubagentInvocation({
        id: originalId,
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: "implementer",
        outcome: OUTCOME_PARTIAL_UNCOMMITTED,
        startedAt: hoursAgo(2),
        endedAt: hoursAgo(1.5),
      });
      const resumedId = await tracker.recordDispatchRecoveryAttempt({
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: "implementer",
        outcome: OUTCOME_CRASHED,
        startedAt: hoursAgo(1),
        resumedFromInvocationId: originalId,
        attemptNumber: 2,
      });

      // The ORIGINAL process's real (late) Stop event finally arrives — mirrors
      // `.claude/hooks/record-subagent-invocation.ts` reading a current-invocation
      // marker that still names the ORIGINAL id (written at dispatch time, not
      // yet overwritten from this process's own perspective) and passing it
      // through as `id`. This is the exact "original dies late AFTER the
      // resumed row was inserted" scenario.
      await tracker.recordSubagentInvocation({
        id: originalId,
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: UNKNOWN_AGENT_TYPE,
        outcome: OUTCOME_COMPLETED_WITH_PR,
        startedAt: hoursAgo(2),
        endedAt: BASE_DATE,
        prUrl: "https://github.com/edobry/minsky/pull/9999",
      });

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      const original = chain.find((row) => row.id === originalId);
      const resumed = chain.find((row) => row.id === resumedId);

      // The late Stop event landed on the ORIGINAL row (its real outcome +
      // prUrl), not the resumed row.
      expect(original?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
      expect((original as unknown as FakeRow)?.prUrl).toBe(
        "https://github.com/edobry/minsky/pull/9999"
      );
      // The resumed row is UNTOUCHED by the original's late Stop event.
      expect(resumed?.outcome).toBe(OUTCOME_CRASHED);
      expect((resumed as unknown as FakeRow)?.prUrl).toBeNull();
    });

    test("heuristic fallback: once the original is closed (endedAt set) at recovery time, a marker-less Stop update lands on the OPEN resumed row, not the closed original", async () => {
      const SHARED_SESSION_ID = "attribution-session-2";

      const originalId = await recordAndGetId(
        tracker,
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_CRASHED,
          startedAt: hoursAgo(2),
        })
      );
      // Recovery closes the original...
      await tracker.recordSubagentInvocation({
        id: originalId,
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: "implementer",
        outcome: OUTCOME_PARTIAL_UNCOMMITTED,
        startedAt: hoursAgo(2),
        endedAt: hoursAgo(1.5),
      });
      // ...and inserts the (still OPEN — no endedAt) resumed row.
      const resumedId = await tracker.recordDispatchRecoveryAttempt({
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: "implementer",
        outcome: OUTCOME_CRASHED,
        startedAt: hoursAgo(1),
        resumedFromInvocationId: originalId,
        attemptNumber: 2,
      });

      // A caller with NO id available (e.g. a pre-mt#2831 marker-less
      // session) upserts by subagentSessionId alone. The heuristic's
      // open-row-first pass must select the resumed row (the only open one),
      // not fall back to most-recent-overall (which would still be correct
      // here since resumed IS also most recent — see the next assertion for
      // the case that distinguishes them).
      await tracker.recordSubagentInvocation(
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_COMPLETED_WITH_PR,
          startedAt: hoursAgo(1),
        })
      );

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      const original = chain.find((row) => row.id === originalId);
      const resumed = chain.find((row) => row.id === resumedId);
      expect(original?.outcome).toBe(OUTCOME_PARTIAL_UNCOMMITTED);
      expect(resumed?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
    });

    test("strong binding falls through to the heuristic path when the supplied `id` matches no row (stale/missing marker)", async () => {
      const SHARED_SESSION_ID = "attribution-session-3";
      const originalId = await recordAndGetId(
        tracker,
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: SHARED_SESSION_ID,
          outcome: OUTCOME_CRASHED,
          startedAt: hoursAgo(1),
        })
      );

      await tracker.recordSubagentInvocation({
        id: "nonexistent-invocation-id",
        taskId: "mt#2831",
        subagentSessionId: SHARED_SESSION_ID,
        agentType: UNKNOWN_AGENT_TYPE,
        outcome: OUTCOME_COMPLETED_WITH_PR,
        startedAt: hoursAgo(1),
        endedAt: BASE_DATE,
      });

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      expect(chain).toHaveLength(1);
      expect(chain[0]?.id).toBe(originalId);
      expect(chain[0]?.outcome).toBe(OUTCOME_COMPLETED_WITH_PR);
    });

    test("recordSubagentInvocation returns the persisted row's id on both INSERT and UPDATE", async () => {
      const insertedId = await tracker.recordSubagentInvocation(
        makeInput({ taskId: "mt#2831", subagentSessionId: "attribution-session-4" })
      );
      expect(typeof insertedId).toBe("string");

      const updatedId = await tracker.recordSubagentInvocation(
        makeInput({
          taskId: "mt#2831",
          subagentSessionId: "attribution-session-4",
          outcome: OUTCOME_COMPLETED_WITH_PR,
        })
      );
      expect(updatedId).toBe(insertedId);
    });

    // mt#2831 R1 NB #5: `attemptNumber` is `NOT NULL DEFAULT 1` at the DB level
    // (packages/domain/src/storage/schemas/subagent-invocations-schema.ts) — a real
    // Postgres row can never read back null/undefined here. This fake-store
    // equivalent proves the SAME "missing means 1" contract holds through the whole
    // read path (getLatestInvocationForTask / getInvocationChainForTask) when a row
    // is constructed WITHOUT an explicit attemptNumber, mirroring what the DB
    // default backfill guarantees for any pre-mt#2831 row.
    test("a row constructed without an explicit attemptNumber defaults to 1 through the read path", async () => {
      // Deliberately bypass makeInput's own `attemptNumber` handling by inserting via
      // the tracker with a plain SubagentInvocationInput that has no `attemptNumber`
      // key at all — this is what every dispatch.tasks Step-5 write (pre-dating
      // mt#2831's retry-linkage columns) looks like.
      const plainInput: SubagentInvocationInput = {
        taskId: "mt#2831",
        subagentSessionId: "attempt-number-default-test",
        agentType: "implementer",
        outcome: OUTCOME_CRASHED,
        startedAt: BASE_DATE,
      };
      expect("attemptNumber" in plainInput).toBe(false);

      await tracker.recordSubagentInvocation(plainInput);

      const latest = await tracker.getLatestInvocationForTask("mt#2831");
      expect(latest?.attemptNumber).toBe(1);

      const chain = await tracker.getInvocationChainForTask("mt#2831");
      expect(chain[0]?.attemptNumber).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// System event emission (mt#2487)
//
// subagent.completed fires on success outcomes, co-located with the existing
// subagent.failed branch; the two are mutually exclusive, and rate-limited
// emits neither. Emission is best-effort — a missing emitter must not break
// the row write.
// ---------------------------------------------------------------------------

describe("SubagentDispatchTracker — system event emission (mt#2487)", () => {
  let store: Map<string, FakeRow>;
  let emitter: NoopEventEmitter;
  let tracker: SubagentDispatchTracker;

  beforeEach(() => {
    store = new Map<string, FakeRow>();
    nextId = 1;
    emitter = new NoopEventEmitter();
    tracker = new SubagentDispatchTracker(makeFakeDb(store), emitter);
  });

  // Shared event-type literals (custom/no-magic-string-duplication).
  const SUBAGENT_COMPLETED_EVENT = "subagent.completed";
  const SUBAGENT_FAILED_EVENT = "subagent.failed";

  const SUCCESS_OUTCOMES: SubagentInvocationOutcome[] = [
    OUTCOME_COMPLETED_WITH_PR,
    OUTCOME_COMMITTED_NO_PR,
    OUTCOME_PARTIAL_COMMITTED_HANDOFF,
  ];
  const FAILURE_OUTCOMES: SubagentInvocationOutcome[] = [
    OUTCOME_CRASHED,
    OUTCOME_PARTIAL_UNCOMMITTED,
  ];

  for (const outcome of SUCCESS_OUTCOMES) {
    test(`emits subagent.completed for success outcome "${outcome}"`, async () => {
      await tracker.recordSubagentInvocation(
        makeInput({ outcome, taskId: "mt#900", agentType: "refactorer", parentSessionId: "ps-1" })
      );
      const completed = emitter.emitted.filter((e) => e.eventType === SUBAGENT_COMPLETED_EVENT);
      expect(completed.length).toBe(1);
      expect(completed[0]?.payload).toEqual({
        taskId: "mt#900",
        agentType: "refactorer",
        outcome,
      });
      expect(completed[0]?.relatedTaskId).toBe("mt#900");
      expect(completed[0]?.relatedSessionId).toBe("ps-1");
      // Mutually exclusive with the failure branch.
      expect(emitter.emitted.some((e) => e.eventType === SUBAGENT_FAILED_EVENT)).toBe(false);
    });
  }

  for (const outcome of FAILURE_OUTCOMES) {
    test(`emits subagent.failed (not completed) for failure outcome "${outcome}"`, async () => {
      await tracker.recordSubagentInvocation(makeInput({ outcome }));
      expect(emitter.emitted.some((e) => e.eventType === SUBAGENT_FAILED_EVENT)).toBe(true);
      expect(emitter.emitted.some((e) => e.eventType === SUBAGENT_COMPLETED_EVENT)).toBe(false);
    });
  }

  test("emits neither completed nor failed for rate-limited", async () => {
    await tracker.recordSubagentInvocation(makeInput({ outcome: OUTCOME_RATE_LIMITED }));
    expect(emitter.emitted.length).toBe(0);
  });

  test("records the row even with no event emitter wired (emit is best-effort/optional)", async () => {
    const noEmitterTracker = new SubagentDispatchTracker(makeFakeDb(store));
    await noEmitterTracker.recordSubagentInvocation(
      makeInput({ outcome: OUTCOME_COMPLETED_WITH_PR })
    );
    expect(store.size).toBe(1);
  });

  // ─── mt#2653 R1 regression: the EMITTED event must carry the PERSISTED
  // agentType, mirroring the DB-preservation test above at the event layer.
  // Before this fix, the DB row correctly preserved the dispatch-time
  // agentType (mt#2653), but the emitted event still read `input.agentType`
  // directly — reporting "unknown" for the very same upsert that kept the
  // DB row's real value, a DB-vs-telemetry divergence. ───
  test("emitted subagent.completed event carries the dispatch-time agentType after a SubagentStop-style upsert", async () => {
    // Dispatch-time INSERT with the real agentType (mirrors
    // dispatch-command.ts's pending-row write). Outcome is a FAILURE class
    // (the pessimistic dispatch-time default) so this call emits
    // subagent.failed, not subagent.completed.
    await tracker.recordSubagentInvocation(
      makeInput({
        subagentSessionId: "event-agent-type-preserve-test",
        agentType: "refactorer",
        outcome: OUTCOME_CRASHED,
        taskId: "mt#901",
        parentSessionId: "ps-2",
      })
    );

    // SubagentStop-style upsert with the UNKNOWN_AGENT_TYPE sentinel (mirrors
    // .claude/hooks/record-subagent-invocation.ts, which has no way to
    // recover the real dispatch-time agentType). Outcome is a SUCCESS class,
    // so this call emits subagent.completed.
    await tracker.recordSubagentInvocation(
      makeInput({
        subagentSessionId: "event-agent-type-preserve-test",
        agentType: UNKNOWN_AGENT_TYPE,
        outcome: OUTCOME_COMPLETED_WITH_PR,
        taskId: "mt#901",
        parentSessionId: "ps-2",
      })
    );

    const completed = emitter.emitted.filter((e) => e.eventType === SUBAGENT_COMPLETED_EVENT);
    expect(completed.length).toBe(1);
    expect(completed[0]?.payload).toEqual({
      taskId: "mt#901",
      // The persisted/dispatch-time value — NOT "unknown" — even though the
      // second call's `input.agentType` was the sentinel.
      agentType: "refactorer",
      outcome: OUTCOME_COMPLETED_WITH_PR,
    });

    // The first call's failure-outcome event carries the real agentType too
    // (it was the direct INSERT value, not routed through the sentinel path).
    const failed = emitter.emitted.filter((e) => e.eventType === SUBAGENT_FAILED_EVENT);
    expect(failed.length).toBe(1);
    expect(failed[0]?.payload).toMatchObject({ agentType: "refactorer" });
  });

  // ─── mt#3019 / PR #2178 R1 BLOCKING #2: the same divergence, for taskId.
  // The DB row preserves the dispatch-time task_id when the caller sends the
  // sentinel; the emitted event must not report "unknown" for that same
  // upsert, and must never publish the sentinel as a related-entity key —
  // consumers (the dispatch watchdog's `WHERE related_task_id = $1`) read it
  // as a real task id. ───
  test("emitted event carries the dispatch-time taskId after a sentinel upsert", async () => {
    await tracker.recordSubagentInvocation(
      makeInput({
        subagentSessionId: "event-task-id-preserve-test",
        taskId: "mt#3019",
        agentType: "implementer",
        outcome: OUTCOME_CRASHED,
        parentSessionId: "ps-3",
      })
    );

    await tracker.recordSubagentInvocation(
      makeInput({
        subagentSessionId: "event-task-id-preserve-test",
        taskId: UNKNOWN_TASK_ID,
        agentType: UNKNOWN_AGENT_TYPE,
        outcome: OUTCOME_COMPLETED_WITH_PR,
        parentSessionId: "ps-3",
      })
    );

    const completed = emitter.emitted.filter((e) => e.eventType === SUBAGENT_COMPLETED_EVENT);
    expect(completed.length).toBe(1);
    expect(completed[0]?.payload).toMatchObject({ taskId: "mt#3019" });
    expect(completed[0]?.relatedTaskId).toBe("mt#3019");
  });

  test("an orphan-INSERT sentinel row emits no relatedTaskId at all", async () => {
    // No prior dispatch row to recover a real task id from, so the sentinel is
    // all there is. Publishing it as `related_task_id` would put a row keyed
    // on the literal string "unknown" into the events table.
    await tracker.recordSubagentInvocation(
      makeInput({
        subagentSessionId: "event-task-id-orphan-test",
        taskId: UNKNOWN_TASK_ID,
        agentType: UNKNOWN_AGENT_TYPE,
        outcome: OUTCOME_CRASHED,
      })
    );

    const failed = emitter.emitted.filter((e) => e.eventType === SUBAGENT_FAILED_EVENT);
    expect(failed.length).toBe(1);
    expect(failed[0]?.relatedTaskId).toBeUndefined();
  });
});
