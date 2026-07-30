/**
 * Tests for ToolCallProjectionPipeline + projectToolCallsForAllTranscripts.
 *
 * Uses in-memory fakes for the DB — no real Postgres (mirrors
 * agent-spawns-pipeline.test.ts's precedent). Tests cover:
 *  - AT1: ingesting a conversation's turns (driven through the REAL
 *    `extractTurns` extractor, not a hand-rolled shape) produces projection
 *    rows matching its tool_use blocks, in order.
 *  - tool_name/server splitting for MCP vs. built-in tools.
 *  - ordinal restarts per turn; multiple turns compose without collision.
 *  - idempotent upsert (re-running does not duplicate rows).
 *  - graceful handling of turns with no tool calls / malformed blocks.
 *  - projectToolCallsForAllTranscripts: batched, resumable session-id
 *    pagination via the injectable `fetchPage` seam.
 *
 * @see mt#3329 — tool-call-projection-pipeline.ts
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";
import {
  ToolCallProjectionPipeline,
  projectToolCallsForAllTranscripts,
} from "./tool-call-projection-pipeline";

// ── Fixture: a realistic transcript with tool_use blocks ─────────────────────

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T10:01:00.000Z";

function userLine(ts: string, text: string): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: text },
  } as unknown as RawTurnLine;
}

function assistantLineWithTools(
  ts: string,
  blocks: Array<{ type: string; name?: string; input?: unknown; text?: string }>
): RawTurnLine {
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: blocks },
  } as unknown as RawTurnLine;
}

/**
 * A realistic two-turn fixture transcript: turn 0 has a single tool call,
 * turn 1 has two parallel tool calls (a batch) — proving ordinal ordering
 * within a turn and turn_index separation across turns.
 */
function buildFixtureTranscript(): RawTurnLine[] {
  return [
    userLine(TS1, "read the file"),
    assistantLineWithTools(TS1, [
      { type: "text", text: "Reading now." },
      {
        type: "tool_use",
        name: "mcp__minsky__session_read_file",
        input: { path: "/Users/x/.local/state/minsky/sessions/abc/src/foo.ts" },
      },
    ]),
    userLine(TS2, "now run the tests"),
    assistantLineWithTools(TS2, [
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
      {
        type: "tool_use",
        name: "mcp__minsky__validate_typecheck",
        input: { task: "mt#3329" },
      },
    ]),
  ];
}

// ── Fake DB ───────────────────────────────────────────────────────────────────

interface FakeProjectionRow {
  agentSessionId: string;
  turnIndex: number;
  ordinal: number;
  toolName: string;
  server: string | null;
  argFingerprint: string;
  timestamp: Date | null;
}

interface FakeTurnRow {
  turnIndex: number;
  toolCalls: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
}

function projectionKey(row: {
  agentSessionId: string;
  turnIndex: number;
  ordinal: number;
}): string {
  return `${row.agentSessionId}:${row.turnIndex}:${row.ordinal}`;
}

function asDb(db: unknown): PostgresJsDatabase {
  return db as unknown as PostgresJsDatabase;
}

/**
 * Minimal fake mimicking drizzle's fluent surface for
 * ToolCallProjectionPipeline.runForSession's TWO queries:
 *   (1) select({turnIndex, toolCalls, startedAt, endedAt}).from(turns).where(...)
 *   (2) insert(projection).values(...).onConflictDoUpdate(...)
 *
 * The where-clause condition is intentionally NOT introspected (matching
 * agent-spawns-pipeline.test.ts's precedent) — each test scopes turnRows to
 * exactly one session, so the fake can return them unconditionally.
 */
