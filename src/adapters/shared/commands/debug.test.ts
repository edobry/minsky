/**
 * debug.systemInfo subagentDispatches surface tests (mt#1738)
 *
 * Verifies:
 *   - 20 fixture rows in the DB → debug.systemInfo returns correct
 *     subagentDispatches.byOutcome aggregates.
 *   - 3 partial-uncommitted-no-handoff rows in one session →
 *     debug.systemInfo.subagentDispatches.escalation === "session".
 *   - When no tracker is set (null DB path), subagentDispatches has
 *     zero-filled aggregates and escalation === "none".
 *
 * Test approach:
 *   - Reuses the same fake-DB pattern from subagent-dispatch-tracker.test.ts.
 *   - Seeds the fake DB by calling tracker.recordSubagentInvocation() (avoids
 *     reaching into internal store structure).
 *   - Injects the tracker via SubagentDispatchTracker.resetForTest(fakeDb)
 *     before each test, restores the singleton to null after each test.
 *   - Calls the debug.systemInfo execute handler directly (no MCP transport).
 *
 * @see mt#1738 — this test
 * @see src/adapters/shared/commands/debug.ts — implementation under test
 * @see src/mcp/subagent-dispatch-tracker.ts — tracker implementation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { SubagentDispatchTracker } from "../../../mcp/subagent-dispatch-tracker";
import type { SubagentInvocationInput } from "../../../mcp/subagent-dispatch-tracker";
import type { SubagentInvocationOutcome } from "../../../domain/storage/schemas/subagent-invocations-schema";
import { SUBAGENT_INVOCATION_OUTCOME_VALUES } from "../../../domain/storage/schemas/subagent-invocations-schema";
import { registerDebugCommands } from "./debug";
import { sharedCommandRegistry } from "../command-registry";

// ---------------------------------------------------------------------------
// Outcome class constants
// ---------------------------------------------------------------------------

const OUTCOME_COMPLETED_WITH_PR: SubagentInvocationOutcome = "completed-with-pr";
const OUTCOME_COMMITTED_NO_PR: SubagentInvocationOutcome = "committed-no-pr";
const OUTCOME_PARTIAL_COMMITTED_HANDOFF: SubagentInvocationOutcome =
  "partial-committed-handoff-written";
const OUTCOME_PARTIAL_UNCOMMITTED: SubagentInvocationOutcome = "partial-uncommitted-no-handoff";
const OUTCOME_CRASHED: SubagentInvocationOutcome = "crashed-no-output";
const OUTCOME_RATE_LIMITED: SubagentInvocationOutcome = "rate-limited";

// ---------------------------------------------------------------------------
// Row type + ID counter (mirrors subagent-dispatch-tracker.test.ts)
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
// WHERE clause evaluator (mirrors subagent-dispatch-tracker.test.ts)
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

function renderCondition(condition: unknown): { sqlStr: string; params: unknown[] } {
  try {
    const rendered = pgDialect.sqlToQuery(
      sql`SELECT 1 WHERE ${condition as Parameters<typeof sql>[0]}`
    );
    return { sqlStr: rendered.sql, params: rendered.params };
  } catch {
    return { sqlStr: "", params: [] };
  }
}

function buildPredicate(condition: unknown): (row: FakeRow) => boolean {
  if (!condition) {
    throw new Error("buildPredicate: condition is null/undefined");
  }
  const { sqlStr, params } = renderCondition(condition);
  if (!sqlStr) {
    throw new Error("buildPredicate: PgDialect could not render condition");
  }
  const whereIdx = sqlStr.toUpperCase().indexOf("WHERE");
  const whereClause = whereIdx >= 0 ? sqlStr.slice(whereIdx + 5).trim() : sqlStr;
  return parseWhere(whereClause, params);
}

function parseWhere(clause: string, params: unknown[]): (row: FakeRow) => boolean {
  clause = clause.trim();
  if (clause.startsWith("(") && clause.endsWith(")")) {
    clause = clause.slice(1, -1).trim();
  }
  const andIdx = findTopLevelAnd(clause);
  if (andIdx >= 0) {
    const left = clause.slice(0, andIdx).trim();
    const right = clause.slice(andIdx + 4).trim();
    const leftPred = parseWhere(left, params);
    const rightPred = parseWhere(right, params);
    return (row) => leftPred(row) && rightPred(row);
  }
  const isNotNullMatch = clause.match(/"[^"]+"\."([^"]+)" is not null/i);
  if (isNotNullMatch) {
    const colName = isNotNullMatch[1];
    if (!colName) throw new Error(`parseWhere: malformed IS NOT NULL clause: ${clause}`);
    const field = COLUMN_TO_FIELD[colName];
    if (!field) throw new Error(`parseWhere: unknown column in IS NOT NULL clause: ${colName}`);
    return (row) => row[field] != null;
  }
  const cmpMatch = clause.match(/"[^"]+"\."([^"]+)"\s*(=|>=|<=|>|<)\s*\$(\d+)/);
  if (cmpMatch) {
    const colName = cmpMatch[1];
    const op = cmpMatch[2];
    const paramIdxStr = cmpMatch[3];
    if (!colName || !op || !paramIdxStr)
      throw new Error(`parseWhere: malformed comparison clause: ${clause}`);
    const paramIdx = parseInt(paramIdxStr, 10) - 1;
    const paramVal = params[paramIdx];
    const field = COLUMN_TO_FIELD[colName];
    if (!field) throw new Error(`parseWhere: unknown column in comparison clause: ${colName}`);
    return (row) => {
      const rowVal = row[field];
      if (rowVal == null) return false;
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
  throw new Error(`parseWhere: unrecognized WHERE shape: ${clause}`);
}

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
// Fake DB (mirrors subagent-dispatch-tracker.test.ts)
// ---------------------------------------------------------------------------

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
    countField: string | null;
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
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void): Promise<unknown> {
        return executeSelect(ctx).then(resolve, reject);
      },
    };
    return chain;
  }

  function buildGroupByFn(
    selectedFields: Record<string, unknown>
  ): ((row: FakeRow) => string) | null {
    if ("outcome" in selectedFields) return (row) => row.outcome;
    if ("agentType" in selectedFields) return (row) => row.agentType;
    if ("hour" in selectedFields) {
      return (row) => {
        const d = row.startedAt;
        return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00Z`;
      };
    }
    return null;
  }

  async function executeSelect(ctx: QueryCtx): Promise<unknown[]> {
    let rs = rows();
    if (ctx.wherePred) rs = rs.filter(ctx.wherePred);
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
    if (ctx.orderByDescStartedAt) {
      rs = [...rs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }
    if (ctx.limitVal !== null) rs = rs.slice(0, ctx.limitVal);
    if (ctx.countField) return [{ [ctx.countField]: rs.length }];
    return rs;
  }

  const db = {
    select(fields: Record<string, unknown> = {}) {
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
// Helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date("2026-05-11T12:00:00.000Z");

function hoursAgo(n: number): Date {
  return new Date(BASE_DATE.getTime() - n * 60 * 60 * 1000);
}

function makeInput(overrides: Partial<SubagentInvocationInput> = {}): SubagentInvocationInput {
  return {
    taskId: "mt#1738",
    agentType: "general-purpose",
    outcome: "completed-with-pr",
    startedAt: BASE_DATE,
    ...overrides,
  };
}

/**
 * Execute the debug.systemInfo command and return its result.
 * Uses the global sharedCommandRegistry (which registerDebugCommands() populates).
 */
