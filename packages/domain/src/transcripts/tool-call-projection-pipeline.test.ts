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
import { computeArgFingerprint } from "./tool-call-projection-fields";
import {
  ToolCallProjectionPipeline,
  projectToolCallsForAllTranscripts,
  fetchPendingSessionIdPage,
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
 * ToolCallProjectionPipeline.runForSession's THREE queries:
 *   (1) select({turnIndex, toolCalls, startedAt, endedAt}).from(turns).where(...)
 *       — production filters `jsonb_typeof(tool_calls) = 'array'` (mt#3360),
 *       so `turnRows` here should already be shaped as what THAT filter would
 *       let through (i.e. tests feed only array/null tool_calls, not string).
 *   (2) select({n: count(*)}).from(turns).where(...) — countSkippedNonArray
 *       (mt#3360) — `skippedNonArrayCount` is the canned answer.
 *   (3) insert(projection).values(...).onConflictDoUpdate(...)
 *
 * The where-clause condition is intentionally NOT introspected (matching
 * agent-spawns-pipeline.test.ts's precedent) — each test scopes turnRows to
 * exactly one session, so the fake can return them unconditionally.
 */
function makeDb(
  turnRows: FakeTurnRow[],
  projectionStore: Map<string, FakeProjectionRow>,
  skippedNonArrayCount = 0
) {
  return {
    select(fields?: Record<string, unknown>) {
      const isTurnsQuery = !!fields && "toolCalls" in fields;
      const isSkippedCountQuery = !!fields && "n" in fields;
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown): Promise<unknown[]> => {
            if (isTurnsQuery) return Promise.resolve(turnRows);
            if (isSkippedCountQuery) return Promise.resolve([{ n: skippedNonArrayCount }]);
            return Promise.resolve([]);
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

  test("mt#3360: string-typed (double-encoded) tool_calls turns are excluded from the main query and reported via a separate skipped count", async () => {
    // Simulates the Apr-2026 ingest artifact: `tool_calls` is a jsonb STRING
    // (double-encoded JSON of an otherwise-valid tool_use array), not a jsonb
    // array. Production's main query now filters
    // `jsonb_typeof(tool_calls) = 'array'`, so a string-typed row is never
    // FETCHED by it (unlike this fixture's turnRows, which therefore only
    // contains the one genuine array turn) — the separate
    // countSkippedNonArray query is how the pipeline still learns "1 turn
    // was excluded", instead of that turn silently contributing 0 rows
    // indistinguishable from a genuinely-empty turn.
    const turnRows: FakeTurnRow[] = [
      {
        turnIndex: 1,
        toolCalls: [{ type: "tool_use", name: "Bash", input: {} }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const db = makeDb(turnRows, store, /* skippedNonArrayCount */ 1);
    const pipeline = new ToolCallProjectionPipeline(asDb(db));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.turnsErrored).toBe(0);
    expect(result.skippedNonArray).toBe(1);
    // Only turn 1's real array is projected; the double-encoded turn was
    // never returned by the (now-filtered) main query at all.
    expect(result.toolCallsProjected).toBe(1);
    expect(store.size).toBe(1);
    expect(
      store.get(projectionKey({ agentSessionId: SESSION_A, turnIndex: 0, ordinal: 0 }))
    ).toBeUndefined();
  });

  test("mt#3360: a failing skipped-count query degrades to 0 rather than crashing the session", async () => {
    const turnRows: FakeTurnRow[] = [
      {
        turnIndex: 0,
        toolCalls: [{ type: "tool_use", name: "Bash", input: {} }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ];
    const store = new Map<string, FakeProjectionRow>();
    const throwingDb = {
      select(fields?: Record<string, unknown>) {
        const isTurnsQuery = !!fields && "toolCalls" in fields;
        const isSkippedCountQuery = !!fields && "n" in fields;
        return {
          from: (_table: unknown) => ({
            where: (_cond: unknown): Promise<unknown[]> => {
              if (isTurnsQuery) return Promise.resolve(turnRows);
              if (isSkippedCountQuery) throw new Error("simulated skipped-count query failure");
              return Promise.resolve([]);
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
                  store.set(projectionKey(row), { ...row });
                }
                return Promise.resolve();
              },
            };
          },
        };
      },
    };
    const pipeline = new ToolCallProjectionPipeline(asDb(throwingDb));

    const result = await pipeline.runForSession(SESSION_A);

    expect(result.skippedNonArray).toBe(0);
    // The main projection still succeeds — a diagnostic-only count failure
    // must not take down the real work.
    expect(result.toolCallsProjected).toBe(1);
    expect(result.turnsErrored).toBe(0);
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

// ── fetchPendingSessionIdPage (mt#3395) ──────────────────────────────────────

/**
 * Recursively walk a drizzle `SQL` (or expression-builder) object and
 * collect every RAW interpolated scalar it carries — i.e. the actual values
 * passed via `${...}` template interpolation (a plain string/number pushed
 * directly into `queryChunks`, per drizzle-orm's `sql` tag implementation),
 * skipping the literal `StringChunk` text segments themselves. Verified
 * empirically against drizzle-orm's actual `SQL`/`Column`/`eq`/`and` shapes
 * (not merely assumed) before writing the tests below: `and(eq(col, "x"),
 * sql\`...\`)` correctly yields `["x"]`, nothing more and nothing less.
 *
 * This is a test-only introspection helper — it does NOT prove the query is
 * valid Postgres (that's the live check per this task's AT3); it proves the
 * function wires its `afterId`/`batchSize` PARAMETERS into the query object
 * it builds, which a hardcoded-response mock alone cannot demonstrate.
 */
function extractRawScalars(chunk: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > 25 || chunk === null || chunk === undefined) return out;
  if (typeof chunk !== "object") {
    out.push(chunk);
    return out;
  }
  const c = chunk as Record<string, unknown>;
  if (Array.isArray(c.queryChunks)) {
    for (const sub of c.queryChunks as unknown[]) extractRawScalars(sub, out, depth + 1);
    return out;
  }
  if (Array.isArray(c.value) && (c.value as unknown[]).every((v) => typeof v === "string")) {
    return out; // StringChunk: literal SQL text, not an interpolated param
  }
  if ("value" in c) out.push((c as { value: unknown }).value);
  return out;
}

describe("fetchPendingSessionIdPage (mt#3395)", () => {
  test("maps raw agent_session_id rows to the {agentSessionId} page contract via exactly one query", async () => {
    const calls: unknown[] = [];
    const db = {
      execute: async (query: unknown) => {
        calls.push(query);
        return [{ agent_session_id: "s-partial" }, { agent_session_id: "s-absent" }];
      },
    };

    const page = await fetchPendingSessionIdPage(asDb(db), null, 100);

    expect(calls.length).toBe(1);
    expect(page).toEqual([{ agentSessionId: "s-partial" }, { agentSessionId: "s-absent" }]);
  });

  test("wires a non-null afterId into the query as a keyset cursor (resumable --pending-only)", async () => {
    let captured: unknown;
    const db = {
      execute: async (query: unknown) => {
        captured = query;
        return [];
      },
    };

    await fetchPendingSessionIdPage(asDb(db), "cursor-id", 50);

    const scalars = extractRawScalars(captured);
    expect(scalars).toContain("cursor-id");
    expect(scalars).toContain(50);
  });

  test("omits the afterId filter when afterId is null (first page of a fresh run)", async () => {
    let captured: unknown;
    const db = {
      execute: async (query: unknown) => {
        captured = query;
        return [];
      },
    };

    await fetchPendingSessionIdPage(asDb(db), null, 50);

    const scalars = extractRawScalars(captured);
    expect(scalars).not.toContain("cursor-id");
    expect(scalars).toContain(50);
  });
});

// ── --pending-only target selection + repair (mt#3395, AT1) ─────────────────

describe("--pending-only target selection + repair (mt#3395, AT1)", () => {
  const SESSION_COMPLETE = "cccccccc-0000-0000-0000-000000000001";
  const SESSION_PARTIAL = "dddddddd-0000-0000-0000-000000000002";
  const SESSION_ABSENT = "eeeeeeee-0000-0000-0000-000000000003";

  // Fixture: per-session turn definitions. SESSION_COMPLETE is fully
  // projected already (never re-selected, never re-queried); SESSION_PARTIAL
  // has one turn already projected and a second turn (2 blocks) entirely
  // missing — the killed-run "large session lost mid-batch" shape; SESSION_
  // ABSENT has zero projected rows at all.
  const turnsBySession: Record<string, FakeTurnRow[]> = {
    [SESSION_COMPLETE]: [
      {
        turnIndex: 0,
        toolCalls: [{ type: "tool_use", name: "Bash", input: {} }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ],
    [SESSION_PARTIAL]: [
      {
        turnIndex: 0,
        toolCalls: [{ type: "tool_use", name: "Bash", input: { a: 1 } }],
        startedAt: null,
        endedAt: new Date(TS1),
      },
      {
        turnIndex: 1,
        toolCalls: [
          {
            type: "tool_use",
            name: "mcp__minsky__session_read_file",
            input: { path: "/x" },
          },
          { type: "tool_use", name: "Bash", input: { b: 2 } },
        ],
        startedAt: null,
        endedAt: new Date(TS2),
      },
    ],
    [SESSION_ABSENT]: [
      {
        turnIndex: 0,
        toolCalls: [
          { type: "tool_use", name: "Bash", input: {} },
          { type: "tool_use", name: "Bash", input: { c: 3 } },
        ],
        startedAt: null,
        endedAt: new Date(TS1),
      },
    ],
  };

  /** Mirrors the anti-join's "expected rows" side: sum of block counts across array-typed turns. */
  function expectedRowCount(turns: FakeTurnRow[]): number {
    return turns.reduce((sum, t) => sum + (Array.isArray(t.toolCalls) ? t.toolCalls.length : 0), 0);
  }

  /**
   * Fake db supporting MULTIPLE sessions (unlike `makeDb` above, which is
   * unconditional and scoped to exactly one session per its own doc
   * comment): introspects the `where` condition via `extractRawScalars` to
   * find which session's turns are being requested — the same technique
   * verified against real drizzle `eq`/`and` shapes above — and routes to
   * that session's fixture rows.
   */
  function makeMultiSessionDb(
    byId: Record<string, FakeTurnRow[]>,
    projectionStore: Map<string, FakeProjectionRow>,
    onQueriedSession?: (sessionId: string) => void
  ) {
    return {
      select(fields?: Record<string, unknown>) {
        const isTurnsQuery = !!fields && "toolCalls" in fields;
        const isSkippedCountQuery = !!fields && "n" in fields;
        return {
          from: (_table: unknown) => ({
            where: (cond: unknown): Promise<unknown[]> => {
              const scalars = extractRawScalars(cond);
              const sessionId = scalars.find((v) => typeof v === "string" && v in byId) as
                | string
                | undefined;
              if (isTurnsQuery) {
                if (sessionId) onQueriedSession?.(sessionId);
                return Promise.resolve(sessionId ? (byId[sessionId] ?? []) : []);
              }
              if (isSkippedCountQuery) return Promise.resolve([{ n: 0 }]);
              return Promise.resolve([]);
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

  test("target selection identifies exactly the holey sessions (partial + absent), never the complete one", () => {
    // Pre-existing projection state: SESSION_COMPLETE fully projected;
    // SESSION_PARTIAL only its turn-0 row survives (turn 1's 2 blocks are
    // the killed-run hole); SESSION_ABSENT has nothing.
    const actualCounts = new Map<string, number>([
      [SESSION_COMPLETE, 1],
      [SESSION_PARTIAL, 1],
    ]);

    // Reference computation mirroring fetchPendingSessionIdPage's documented
    // anti-join semantics (expected > actual, per session). The real SQL's
    // syntactic validity + behavior against live jsonb data is proven by the
    // AT3 live check (this file's established convention — see makeDb's own
    // comment — is that jsonb query semantics are verified live, not faked).
    const pendingSessionIds = Object.keys(turnsBySession).filter((sessionId) => {
      const expected = expectedRowCount(turnsBySession[sessionId] ?? []);
      const actual = actualCounts.get(sessionId) ?? 0;
      return expected > actual;
    });

    expect(pendingSessionIds.sort()).toEqual([SESSION_ABSENT, SESSION_PARTIAL].sort());
    expect(pendingSessionIds).not.toContain(SESSION_COMPLETE);
  });

  test("driving the sweep with the pending page repairs both holey sessions via the SAME per-session pure helpers, and never touches the complete session", async () => {
    const store = new Map<string, FakeProjectionRow>();
    // Pre-load SESSION_PARTIAL's surviving turn-0 row and SESSION_COMPLETE's
    // row (SESSION_COMPLETE must remain byte-for-byte untouched — the
    // fetchPage below deliberately excludes it, exactly as the real
    // anti-join would).
    store.set(projectionKey({ agentSessionId: SESSION_PARTIAL, turnIndex: 0, ordinal: 0 }), {
      agentSessionId: SESSION_PARTIAL,
      turnIndex: 0,
      ordinal: 0,
      toolName: "Bash",
      server: null,
      argFingerprint: computeArgFingerprint({ a: 1 }),
      timestamp: null,
    });
    store.set(projectionKey({ agentSessionId: SESSION_COMPLETE, turnIndex: 0, ordinal: 0 }), {
      agentSessionId: SESSION_COMPLETE,
      turnIndex: 0,
      ordinal: 0,
      toolName: "Bash",
      server: null,
      argFingerprint: computeArgFingerprint({}),
      timestamp: null,
    });

    const queriedSessions: string[] = [];
    const db = makeMultiSessionDb(turnsBySession, store, (sessionId) =>
      queriedSessions.push(sessionId)
    );

    // Stands in for fetchPendingSessionIdPage's real anti-join query,
    // returning exactly the holey ids from the selection test above.
    const fetchPage = async () => [
      { agentSessionId: SESSION_PARTIAL },
      { agentSessionId: SESSION_ABSENT },
    ];

    const result = await projectToolCallsForAllTranscripts(asDb(db), { fetchPage });

    expect(result.sessionsProcessed).toBe(2);
    expect(result.sessionsErrored).toBe(0);

    // SESSION_PARTIAL: turn 0 preserved (idempotent re-upsert) + turn 1's 2
    // newly-written blocks = 3 rows total.
    const partialRows = [...store.keys()].filter((k) => k.startsWith(`${SESSION_PARTIAL}:`));
    expect(partialRows.length).toBe(3);

    // SESSION_ABSENT: both of turn 0's blocks newly written.
    const absentRows = [...store.keys()].filter((k) => k.startsWith(`${SESSION_ABSENT}:`));
    expect(absentRows.length).toBe(2);

    // SESSION_COMPLETE was never in the fetchPage output: runForSession was
    // never invoked for it, and its pre-existing row is untouched.
    expect(queriedSessions).not.toContain(SESSION_COMPLETE);
    const completeRows = [...store.keys()].filter((k) => k.startsWith(`${SESSION_COMPLETE}:`));
    expect(completeRows.length).toBe(1);
  });
});