function makeDb(turnRows: FakeTurnRow[], projectionStore: Map<string, FakeProjectionRow>) {
  return {
    select(fields?: Record<string, unknown>) {
      const isTurnsQuery = !!fields && "toolCalls" in fields;
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown): Promise<FakeTurnRow[]> => {
            return Promise.resolve(isTurnsQuery ? turnRows : []);
          },
        }),
      };
    },
    insert(_table: unknown) {
      return {
        values(values: FakeProjectionRow | FakeProjectionRow[]) {
          const rows = Array.isArray(values) ? values : [values];
          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              for (const row of rows) {
                projectionStore.set(projectionKey(row), { ...row });
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ToolCallProjectionPipeline", () => {
  test("AT1: projects tool_use blocks from a real extractTurns() run, in order", async () => {
    const transcript = buildFixtureTranscript();
    const turns = extractTurns(transcript);

    // Sanity: the fixture actually produced the two turns we expect, each
    // carrying its tool_use blocks (proves this test exercises real
    // extraction, not a hand-shaped double of it).
    expect(turns).toHaveLength(2);
    expect(turns[0]?.toolCalls).toHaveLength(1);
    expect(turns[1]?.toolCalls).toHaveLength(2);

    const turnRows: FakeTurnRow[] = turns.map((t) => ({
      turnIndex: t.turnIndex,
      toolCalls: t.toolCalls,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    }));

    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.turnsErrored).toBe(0);
    expect(result.toolCallsProjected).toBe(3); // 1 + 2 tool_use blocks total
    expect(store.size).toBe(3);

    // Turn 0, ordinal 0: the single tool call.
    const row0 = store.get(projectionKey({ agentSessionId: SESSION_A, turnIndex: 0, ordinal: 0 }));
    expect(row0?.toolName).toBe("session_read_file");
    expect(row0?.server).toBe("minsky");

    // Turn 1, ordinal 0 and 1: the parallel batch, IN ARRAY ORDER.
    const row1_0 = store.get(
      projectionKey({ agentSessionId: SESSION_A, turnIndex: 1, ordinal: 0 })
    );
    const row1_1 = store.get(
      projectionKey({ agentSessionId: SESSION_A, turnIndex: 1, ordinal: 1 })
    );
    expect(row1_0?.toolName).toBe("Bash");
    expect(row1_0?.server).toBeUndefined(); // non-MCP tool: no server column value
    expect(row1_1?.toolName).toBe("validate_typecheck");
    expect(row1_1?.server).toBe("minsky");

    // arg_fingerprints are present and distinct per distinct input.
    expect(row0?.argFingerprint).toBeTruthy();
    expect(row1_0?.argFingerprint).toBeTruthy();
    expect(row0?.argFingerprint).not.toBe(row1_0?.argFingerprint);
  });

  test("idempotent: re-running does not duplicate rows", async () => {
    const transcript = buildFixtureTranscript();
    const turns = extractTurns(transcript);
    const turnRows: FakeTurnRow[] = turns.map((t) => ({
      turnIndex: t.turnIndex,
      toolCalls: t.toolCalls,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
    }));

    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    await pipeline.runForSession(SESSION_A);
    const sizeAfterFirst = store.size;
    await pipeline.runForSession(SESSION_A);

    expect(store.size).toBe(sizeAfterFirst);
  });

  test("a turn with null tool_calls contributes zero rows", async () => {
    const turnRows: FakeTurnRow[] = [
      { turnIndex: 0, toolCalls: null, startedAt: null, endedAt: new Date(TS1) },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.toolCallsProjected).toBe(0);
    expect(store.size).toBe(0);
  });

  test("mt#3360: a string-typed (double-encoded) tool_calls row is skipped and counted, not thrown", async () => {
    // Simulates the Apr-2026 ingest artifact: `tool_calls` is a jsonb STRING
    // (double-encoded JSON of an otherwise-valid tool_use array), not a jsonb
    // array. `runForSession`'s query doesn't call jsonb_array_length (that's
    // the script-level bug this task also fixes), so this never throws — but
    // pre-mt#3360 it silently contributed 0 rows indistinguishable from a
    // genuinely-empty turn. Post-fix it must be counted in skippedNonArray.
    const turnRows: FakeTurnRow[] = [
      {
        turnIndex: 0,
        toolCalls: JSON.stringify([{ type: "tool_use", name: "Bash", input: {} }]),
        startedAt: null,
        endedAt: new Date(TS1),
      },
      {
        turnIndex: 1,
        toolCalls: [{ type: "tool_use", name: "Bash", input: {} }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.turnsErrored).toBe(0);
    expect(result.skippedNonArray).toBe(1);
    // Only turn 1's real array is projected; turn 0's string is skipped, not
    // silently folded into "0 blocks written".
    expect(result.toolCallsProjected).toBe(1);
    expect(store.size).toBe(1);
    expect(
      store.get(projectionKey({ agentSessionId: SESSION_A, turnIndex: 0, ordinal: 0 }))
    ).toBeUndefined();
  });

  test("a malformed block (no name) is skipped without throwing", async () => {
    const turnRows: FakeTurnRow[] = [
      {
        turnIndex: 0,
        toolCalls: [{ type: "tool_use" /* missing name */ }, { type: "tool_use", name: "Bash" }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.turnsErrored).toBe(0);
    expect(result.toolCallsProjected).toBe(1);
    // The malformed block's ordinal (0) is skipped; the valid block keeps its
    // true array position (ordinal 1), not renumbered to 0.
    const row = store.get(projectionKey({ agentSessionId: SESSION_A, turnIndex: 0, ordinal: 1 }));
    expect(row?.toolName).toBe("Bash");
  });

  test("timestamp falls back to startedAt when endedAt is absent", async () => {
    const started = new Date(TS1);
    const turnRows: FakeTurnRow[] = [
      {
        turnIndex: 0,
        toolCalls: [{ type: "tool_use", name: "Bash", input: {} }],
        startedAt: started,
        endedAt: null,
      },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    await pipeline.runForSession(SESSION_A);

    const row = store.get(projectionKey({ agentSessionId: SESSION_A, turnIndex: 0, ordinal: 0 }));
    expect(row?.timestamp).toEqual(started);
  });
});

describe("projectToolCallsForAllTranscripts", () => {
  test("paginates across batches and reports an accurate aggregate", async () => {
    const pages = [
      [{ agentSessionId: "s1" }, { agentSessionId: "s2" }],
      [{ agentSessionId: "s3" }],
    ];
    let call = 0;
    const seenAfterIds: Array<string | null> = [];

    // An always-empty select/insert-free db — this test isolates the
    // batching/pagination logic from runForSession's own query behavior
    // (covered separately above).
    const emptyDb = {
      select() {
        return { from: () => ({ where: () => Promise.resolve([]) }) };
      },
      insert() {
        return { values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) };
      },
    };

    const fetchPage = async (
      _db: PostgresJsDatabase,
      afterId: string | null,
      _batchSize: number
    ): Promise<Array<{ agentSessionId: string }>> => {
      seenAfterIds.push(afterId);
      const page = pages[call] ?? [];
      call++;
      return page;
    };

    const batchCompletions: Array<{ lastId: string; sessionsScanned: number }> = [];

    const result = await projectToolCallsForAllTranscripts(asDb(emptyDb), {
      batchSize: 2,
      fetchPage,
      onBatchComplete: (partial, lastId) => {
        batchCompletions.push({ lastId, sessionsScanned: partial.sessionsScanned });
      },
    });

    expect(result.sessionsScanned).toBe(3);
    expect(result.sessionsProcessed).toBe(3);
    expect(result.sessionsErrored).toBe(0);
    // First call has no cursor; the second call resumes from the last id of
    // the first batch (s2) — proving the sweep is resumable via afterId.
    expect(seenAfterIds).toEqual([null, "s2"]);
    expect(batchCompletions.map((b) => b.lastId)).toEqual(["s2", "s3"]);
  });

  test("a session whose runForSession errors is counted, not thrown", async () => {
    const throwingDb = {
      select() {
        return {
          from: () => ({
            where: () => {
              throw new Error("simulated query failure");
            },
          }),
        };
      },
      insert() {
        return { values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) };
      },
    };

    const fetchPage = async (
      _db: PostgresJsDatabase,
      _afterId: string | null,
      _batchSize: number
    ): Promise<Array<{ agentSessionId: string }>> => [{ agentSessionId: "s1" }];

    const result = await projectToolCallsForAllTranscripts(asDb(throwingDb), {
      fetchPage,
    });

    // runForSession catches its own query failure and returns a zeroed
    // result (turnsErrored stays 0 for a query-level failure — see
    // ToolCallProjectionRunResult's docs) — but it does NOT throw, so the
    // sweep still counts the session as scanned/processed rather than
    // aborting the whole run.
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
  });
});