async function callSystemInfo(): Promise<Record<string, unknown>> {
  const cmd = sharedCommandRegistry.getCommand("debug.systemInfo");
  if (!cmd) throw new Error("debug.systemInfo not found in registry");
  const result = await cmd.execute({}, { interface: "test" });
  return result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("debug.systemInfo subagentDispatches surface (mt#1738)", () => {
  let store: Map<string, FakeRow>;
  let tracker: SubagentDispatchTracker;

  beforeEach(() => {
    // Ensure debug commands are registered (idempotent — registry deduplicates).
    // Use allowOverwrite to avoid errors if already registered from a prior test.
    store = new Map<string, FakeRow>();
    nextId = 1;
    tracker = SubagentDispatchTracker.resetForTest(makeFakeDb(store));
    // Re-register debug commands (in case of test isolation).
    try {
      registerDebugCommands();
    } catch {
      // Already registered — overwrite
      sharedCommandRegistry.unregisterCommand("debug.systemInfo");
      sharedCommandRegistry.unregisterCommand("debug.echo");
      sharedCommandRegistry.unregisterCommand("debug.listMethods");
      registerDebugCommands();
    }
  });

  afterEach(() => {
    // Clean up singleton after each test so tests don't bleed into each other.
    SubagentDispatchTracker.resetForTest(
      // Reset to a fresh empty-DB tracker.
      makeFakeDb(new Map<string, FakeRow>())
    );
  });

  // -------------------------------------------------------------------------
  // Acceptance test 1: 20 fixture rows → correct byOutcome aggregates
  // -------------------------------------------------------------------------

  test("20 fixture rows → byOutcome reports correct counts per outcome", async () => {
    // Seed 20 rows distributed across all 6 outcome classes.
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
        await tracker.recordSubagentInvocation(makeInput({ outcome, startedAt: hoursAgo(i + 1) }));
      }
    }
    expect(store.size).toBe(20);

    const result = await callSystemInfo();
    const dispatches = result.subagentDispatches as Record<string, unknown>;
    expect(dispatches).toBeDefined();

    const byOutcome = dispatches.byOutcome as Record<SubagentInvocationOutcome, number>;
    expect(byOutcome).toBeDefined();
    expect(byOutcome[OUTCOME_COMPLETED_WITH_PR]).toBe(5);
    expect(byOutcome[OUTCOME_COMMITTED_NO_PR]).toBe(4);
    expect(byOutcome[OUTCOME_PARTIAL_COMMITTED_HANDOFF]).toBe(3);
    expect(byOutcome[OUTCOME_PARTIAL_UNCOMMITTED]).toBe(4);
    expect(byOutcome[OUTCOME_CRASHED]).toBe(2);
    expect(byOutcome[OUTCOME_RATE_LIMITED]).toBe(2);

    // All 6 outcome class keys present
    for (const outcome of SUBAGENT_INVOCATION_OUTCOME_VALUES) {
      expect(outcome in byOutcome).toBe(true);
    }

    // total
    expect(dispatches.total).toBe(20);
  });

  // -------------------------------------------------------------------------
  // Acceptance test 2: 3 partial-uncommitted-no-handoff in one session →
  // escalation === "session"
  // -------------------------------------------------------------------------

  test('3 partial-uncommitted-no-handoff rows in one session → escalation === "session"', async () => {
    // SESSION_PARTIAL_UNCOMMITTED_THRESHOLD = 2, so 3 rows > threshold.
    for (let i = 0; i < 3; i++) {
      await tracker.recordSubagentInvocation(
        makeInput({
          outcome: OUTCOME_PARTIAL_UNCOMMITTED,
          parentSessionId: "session-escalation-test",
          startedAt: hoursAgo(i + 1),
        })
      );
    }
    expect(store.size).toBe(3);

    const result = await callSystemInfo();
    const dispatches = result.subagentDispatches as Record<string, unknown>;
    expect(dispatches.escalation).toBe("session");
  });

  // -------------------------------------------------------------------------
  // Additional: no-op path (empty DB) → zero-filled aggregates
  // -------------------------------------------------------------------------

  test("empty DB → zero-filled aggregates and escalation none", async () => {
    const result = await callSystemInfo();
    const dispatches = result.subagentDispatches as Record<string, unknown>;
    expect(dispatches).toBeDefined();
    expect(dispatches.total).toBe(0);
    expect(dispatches.lastDispatch).toBeNull();
    expect(dispatches.escalation).toBe("none");

    const byOutcome = dispatches.byOutcome as Record<SubagentInvocationOutcome, number>;
    for (const outcome of SUBAGENT_INVOCATION_OUTCOME_VALUES) {
      expect(byOutcome[outcome]).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Additional: result shape includes all required top-level fields
  // -------------------------------------------------------------------------

  test("subagentDispatches result has all required fields", async () => {
    const result = await callSystemInfo();
    const dispatches = result.subagentDispatches as Record<string, unknown>;
    expect("total" in dispatches).toBe(true);
    expect("lastDispatch" in dispatches).toBe(true);
    expect("byOutcome" in dispatches).toBe(true);
    expect("byAgentType" in dispatches).toBe(true);
    expect("byHourLast24h" in dispatches).toBe(true);
    expect("escalation" in dispatches).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional: tracker field is present alongside mcpDisconnects
  // -------------------------------------------------------------------------

  test("subagentDispatches co-exists with mcpDisconnects in result", async () => {
    const result = await callSystemInfo();
    expect("mcpDisconnects" in result).toBe(true);
    expect("subagentDispatches" in result).toBe(true);
  });
});
