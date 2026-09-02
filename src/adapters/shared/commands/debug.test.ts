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
 *
 * The guardHealth suite (mt#2812, near the bottom of this file) uses real
 * filesystem operations against temp files — it exercises GuardHealthTracker's
 * actual on-disk read behavior end-to-end through debug.systemInfo, the same
 * rationale disconnect-tracker.test.ts documents for its own real-fs suites.
 */
/* eslint-disable custom/no-real-fs-in-tests */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { SubagentDispatchTracker } from "../../../mcp/subagent-dispatch-tracker";
import type { SubagentInvocationInput } from "../../../mcp/subagent-dispatch-tracker";
import { GuardHealthTracker } from "../../../mcp/guard-health-tracker";
import type { SubagentInvocationOutcome } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import {
  SUBAGENT_INVOCATION_OUTCOME_VALUES,
  subagentInvocationsTable,
} from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { registerDebugCommands } from "./debug";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";

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
  ended_at: "endedAt",
  parent_session_id: "parentSessionId",
  subagent_session_id: "subagentSessionId",
  agent_type: "agentType",
  task_id: "taskId",
  session_id: "sessionId",
  actual_model: "actualModel",
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
  // mt#2831: isNull(endedAt) — the tracker's heuristic upsert target selector.
  const isNullMatch = clause.match(/"[^"]+"\."([^"]+)" is null/i);
  if (isNullMatch) {
    const colName = isNullMatch[1];
    if (!colName) throw new Error(`parseWhere: malformed IS NULL clause: ${clause}`);
    const field = COLUMN_TO_FIELD[colName];
    if (!field) throw new Error(`parseWhere: unknown column in IS NULL clause: ${colName}`);
    return (row) => row[field] == null;
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
    // mt#2831: distinguish ASC (bare column) from DESC (desc()-wrapped) — see the
    // matching comment in subagent-dispatch-tracker.test.ts's fake DB.
    orderDirection: "asc" | "desc" | null;
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
      orderBy(col: unknown) {
        ctx.orderDirection = col === subagentInvocationsTable.startedAt ? "asc" : "desc";
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
    if ("model" in selectedFields) return (row) => row.actualModel ?? "";
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
        if ("model" in ctx.selectedFields && firstRow) entry.model = firstRow.actualModel;
        if ("hour" in ctx.selectedFields) entry.hour = key;
        result.push(entry);
      }
      return result;
    }
    if (ctx.orderDirection === "desc") {
      rs = [...rs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    } else if (ctx.orderDirection === "asc") {
      rs = [...rs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
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
            // mt#2831: recordSubagentInvocation now calls `.returning({ id: ... })`
            // after `.values(...)` on the INSERT path.
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

/**
 * Put `debug.*` in the registry, whatever the registry currently holds.
 *
 * mt#3575: every describe in this file calls `callSystemInfo()`, which reads
 * `debug.systemInfo` off the process-global `sharedCommandRegistry` — but only
 * SOME of them registered it. The `guardHealth` block registered nothing and
 * inherited a populated registry from a sibling, so it failed with
 * `debug.systemInfo not found in registry` in any order that ran it first.
 * That is order-dependence by construction: a block asserting a precondition it
 * never establishes (mem#942).
 *
 * Establishing the precondition is the sanctioned remedy — not pinning a seed
 * and not re-ordering declarations. Deterministic reproducer for the old shape:
 *
 *   bun test --preload ./tests/setup.ts -t "guardHealth" \
 *     src/adapters/shared/commands/debug.test.ts
 *
 * which denies the block its siblings and failed 5/5 before this helper existed.
 */
const DEBUG_ECHO_ID = "debug.echo";
const DEBUG_LIST_METHODS_ID = "debug.listMethods";
const DEBUG_COMMAND_IDS = ["debug.systemInfo", DEBUG_ECHO_ID, DEBUG_LIST_METHODS_ID] as const;

/** One id's prior occupant: the command object, or `undefined` if it was absent. */
type RegistryEntry = readonly [string, ReturnType<typeof sharedCommandRegistry.getCommand>];

/** What the registry holds for `ids` right now. */
function captureRegistryEntries(ids: readonly string[]): RegistryEntry[] {
  return ids.map((id) => [id, sharedCommandRegistry.getCommand(id)] as const);
}

/**
 * Put the registry back to exactly `entries`.
 *
 * The two cases are NOT interchangeable: an id that was ABSENT owes an
 * unregister, and one that HELD something owes that same object back. Collapsing
 * them leaves this file's own registration in place for whoever runs next.
 */
function restoreRegistryEntries(entries: readonly RegistryEntry[]): void {
  for (const [id, prior] of entries) {
    sharedCommandRegistry.unregisterCommand(id);
    if (prior) sharedCommandRegistry.registerCommand(prior, { allowOverwrite: true });
  }
}

/**
 * What the registry held for the debug ids BEFORE this file first touched it.
 *
 * **Written exactly once and never cleared** (PR #3590 R2). The previous version
 * cleared this on restore, so any later `ensureDebugCommandsRegistered()` — which
 * the file-level `beforeEach` runs before every remaining test — re-captured a
 * MID-FILE state, and `afterAll` then "restored" to that instead of to the
 * pre-file state. The baseline a teardown restores to must not be reachable by
 * anything that runs after the baseline is taken; that is why this is a
 * write-once cell rather than a cleared one, and why the test below exercises
 * `captureRegistryEntries`/`restoreRegistryEntries` against its OWN local
 * capture instead of driving this cell.
 */
let preFileDebugEntries: RegistryEntry[] | undefined;

function ensureDebugCommandsRegistered(): void {
  // Capture before the FIRST mutation — what we displace is what we owe back.
  preFileDebugEntries ??= captureRegistryEntries(DEBUG_COMMAND_IDS);
  for (const id of DEBUG_COMMAND_IDS) sharedCommandRegistry.unregisterCommand(id);
  registerDebugCommands();
}

/**
 * Hand the process-global registry back as this file found it.
 *
 * `sharedCommandRegistry` is a process global and `bun test` shares one process
 * across files, so without this the file leaks in BOTH directions: it leaves its
 * own `debug.*` commands there for every later file, and its unregister deletes
 * whichever ones an earlier file had registered. Each is cross-file
 * order-dependence — the class this task exists to remove — so introducing one
 * while fixing another would be a net loss.
 *
 * mt#4076 states the rule: for a shared REGISTRY, as opposed to shared module
 * state, the correct teardown is restore-what-you-displaced, not
 * delete-what-you-added. Idempotent, because it reads the write-once cell above
 * rather than consuming it.
 */
function restorePreFileDebugCommands(): void {
  if (preFileDebugEntries) restoreRegistryEntries(preFileDebugEntries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// File-level: runs before EVERY test in this file, including describes that do
// not register for themselves. A describe-level beforeEach still runs after
// this one, so the existing blocks keep their own setup unchanged.
beforeEach(ensureDebugCommandsRegistered);

// File-level teardown: hand the process-global registry back in the state this
// file found it. Without this the fix above would trade one cross-file
// order-dependence for another (PR #3590 R1).
afterAll(restorePreFileDebugCommands);

describe("registry restoration (mt#3575, PR #3590 R1)", () => {
  /**
   * The mt#3575 fix made this file register `debug.*` into the process-global
   * registry for every test. `bun test` shares one process across files, so the
   * fix is only safe if the file hands the registry back as it found it —
   * otherwise it trades the order-dependence it removed for a new one, which is
   * the failure mt#4076 recorded for a shared REGISTRY.
   *
   * Drives the real displace→restore pair rather than a copy of it, so a change
   * to either function is what this test observes.
   */
  test("an occupied id is restored to the same object; an absent one ends up unregistered", () => {
    const sentinel = defineCommand({
      id: DEBUG_ECHO_ID,
      category: CommandCategory.DEBUG,
      name: DEBUG_ECHO_ID,
      description: "sentinel standing in for a command an earlier file registered",
      parameters: {},
      execute: async () => ({ sentinel: true }),
    });

    // Construct the two cases the teardown must tell apart: one id OCCUPIED by
    // someone else's command, one id ABSENT.
    sharedCommandRegistry.registerCommand(sentinel, { allowOverwrite: true });
    sharedCommandRegistry.unregisterCommand(DEBUG_LIST_METHODS_ID);

    // A LOCAL capture — the file-level `preFileDebugEntries` is deliberately not
    // touched, so this test cannot corrupt the baseline `afterAll` restores to.
    // That corruption is exactly what R2 caught in the previous version.
    const localBaseline = captureRegistryEntries([DEBUG_ECHO_ID, DEBUG_LIST_METHODS_ID]);

    // Displacing really replaces the occupant and really fills the empty slot.
    for (const id of DEBUG_COMMAND_IDS) sharedCommandRegistry.unregisterCommand(id);
    registerDebugCommands();
    expect(sharedCommandRegistry.getCommand(DEBUG_ECHO_ID)).not.toBe(sentinel);
    expect(sharedCommandRegistry.getCommand(DEBUG_LIST_METHODS_ID)).toBeDefined();

    restoreRegistryEntries(localBaseline);

    // The occupied id gets that same object back — identity, not a lookalike.
    expect(sharedCommandRegistry.getCommand(DEBUG_ECHO_ID)).toBe(sentinel);
    // The absent id ends up absent, NOT carrying this file's registration.
    expect(sharedCommandRegistry.getCommand(DEBUG_LIST_METHODS_ID)).toBeUndefined();

    // Restoring twice is the same as once: the teardown reads its baseline
    // rather than consuming it, which is what makes it safe to call from
    // `afterAll` after any number of `beforeEach` displacements.
    restoreRegistryEntries(localBaseline);
    expect(sharedCommandRegistry.getCommand(DEBUG_ECHO_ID)).toBe(sentinel);
    expect(sharedCommandRegistry.getCommand(DEBUG_LIST_METHODS_ID)).toBeUndefined();

    // Drop the sentinel and hand the file back a working registry; the
    // file-level beforeEach re-establishes it for whatever runs next anyway.
    sharedCommandRegistry.unregisterCommand(DEBUG_ECHO_ID);
    ensureDebugCommandsRegistered();
  });

  test("the file-level baseline cell is written ONCE — a later displacement must not replace it", () => {
    // R2's defect, stated as an identity check on the cell itself.
    //
    // An earlier version of this test compared the captured commands against the
    // ones currently registered and asserted they differed. That assertion is
    // INERT: `registerDebugCommands()` mints fresh objects on every call, so the
    // two differ whether the cell is written once or reassigned every time. The
    // negative control is what exposed it — reintroducing the defect left the
    // test green (mt#4502: a control that does not fire means the test is inert
    // or the control is unfaithful, and here it was the test).
    //
    // Array IDENTITY is the discriminator that actually separates them, and it
    // does not depend on what any other file happened to register.
    const baselineBefore = preFileDebugEntries;
    // The file-level beforeEach has already displaced the registry once, so the
    // cell must be populated by now. Throwing rather than asserting narrows the
    // type AND states the precondition this test depends on.
    if (baselineBefore === undefined) {
      throw new Error("preFileDebugEntries was never captured by the file-level beforeEach");
    }
    expect(baselineBefore.map(([id]) => id)).toEqual([...DEBUG_COMMAND_IDS]);

    // Displace again, exactly as the file-level beforeEach does before every
    // remaining test in this file.
    ensureDebugCommandsRegistered();

    // Write-once: the SAME array, not an equal one. A cell that re-captured
    // would hold this file's own registrations by now, and `afterAll` would
    // restore to that instead of the pre-file state — leaking to later files.
    expect(preFileDebugEntries).toBe(baselineBefore);
  });
});

describe("debug.systemInfo subagentDispatches surface (mt#1738)", () => {
  let store: Map<string, FakeRow>;
  let tracker: SubagentDispatchTracker;

  beforeEach(() => {
    // Ensure debug commands are registered (idempotent — registry deduplicates).
    // Use allowOverwrite to avoid errors if already registered from a prior test.
    store = new Map<string, FakeRow>();
    nextId = 1;
    tracker = SubagentDispatchTracker.resetForTest(makeFakeDb(store));
    // mt#3575: the file-level beforeEach above already did this. Kept as an
    // explicit call rather than deleted, because this block's tracker reset
    // happens AFTER it and the registration must outlive that.
    ensureDebugCommandsRegistered();
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
    // Seed 20 rows distributed across the 6 workspace-derived outcome classes.
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
    expect("byModel" in dispatches).toBe(true);
    expect("byHourLast24h" in dispatches).toBe(true);
    expect("escalation" in dispatches).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Acceptance test 3 (mt#2796): one dispatch → non-empty byModel
  // -------------------------------------------------------------------------

  test("one dispatch with a classified actualModel → byModel is non-empty", async () => {
    await tracker.recordSubagentInvocation(makeInput({ actualModel: "claude-sonnet-5" }));

    const result = await callSystemInfo();
    const dispatches = result.subagentDispatches as Record<string, unknown>;
    const byModel = dispatches.byModel as Record<string, number>;
    expect(byModel).toBeDefined();
    expect(Object.keys(byModel).length).toBeGreaterThan(0);
    expect(byModel["claude-sonnet-5"]).toBe(1);
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

// ---------------------------------------------------------------------------
// debug.systemInfo guardHealth surface tests (mt#2812)
// ---------------------------------------------------------------------------

const GUARD_HEALTH_TEST_GUARD_NAME = "require-deploy-verification-before-merge";

describe("debug.systemInfo guardHealth surface (mt#2812)", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const p = cleanupPaths.pop();
      if (p && fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    GuardHealthTracker.resetForTest();
  });

  function makeTempLogPath(name: string): string {
    return path.join(os.tmpdir(), `mt2812-debug-guardhealth-test-${name}-${Date.now()}.jsonl`);
  }

  function guardEvent(overrides: {
    guardName?: string;
    timestamp: string;
    kind?: "error" | "check-skip";
  }): Record<string, unknown> {
    return {
      guardName: overrides.guardName ?? "test-guard",
      event: "PreToolUse",
      kind: overrides.kind ?? "error",
      message: "boom",
      timestamp: overrides.timestamp,
    };
  }

  test("3 consecutive guard errors -> guardHealth.escalation is critical and names the guard", async () => {
    const logPath = makeTempLogPath("critical");
    cleanupPaths.push(logPath);
    // mt#2814: timestamps must be RECENT relative to real wall-clock "now" —
    // GuardHealthTracker.getSummary() (the production path debug.systemInfo
    // exercises here) ages a guard's consecutiveStreak out to 0 once its
    // last event is more than STREAK_RESET_GAP_MS (24h) stale, since this
    // call is made with no injected `now` (matching production behavior:
    // debug.ts calls getInstance().getSummary() with zero args). A FIXED
    // past ISO string (e.g. "2026-07-14T11:00:00.000Z") eventually falls
    // outside that 24h window purely from real time elapsing, breaking this
    // test with no code change — exactly what happened when this test's
    // original fixed dates aged past 24h. Compute offsets from `Date.now()`
    // instead so the fixture is always "3 recent consecutive failures"
    // regardless of when the suite actually runs.
    const now = Date.now();
    const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();
    const lines = [
      guardEvent({ guardName: GUARD_HEALTH_TEST_GUARD_NAME, timestamp: hoursAgo(3) }),
      guardEvent({ guardName: GUARD_HEALTH_TEST_GUARD_NAME, timestamp: hoursAgo(2) }),
      guardEvent({ guardName: GUARD_HEALTH_TEST_GUARD_NAME, timestamp: hoursAgo(1) }),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    fs.writeFileSync(logPath, `${lines}\n`);

    GuardHealthTracker.resetForTest(logPath);
    const result = await callSystemInfo();
    const guardHealth = result.guardHealth as Record<string, unknown>;
    expect(guardHealth).toBeDefined();
    expect(guardHealth.escalation).toBe("critical");
    expect(guardHealth.criticalGuards).toEqual([GUARD_HEALTH_TEST_GUARD_NAME]);
  });

  // mt#2814: the age-out contract, end-to-end through the SAME production
  // surface (debug.systemInfo -> GuardHealthTracker.getSummary() with no
  // injected `now`) the test above exercises for the "recent" case. A guard
  // whose 3 consecutive failures are all >24h stale must NOT escalate.
  test("3 consecutive guard errors older than 24h -> guardHealth.escalation ages out to none", async () => {
    const logPath = makeTempLogPath("stale");
    cleanupPaths.push(logPath);
    const now = Date.now();
    const staleGuardName = "stale-test-guard";
    const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();
    const lines = [
      guardEvent({ guardName: staleGuardName, timestamp: hoursAgo(27) }),
      guardEvent({ guardName: staleGuardName, timestamp: hoursAgo(26) }),
      guardEvent({ guardName: staleGuardName, timestamp: hoursAgo(25) }), // last event still >24h ago
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    fs.writeFileSync(logPath, `${lines}\n`);

    GuardHealthTracker.resetForTest(logPath);
    const result = await callSystemInfo();
    const guardHealth = result.guardHealth as Record<string, unknown>;
    expect(guardHealth).toBeDefined();
    expect(guardHealth.escalation).toBe("none");
    expect(guardHealth.criticalGuards).toEqual([]);
    const byGuard = guardHealth.byGuard as Record<string, { consecutiveStreak: number }>;
    expect(byGuard[staleGuardName]?.consecutiveStreak).toBe(0);
  });

  test("no guard-health log -> zero-filled aggregates and escalation none", async () => {
    const logPath = makeTempLogPath("missing");
    // Deliberately never created.
    GuardHealthTracker.resetForTest(logPath);
    const result = await callSystemInfo();
    const guardHealth = result.guardHealth as Record<string, unknown>;
    expect(guardHealth).toBeDefined();
    expect(guardHealth.escalation).toBe("none");
    expect(guardHealth.byGuard).toEqual({});
  });

  test("guardHealth result has all required fields", async () => {
    const result = await callSystemInfo();
    const guardHealth = result.guardHealth as Record<string, unknown>;
    expect("byGuard" in guardHealth).toBe(true);
    expect("criticalGuards" in guardHealth).toBe(true);
    expect("attentionGuards" in guardHealth).toBe(true);
    expect("escalation" in guardHealth).toBe(true);
  });

  test("guardHealth co-exists with mcpDisconnects and subagentDispatches in result", async () => {
    const result = await callSystemInfo();
    expect("mcpDisconnects" in result).toBe(true);
    expect("subagentDispatches" in result).toBe(true);
    expect("guardHealth" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// debug.systemInfo runtime surface tests (mt#4718)
//
// The field these cover used to be `nodejs.version` = `process.version`. Under
// Bun that is a SHIM of the Node version Bun claims compatibility with, so the
// tool confidently reported a Node build that was not running and need not have
// been installed at all. The assertions below deliberately compare against the
// runtime EXECUTING them rather than hardcoding "bun": hardcoding would restate
// the bug in the test — asserting a runtime name we assumed instead of the one
// actually running.
// ---------------------------------------------------------------------------

describe("debug.systemInfo runtime surface (mt#4718)", () => {
  beforeEach(() => {
    try {
      registerDebugCommands();
    } catch {
      // Already registered by an earlier suite in this file. The registry is
      // process-global and what these tests need is that the command IS
      // registered, not that this suite is the one that registered it.
    }
  });

  test("reports the runtime actually executing, not process.version", async () => {
    const result = await callSystemInfo();
    const runtime = result.runtime as Record<string, unknown>;
    expect(runtime).toBeDefined();

    const bunVersion = (process.versions as Partial<Record<string, string>>).bun;
    if (bunVersion) {
      expect(runtime.name).toBe("bun");
      expect(runtime.version).toBe(bunVersion);
      // The regression itself: the reported version must NOT be Bun's Node shim.
      expect(runtime.version).not.toBe(process.version);
    } else {
      expect(runtime.name).toBe("node");
      expect(runtime.version).toBe(process.versions.node);
    }
  });

  test("nodeCompat preserves the Node compatibility claim", async () => {
    const result = await callSystemInfo();
    const runtime = result.runtime as Record<string, unknown>;
    expect(runtime.nodeCompat).toBe(process.version);
  });

  test("the legacy `nodejs` key is gone", async () => {
    const result = await callSystemInfo();
    expect("nodejs" in result).toBe(false);
    expect("runtime" in result).toBe(true);
  });

  test("platform, arch and uptime survive the move onto `runtime`", async () => {
    const result = await callSystemInfo();
    const runtime = result.runtime as Record<string, unknown>;
    expect(runtime.platform).toBe(process.platform);
    expect(runtime.arch).toBe(process.arch);
    expect(typeof runtime.uptime).toBe("number");
    expect(runtime.uptime as number).toBeGreaterThanOrEqual(0);
  });

  test('degrades to "unknown" instead of throwing when version fields are absent', async () => {
    const versionsDescriptor = Object.getOwnPropertyDescriptor(process, "versions");
    const versionDescriptor = Object.getOwnPropertyDescriptor(process, "version");
    try {
      Object.defineProperty(process, "versions", {
        value: {},
        configurable: true,
        writable: true,
        enumerable: true,
      });
      Object.defineProperty(process, "version", {
        value: undefined,
        configurable: true,
        writable: true,
        enumerable: true,
      });

      const result = await callSystemInfo();
      const runtime = result.runtime as Record<string, unknown>;
      expect(runtime.version).toBe("unknown");
      expect(runtime.nodeCompat).toBe("unknown");
      // Detection still resolves to a name rather than throwing or emitting undefined.
      expect(runtime.name).toBe("node");
    } finally {
      if (versionsDescriptor) Object.defineProperty(process, "versions", versionsDescriptor);
      if (versionDescriptor) Object.defineProperty(process, "version", versionDescriptor);
    }
  });
});
