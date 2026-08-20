/**
 * Tests for turn-writer (the extraction half of the pipeline, ADR-019).
 *
 * Covers:
 *  - writeTurnsForTranscript materializes one row per extracted turn
 *  - fts_text auto-populates (GENERATED column simulation)
 *  - spawn-boundary turns are marked; subagent content does not leak
 *  - EMBEDDING PRESERVATION: capture upsert never writes `embedding`, so an
 *    already-embedded row keeps its vector when re-extracted (ADR-019 invariant)
 *  - idempotent upsert (no duplicate rows)
 *  - empty / null transcript → 0 rows
 *  - extractTurnsForAllTranscripts aggregates across transcripts
 *  - mt#2457 SC3: a non-empty transcript yielding zero turns WARNs + counts
 *    (nonEmptyYieldedZero) instead of silently skipping
 *  - mt#2457 perf constraint: extractTurnsForAllTranscripts pages through
 *    fetchPage in bounded batches and supports afterId resumability
 *
 * @see ./turn-writer.ts
 * @see mt#2381
 * @see mt#2457
 */

import { describe, test, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import type { RawTurnLine } from "./transcript-source";
import {
  writeTurnsForTranscript,
  extractTurnsForAllTranscripts,
  classifyWriteOutcome,
  formatExtractAllTurnsResult,
  isDegradedExtraction,
  isStatementTimeout,
  buildTurnUpsertSkipIfUnchangedWhere,
  TURN_UPSERT_DIRECT_SET_COLUMNS,
  DEFAULT_TURN_CHUNK_SIZE,
  MIN_TURN_CHUNK_SIZE,
  type ExtractAllTurnsResult,
  type TranscriptPageRow,
  type TurnWriterLogSink,
  type WriteTurnsResult,
} from "./turn-writer";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
const TS3 = "2026-01-01T12:00:00.000Z";
const TS4 = "2026-01-01T13:00:00.000Z";

// ── Fake turn-rows store ────────────────────────────────────────────────────

interface FakeTurnRow {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  toolCalls: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
  embedding: number[] | null;
  ftsText: string | null;
  isSpawnBoundary: boolean;
}

interface FakeTranscriptRow {
  agentSessionId: string;
  transcript: RawTurnLine[] | null;
}

function turnKey(sid: string, idx: number): string {
  return `${sid}:${idx}`;
}

/**
 * Fake DB modeling:
 *   - select({agentSessionId, transcript}).from(agent_transcripts)  → transcriptRows
 *   - insert(turns).values(v).onConflictDoUpdate({target, set})     → upsert into store
 *
 * `values(v)` accepts either a single row object or an ARRAY of row objects
 * (mt#2457 perf: writeTurnsForTranscript now bulk-upserts turns in chunks
 * rather than one row per `.values()` call) — each row in the array is
 * upserted independently, matching Postgres's per-row ON CONFLICT semantics
 * for a multi-row INSERT.
 *
 * The fake leaves an existing row's `embedding` untouched on conflict, because
 * `writeTurnsForTranscript` never puts `embedding` in `values`.
 *
 * Since mt#3883 that is no longer the whole story: the real SET clause NULLS the
 * embedding when the row's TEXT changed, so a moved turn boundary cannot leave a
 * vector describing content the row no longer holds. The fake cannot see that —
 * it only ever receives `values`, never the SET clause — and simulating the CASE
 * expression here would be pretending to implement Postgres, which is precisely
 * what the orphan-delete note below refuses to do. So these tests deliberately
 * do NOT cover the conditional; its behavior against real Postgres is covered by
 * `scripts/verify-turn-embedding-invalidation.ts`. What they still cover is the
 * unchanged-text case, which must keep the vector either way.
 *
 * Same split for mt#4345's skip-if-unchanged `setWhere` predicate: the fake's
 * `onConflictDoUpdate(_opts)` below ignores `_opts` entirely and always applies
 * the write, so it cannot exhibit "Postgres skipped this row because nothing
 * changed" — that requires a real `ON CONFLICT ... WHERE` evaluation, which is
 * covered live by `scripts/verify-turn-write-skip-if-unchanged.ts` instead.
 */
function makeDb(
  transcriptRows: FakeTranscriptRow[],
  store: Map<string, FakeTurnRow>,
  onInsertBatch?: (batchSize: number) => void,
  /**
   * Predicate invoked once per bulk-insert call (call index starting at 0,
   * plus the batch size) — returning true makes that call's
   * `onConflictDoUpdate()` reject instead of resolving. Lets tests simulate
   * a chunk-level write failure (mt#2457 R1 review: erroredChunks).
   *
   * Returning the string `"timeout"` (mt#3911) rejects with a
   * statement-timeout-SHAPED error instead of a generic one: the driver
   * message on `cause`, with no `code` on the wrapper. That is the exact shape
   * drizzle produced for the real failure, so `isStatementTimeout` is
   * exercised against the observed structure rather than an idealized one.
   */
  failInsertCall?: (callIndex: number, batchSize: number) => boolean | "timeout",
  /**
   * mt#3514 orphan-removal seam. The fake deliberately does NOT evaluate the
   * drizzle predicate (`and(eq(session), gte(turn_index, N))`) — simulating
   * Postgres's WHERE evaluation in a fake would be pretending to implement the
   * database, and a test that passes against that pretence is evidence about
   * the fake, not the query. So these tests cover the DECISIONS the writer
   * makes around the delete (is it issued at all, how is its result counted,
   * what happens when it throws); the predicate's actual row selection is
   * covered against real Postgres by `scripts/verify-turn-orphan-removal.ts`.
   *
   * `deleteBehavior` returns the rows the DELETE should report as removed, or
   * throws to simulate a failing delete. Absent → the delete removes nothing.
   */
  deleteBehavior?: (callIndex: number) => { turnIndex: number }[]
) {
  type TurnValues = Partial<FakeTurnRow> & { agentSessionId: string; turnIndex: number };
  let insertCallIndex = -1;
  let deleteCallIndex = -1;
  const deleteCalls: number[] = [];

  function upsertOne(v: TurnValues): void {
    const key = turnKey(v.agentSessionId, v.turnIndex);
    const ftsText = [v.userText, v.assistantText].filter(Boolean).join(" ") || null;
    const existing = store.get(key);
    store.set(key, {
      agentSessionId: v.agentSessionId,
      turnIndex: v.turnIndex,
      userText: v.userText ?? null,
      assistantText: v.assistantText ?? null,
      toolCalls: v.toolCalls ?? null,
      startedAt: v.startedAt ?? null,
      endedAt: v.endedAt ?? null,
      // PRESERVE embedding: writeTurnsForTranscript omits `embedding`
      // from values, so the SET clause does not touch it on conflict.
      embedding: existing ? existing.embedding : null,
      ftsText,
      isSpawnBoundary: v.isSpawnBoundary ?? false,
    });
  }

  const fake: Record<string, unknown> = {
    /**
     * mt#3514: the writer runs its upsert + orphan-delete inside a
     * transaction holding a session advisory lock, with a per-chunk SAVEPOINT
     * (a nested `transaction`). The fake models the CONTROL FLOW only — it
     * passes itself as the tx/savepoint handle and propagates rejections — not
     * rollback semantics, which would be pretending to implement Postgres.
     * Real atomicity and real locking are database behavior, out of reach of
     * an in-memory fake and covered by the live prod verification instead.
     */
    async transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(fake);
    },
    /** The advisory-lock statement; the fake has no lock to take. */
    execute(_query: unknown): Promise<unknown[]> {
      return Promise.resolve([]);
    },
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) =>
          Promise.resolve(
            transcriptRows.map((r) => ({
              agentSessionId: r.agentSessionId,
              transcript: r.transcript,
            }))
          ),
      };
    },
    insert(_table: unknown) {
      return {
        values(v: TurnValues | TurnValues[]) {
          const rows = Array.isArray(v) ? v : [v];
          insertCallIndex++;
          const callIndex = insertCallIndex;
          onInsertBatch?.(rows.length);
          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              const failure = failInsertCall?.(callIndex, rows.length);
              if (failure === "timeout") {
                return Promise.reject(
                  Object.assign(new Error("write CHUNK failed"), {
                    cause: new Error("canceling statement due to statement timeout"),
                  })
                );
              }
              if (failure) {
                return Promise.reject(new Error(`simulated insert failure (call ${callIndex})`));
              }
              for (const row of rows) upsertOne(row);
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete(_table: unknown) {
      deleteCallIndex++;
      const callIndex = deleteCallIndex;
      deleteCalls.push(callIndex);
      return {
        where(_cond: unknown) {
          return {
            returning(_cols?: unknown): Promise<{ turnIndex: number }[]> {
              try {
                return Promise.resolve(deleteBehavior?.(callIndex) ?? []);
              } catch (err) {
                return Promise.reject(err);
              }
            },
          };
        },
      };
    },
    /** Test-only accessor: how many DELETEs the writer issued (mt#3514). */
    __deleteCallCount(): number {
      return deleteCalls.length;
    },
  };
  return fake as typeof fake & { __deleteCallCount(): number };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

/**
 * In-memory keyset-pagination fake for `ExtractAllTurnsOptions.fetchPage`
 * (mt#2457 perf constraint). Mirrors the production `fetchTranscriptPage`
 * contract — rows sorted by `agentSessionId` ascending, `afterId` strictly
 * exclusive, `batchSize`-bounded pages — without mocking the drizzle
 * query-builder chain.
 */
function makeFetchPage(rows: FakeTranscriptRow[]) {
  const sorted = [...rows].sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
  let callCount = 0;
  const fetchPage = async (
    _db: unknown,
    afterId: string | null,
    batchSize: number
  ): Promise<TranscriptPageRow[]> => {
    callCount++;
    const startIdx = afterId ? sorted.findIndex((r) => r.agentSessionId > afterId) : 0;
    if (startIdx === -1) return [];
    return sorted
      .slice(startIdx, startIdx + batchSize)
      .map((r) => ({ agentSessionId: r.agentSessionId, transcript: r.transcript }));
  };
  return { fetchPage, getCallCount: () => callCount };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function userLine(text: string, ts = TS1): RawTurnLine {
  return { type: "user", timestamp: ts, message: { role: "user", content: text } };
}
function assistantLine(
  text: string,
  toolCalls: Record<string, unknown>[] = [],
  ts = TS2
): RawTurnLine {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolCalls);
  return { type: "assistant", timestamp: ts, message: { role: "assistant", content } };
}
function agentToolCall(id = "toolu_agent_1"): Record<string, unknown> {
  return { type: "tool_use", id, name: "Agent", input: { description: "x", prompt: "y" } };
}
function toolResultLine(toolUseId = "toolu_agent_1", ts = TS3): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [{ type: "text", text: "subagent transcript content here" }],
        },
      ],
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

/**
 * Render a drizzle `SQL` fragment into its parameterized text via drizzle's
 * own dialect, per the pattern established in `principal-channel.test.ts`
 * (`sqlToQuery` is the supported seam; hand-walking `queryChunks` is not).
 */
const pgDialect = new PgDialect();
function renderSql(fragment: ReturnType<typeof buildTurnUpsertSkipIfUnchangedWhere>): string {
  return pgDialect.sqlToQuery(fragment).sql;
}

/**
 * Shape tests for the mt#4345 skip-if-unchanged guard (PR #3176 R1): no live
 * Postgres involved, these assert the STRUCTURE of the predicate — that it
 * uses `IS DISTINCT FROM` throughout, never `<>`, and that it names every
 * column `TURN_UPSERT_DIRECT_SET_COLUMNS` declares. Because the real upsert's
 * `set` block is built FROM that same array (`turnUpsertDirectSet` in
 * turn-writer.ts), a column added to the array and forgotten in the
 * predicate — or vice versa — is not a possible bug; these tests instead
 * guard the array's CONTENTS, which is the one place either function reads
 * from. Whether the predicate actually causes Postgres to SKIP a write is a
 * live-Postgres question this file's fake DB cannot answer (see the
 * `makeDb` doc comment above) — that is
 * `scripts/verify-turn-write-skip-if-unchanged.ts`'s job.
 */
describe("skip-if-unchanged guard shape (mt#4345)", () => {
  test("TURN_UPSERT_DIRECT_SET_COLUMNS names exactly the seven direct-from-EXCLUDED columns", () => {
    expect(TURN_UPSERT_DIRECT_SET_COLUMNS.map((c): string => c.key).sort()).toEqual(
      [
        "userText",
        "userOrigin",
        "assistantText",
        "toolCalls",
        "startedAt",
        "endedAt",
        "isSpawnBoundary",
      ].sort()
    );
    expect(TURN_UPSERT_DIRECT_SET_COLUMNS.map((c) => c.sqlName).sort()).toEqual(
      [
        "user_text",
        "user_origin",
        "assistant_text",
        "tool_calls",
        "started_at",
        "ended_at",
        "is_spawn_boundary",
      ].sort()
    );
    // `embedding` is deliberately absent — its SET value is derived from
    // userText/assistantText (mt#3883), not a straight EXCLUDED passthrough.
    // `userOrigin` (mt#4289) IS present, despite also being excluded from the
    // embedding CASE — it's excluded from the CASE because provenance doesn't
    // describe the vector, but it's still a direct SET column that must
    // participate in the skip-if-unchanged predicate (see turn-writer.ts's
    // comment on this array's userOrigin entry).
    expect(TURN_UPSERT_DIRECT_SET_COLUMNS.map((c) => c.key)).not.toContain("embedding");
    expect(TURN_UPSERT_DIRECT_SET_COLUMNS.map((c) => c.key)).toContain("userOrigin");
  });

  test("the predicate uses IS DISTINCT FROM for every declared column, never a bare <>", () => {
    const text = renderSql(buildTurnUpsertSkipIfUnchangedWhere());

    for (const { sqlName } of TURN_UPSERT_DIRECT_SET_COLUMNS) {
      expect(text).toContain(`EXCLUDED.${sqlName}`);
    }
    // Every comparison in this predicate must be IS DISTINCT FROM; a bare
    // `<>` anywhere in the rendered text would mean at least one column
    // reverted to the NULL <> NULL trap the mt#4345 spec warns about.
    expect(text.match(/IS DISTINCT FROM/g)?.length).toBe(TURN_UPSERT_DIRECT_SET_COLUMNS.length);
    expect(text).not.toContain("<>");
  });

  test("the predicate joins its clauses with OR — any single divergent column trips it", () => {
    const text = renderSql(buildTurnUpsertSkipIfUnchangedWhere());
    // TURN_UPSERT_DIRECT_SET_COLUMNS.length clauses joined by OR means
    // (length - 1) " OR " separators.
    const orCount = (text.match(/ OR /g) ?? []).length;
    expect(orCount).toBe(TURN_UPSERT_DIRECT_SET_COLUMNS.length - 1);
  });

  test("REGRESSION SEAM: adding a column to the array without a real schema column would fail typecheck, not silently ship", () => {
    // This test is deliberately about the ARRAY's shape rather than the
    // schema, because that IS the single source of truth both the SET
    // clause and this predicate read from (see turn-writer.ts's doc comment
    // on TURN_UPSERT_DIRECT_SET_COLUMNS). Seven entries is the current SET
    // block's direct-from-EXCLUDED count (six at mt#4345's original review,
    // plus `userOrigin` picked up from mt#4289 on the PR #3176 rebase) — a
    // reviewer adding an 8th column to the schema and the SET block must
    // also add it here for this count to stay accurate, which is the array
    // being the seam, not a coincidence.
    expect(TURN_UPSERT_DIRECT_SET_COLUMNS).toHaveLength(7);
  });
});

describe("writeTurnsForTranscript", () => {
  test("materializes one row per extracted turn", async () => {
    const transcript: RawTurnLine[] = [
      userLine("turn 1", TS1),
      assistantLine("response 1", [], TS2),
      userLine("turn 2", TS3),
      assistantLine("response 2", [], TS4),
    ];
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb([], store);

    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, transcript);

    expect(result.written).toBe(2);
    expect(result.nonEmptyYieldedZero).toBe(false);
    expect(store.size).toBe(2);
  });

  test("mt#2457 perf: bulk-upserts turns in chunks instead of one round-trip per turn", async () => {
    // A session with more turns than the chunk size, so the write spans three
    // chunks (two full + a remainder). Before mt#2457 this was one awaited
    // INSERT round-trip per turn; a handful of legacy sessions in the real
    // corpus run into the thousands of turns, which made even a single
    // session's reconciliation take on the order of a minute over a remote
    // Postgres connection.
    //
    // Derived from DEFAULT_TURN_CHUNK_SIZE rather than hardcoded (mt#3911):
    // this test asserted [500, 500, 200] against the old constant, so retuning
    // the chunk size broke it for a reason that had nothing to do with what it
    // tests. Its subject is "batches, not per-row round-trips" — not the
    // particular size.
    const REMAINDER = 20;
    const TURN_COUNT = DEFAULT_TURN_CHUNK_SIZE * 2 + REMAINDER;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const store = new Map<string, FakeTurnRow>();
    const batchSizes: number[] = [];
    const db = makeDb([], store, (n) => batchSizes.push(n));

    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, lines);

    expect(result.written).toBe(TURN_COUNT);
    expect(result.erroredChunks).toBe(0);
    expect(store.size).toBe(TURN_COUNT);
    // 3 bulk-insert calls, not TURN_COUNT single-row calls.
    expect(batchSizes).toEqual([DEFAULT_TURN_CHUNK_SIZE, DEFAULT_TURN_CHUNK_SIZE, REMAINDER]);
  });

  test("mt#2457 R1 review: a failed chunk upsert is counted via erroredChunks, not silently swallowed", async () => {
    // Three chunks (two full + a remainder). Fail only the SECOND chunk (call
    // index 1) so this also verifies a PARTIAL failure: chunks 1 and 3 succeed
    // (written should reflect only the successful chunks), but the transcript
    // as a whole must be flagged as having an error.
    //
    // The injected failure is a generic Error, NOT a statement timeout, so
    // mt#3911's split-and-retry deliberately does not engage — that path is
    // covered separately below.
    const REMAINDER = 20;
    const TURN_COUNT = DEFAULT_TURN_CHUNK_SIZE * 2 + REMAINDER;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb([], store, undefined, (callIndex) => callIndex === 1);

    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, lines);

    expect(result.erroredChunks).toBe(1);
    // Only the two successful chunks landed; the failed middle chunk did not
    // silently count as written.
    expect(result.written).toBe(DEFAULT_TURN_CHUNK_SIZE + REMAINDER);
    expect(store.size).toBe(DEFAULT_TURN_CHUNK_SIZE + REMAINDER);
    // mt#3911: `extracted` reports what the EXTRACTOR produced, so the
    // shortfall against `written` is visible in the result itself.
    expect(result.extracted).toBe(TURN_COUNT);
    expect(result.chunkSplits).toBe(0);
  });

  test("fts_text auto-populates from user + assistant text", async () => {
    const transcript: RawTurnLine[] = [
      userLine("search for this", TS1),
      assistantLine("found it here", [], TS2),
    ];
    const store = new Map<string, FakeTurnRow>();
    await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, transcript);

    const row = store.get(turnKey(SESSION_A, 0));
    expect(row?.ftsText).toContain("search for this");
    expect(row?.ftsText).toContain("found it here");
  });

  test("never writes the embedding column (new rows get null embedding)", async () => {
    const transcript: RawTurnLine[] = [userLine("hi", TS1), assistantLine("yo", [], TS2)];
    const store = new Map<string, FakeTurnRow>();
    await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, transcript);
    expect(store.get(turnKey(SESSION_A, 0))?.embedding).toBeNull();
  });

  test("EMBEDDING PRESERVATION: re-extracting an embedded turn keeps its vector", async () => {
    const store = new Map<string, FakeTurnRow>();
    // Seed an already-embedded turn row.
    store.set(turnKey(SESSION_A, 0), {
      agentSessionId: SESSION_A,
      turnIndex: 0,
      userText: "old user",
      assistantText: "old assistant",
      toolCalls: null,
      startedAt: null,
      endedAt: null,
      embedding: [0.1, 0.2, 0.3],
      ftsText: "old user old assistant",
      isSpawnBoundary: false,
    });

    // Re-extract the same turn with updated text.
    const transcript: RawTurnLine[] = [
      userLine("new user", TS1),
      assistantLine("new assistant", [], TS2),
    ];
    await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, transcript);

    const row = store.get(turnKey(SESSION_A, 0));
    // Embedding preserved...
    expect(row?.embedding).toEqual([0.1, 0.2, 0.3]);
    // ...and text was updated.
    expect(row?.userText).toBe("new user");
    expect(row?.assistantText).toBe("new assistant");
  });

  test("spawn-boundary turns are marked and do not leak subagent content", async () => {
    const transcript: RawTurnLine[] = [
      userLine("run subagent", TS1),
      assistantLine("dispatching now.", [agentToolCall("toolu_agent_1")], TS2),
      toolResultLine("toolu_agent_1", TS3),
      assistantLine("done", [], TS4),
    ];
    const store = new Map<string, FakeTurnRow>();
    await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, transcript);

    const rows = [...store.values()];
    const spawn = rows.find((r) => r.isSpawnBoundary);
    expect(spawn?.assistantText).toBe("dispatching now.");
    for (const r of rows) {
      expect(r.assistantText ?? "").not.toContain("subagent transcript content");
    }
  });

  test("tool_calls is stored as an array, not a double-encoded string", async () => {
    // jsonb column: the value must be the array itself so jsonb_typeof = 'array'
    // and Array.isArray(tool_calls) holds downstream. JSON.stringify would store
    // a quoted string (jsonb_typeof = 'string') — the pre-mt#2381 bug.
    const transcript: RawTurnLine[] = [
      userLine("dispatch", TS1),
      assistantLine("ok", [agentToolCall("toolu_a")], TS2),
    ];
    const store = new Map<string, FakeTurnRow>();
    await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, transcript);

    const row = store.get(turnKey(SESSION_A, 0));
    expect(Array.isArray(row?.toolCalls)).toBe(true);
    expect((row?.toolCalls as unknown[]).length).toBeGreaterThan(0);
  });

  test("idempotent: re-running upserts without duplicating rows", async () => {
    const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi", [], TS2)];
    const store = new Map<string, FakeTurnRow>();
    const db = asPg(makeDb([], store));
    await writeTurnsForTranscript(db, SESSION_A, transcript);
    const after1 = store.size;
    await writeTurnsForTranscript(db, SESSION_A, transcript);
    expect(store.size).toBe(after1);
  });

  test("empty transcript → 0 rows, not flagged as a failure", async () => {
    const store = new Map<string, FakeTurnRow>();
    const result = await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, []);
    expect(result.written).toBe(0);
    expect(result.nonEmptyYieldedZero).toBe(false);
    expect(store.size).toBe(0);
  });

  test("null transcript → 0 rows, not flagged as a failure", async () => {
    const store = new Map<string, FakeTurnRow>();
    const result = await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, null);
    expect(result.written).toBe(0);
    expect(result.nonEmptyYieldedZero).toBe(false);
  });

  test("mt#2457 SC3: non-empty transcript yielding zero turns is flagged loudly, not silently skipped", async () => {
    // A transcript that is a real, non-empty array but contains no recognizable
    // user/assistant lines (e.g. an unrecognized line `type`) — extractTurns
    // returns [] even though the input clearly wasn't empty. Before mt#2457 this
    // was indistinguishable from a genuinely-empty session; now it must WARN and
    // set nonEmptyYieldedZero so the caller can count it as a real failure.
    const unrecognizedTranscript = [
      { type: "system", timestamp: TS1, message: { role: "system", content: "boot" } },
      { type: "system", timestamp: TS2, message: { role: "system", content: "config" } },
    ] as unknown as RawTurnLine[];
    const store = new Map<string, FakeTurnRow>();

    const result = await writeTurnsForTranscript(
      asPg(makeDb([], store)),
      SESSION_A,
      unrecognizedTranscript
    );

    expect(result.written).toBe(0);
    expect(result.nonEmptyYieldedZero).toBe(true);
    expect(store.size).toBe(0);
  });

  test("wiring: warn events route through the injected log sink, not spyOn(log) (mt#3628)", async () => {
    // ONE wiring test for this shell's two warn call sites — verifies the
    // shell actually EMITS what the pure core decided, via an injected
    // sink rather than patching the shared logger. Behavioral coverage of
    // the decisions themselves (erroredChunks, nonEmptyYieldedZero) lives in
    // the return-value assertions above and in the classifyWriteOutcome
    // unit tests below.
    const warnCalls: Array<{ message: string }> = [];
    const logSink: TurnWriterLogSink = {
      warn: (message) => warnCalls.push({ message }),
      error: () => {},
    };

    // Chunk-failure warn path.
    const TURN_COUNT = 1200;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const chunkFailDb = makeDb([], new Map(), undefined, (callIndex) => callIndex === 1);
    await writeTurnsForTranscript(asPg(chunkFailDb), SESSION_A, lines, logSink);
    expect(warnCalls.some((c) => c.message.includes("failed to upsert a chunk"))).toBe(true);

    // Non-empty-yielded-zero warn path.
    warnCalls.length = 0;
    const unrecognizedTranscript = [
      { type: "system", timestamp: TS1, message: { role: "system", content: "boot" } },
    ] as unknown as RawTurnLine[];
    await writeTurnsForTranscript(
      asPg(makeDb([], new Map())),
      SESSION_A,
      unrecognizedTranscript,
      logSink
    );
    expect(warnCalls.some((c) => c.message.includes("yielded"))).toBe(true);
  });
});

describe("orphan removal (mt#3514)", () => {
  const twoTurnTranscript: RawTurnLine[] = [
    userLine("first"),
    assistantLine("reply one"),
    userLine("second", TS3),
    assistantLine("reply two", [], TS4),
  ];

  test("issues an orphan-removal DELETE after a clean write and reports what it removed", async () => {
    const store = new Map();
    // The DELETE reports two removed rows — the shape Postgres returns for a
    // session whose previous extraction emitted more turns than this one.
    const db = makeDb([], store, undefined, undefined, () => [{ turnIndex: 2 }, { turnIndex: 3 }]);
    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, twoTurnTranscript);

    expect(db.__deleteCallCount()).toBe(1);
    expect(result.orphansDeleted).toBe(2);
    expect(result.orphanDeleteFailed).toBe(false);
    expect(result.erroredChunks).toBe(0);
  });

  test("SAFETY: a non-empty transcript yielding ZERO turns issues NO delete", async () => {
    // The regression this guard exists for: at zero extracted turns, "delete
    // every row this extraction did not emit" would delete the session's
    // ENTIRE turn history — turning a suspected extractor regression into
    // permanent data loss.
    const store = new Map();
    const unrecognized = [
      { type: "system", timestamp: TS1, message: { role: "system", content: "boot" } },
    ] as unknown as RawTurnLine[];
    const db = makeDb([], store, undefined, undefined, () => [{ turnIndex: 0 }]);
    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, unrecognized);

    expect(result.nonEmptyYieldedZero).toBe(true);
    expect(db.__deleteCallCount()).toBe(0);
    expect(result.orphansDeleted).toBe(0);
  });

  test("SAFETY: an empty/absent transcript issues NO delete", async () => {
    const db = makeDb([], new Map(), undefined, undefined, () => [{ turnIndex: 0 }]);
    await writeTurnsForTranscript(asPg(db), SESSION_A, []);
    expect(db.__deleteCallCount()).toBe(0);
  });

  test("issues NO delete when a chunk write failed — a degraded write is not compounded", async () => {
    const db = makeDb(
      [],
      new Map(),
      undefined,
      () => true, // every insert chunk fails
      () => [{ turnIndex: 2 }]
    );
    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, twoTurnTranscript);

    expect(result.erroredChunks).toBeGreaterThan(0);
    expect(db.__deleteCallCount()).toBe(0);
    expect(result.orphansDeleted).toBe(0);
  });

  test("a THROWING delete sets orphanDeleteFailed, warns, and does not throw out of the writer", async () => {
    const warnCalls: { message: string }[] = [];
    const logSink: TurnWriterLogSink = {
      warn: (message) => warnCalls.push({ message }),
      error: () => {},
    };
    const db = makeDb([], new Map(), undefined, undefined, () => {
      throw new Error("simulated delete failure");
    });

    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, twoTurnTranscript, logSink);

    expect(result.orphanDeleteFailed).toBe(true);
    expect(result.orphansDeleted).toBe(0);
    // The upsert half still succeeded — the writer reports a degraded result
    // rather than losing the turns it did write.
    expect(result.written).toBeGreaterThan(0);
    expect(warnCalls.some((c) => c.message.includes("orphaned turn rows"))).toBe(true);
  });

  test("the sweep aggregates orphansDeleted across transcripts", async () => {
    const rows: FakeTranscriptRow[] = [
      { agentSessionId: SESSION_A, transcript: twoTurnTranscript },
      { agentSessionId: SESSION_B, transcript: twoTurnTranscript },
    ];
    // One orphan removed per transcript.
    const db = makeDb(rows, new Map(), undefined, undefined, () => [{ turnIndex: 2 }]);
    const { fetchPage } = makeFetchPage(rows);
    const result = await extractTurnsForAllTranscripts(asPg(db), { fetchPage });

    expect(result.orphansDeleted).toBe(2);
    expect(result.transcriptsProcessed).toBe(2);
  });
});

describe("classifyWriteOutcome (pure core, mt#3628)", () => {
  /**
   * Fills the fields a given case doesn't care about (mt#3514 added two).
   * Keeps each test's literal to the values it is actually about, so a future
   * field addition doesn't require editing every case again.
   */
  const outcome = (over: Partial<WriteTurnsResult>): WriteTurnsResult => ({
    extracted: 0,
    written: 0,
    nonEmptyYieldedZero: false,
    erroredChunks: 0,
    orphansDeleted: 0,
    orphanDeleteFailed: false,
    chunkSplits: 0,
    ...over,
  });

  test("a total write failure (erroredChunks > 0, written === 0) buckets as errored", () => {
    const result = classifyWriteOutcome(outcome({ erroredChunks: 1 }));
    expect(result).toEqual({
      bucket: "errored",
      turnsWritten: 0,
      turnsExtracted: 0,
      chunkSplits: 0,
      orphanDeleteFailed: false,
      countNonEmptyYieldedZero: false,
      orphansDeleted: 0,
    });
  });

  test("a PARTIAL write (erroredChunks > 0, written > 0) still buckets as errored — never processed", () => {
    const result = classifyWriteOutcome(outcome({ written: 700, erroredChunks: 1 }));
    expect(result).toEqual({
      bucket: "errored",
      turnsWritten: 700,
      turnsExtracted: 0,
      chunkSplits: 0,
      orphanDeleteFailed: false,
      countNonEmptyYieldedZero: false,
      orphansDeleted: 0,
    });
  });

  test("a genuinely-empty transcript (written === 0, nonEmptyYieldedZero false) buckets as skipped, uncounted", () => {
    const result = classifyWriteOutcome(outcome({}));
    expect(result).toEqual({
      bucket: "skipped",
      turnsWritten: 0,
      turnsExtracted: 0,
      chunkSplits: 0,
      orphanDeleteFailed: false,
      countNonEmptyYieldedZero: false,
      orphansDeleted: 0,
    });
  });

  test("mt#2457 SC3: a non-empty-yielded-zero transcript buckets as skipped, but IS counted", () => {
    const result = classifyWriteOutcome(outcome({ nonEmptyYieldedZero: true }));
    expect(result).toEqual({
      bucket: "skipped",
      turnsWritten: 0,
      turnsExtracted: 0,
      chunkSplits: 0,
      orphanDeleteFailed: false,
      countNonEmptyYieldedZero: true,
      orphansDeleted: 0,
    });
  });

  test("a clean write (written > 0, no errors) buckets as processed", () => {
    const result = classifyWriteOutcome(outcome({ written: 5 }));
    expect(result).toEqual({
      bucket: "processed",
      turnsWritten: 5,
      turnsExtracted: 0,
      chunkSplits: 0,
      orphanDeleteFailed: false,
      countNonEmptyYieldedZero: false,
      orphansDeleted: 0,
    });
  });

  test("mt#3514: a failed orphan DELETE buckets as errored even when every chunk upserted cleanly", () => {
    const result = classifyWriteOutcome(outcome({ written: 5, orphanDeleteFailed: true }));
    expect(result.bucket).toBe("errored");
  });

  test("mt#3514: orphansDeleted is carried through on EVERY bucket, including errored", () => {
    expect(classifyWriteOutcome(outcome({ written: 5, orphansDeleted: 3 })).orphansDeleted).toBe(3);
    expect(
      classifyWriteOutcome(outcome({ written: 5, orphansDeleted: 3, erroredChunks: 1 }))
        .orphansDeleted
    ).toBe(3);
    expect(classifyWriteOutcome(outcome({ orphansDeleted: 2 })).orphansDeleted).toBe(2);
  });
});

describe("extractTurnsForAllTranscripts", () => {
  test("aggregates turn counts across transcripts; skips empty ones", async () => {
    const transcriptA: RawTurnLine[] = [
      userLine("a1", TS1),
      assistantLine("ra1", [], TS2),
      userLine("a2", TS3),
      assistantLine("ra2", [], TS4),
    ];
    const transcriptB: RawTurnLine[] = [userLine("b1", TS1), assistantLine("rb1", [], TS2)];
    const transcriptRows: FakeTranscriptRow[] = [
      { agentSessionId: SESSION_A, transcript: transcriptA },
      { agentSessionId: SESSION_B, transcript: transcriptB },
      { agentSessionId: "cccccccc-0000-0000-0000-000000000003", transcript: [] },
    ];
    const store = new Map<string, FakeTurnRow>();

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(transcriptRows, store)), {
      fetchPage: makeFetchPage(transcriptRows).fetchPage,
    });

    expect(result.transcriptsScanned).toBe(3);
    expect(result.transcriptsProcessed).toBe(2);
    expect(result.transcriptsSkipped).toBe(1);
    expect(result.nonEmptyYieldedZero).toBe(0);
    expect(result.turnsWritten).toBe(3); // 2 from A, 1 from B
    expect(result.aborted).toBe(false);
    expect(store.size).toBe(3);
  });

  test("mt#2457 SC3: counts nonEmptyYieldedZero separately from a genuinely-empty skip", async () => {
    const goodTranscript: RawTurnLine[] = [userLine("hi", TS1), assistantLine("yo", [], TS2)];
    const unrecognizedTranscript = [
      { type: "system", timestamp: TS1, message: { role: "system", content: "boot" } },
    ] as unknown as RawTurnLine[];
    const rows: FakeTranscriptRow[] = [
      { agentSessionId: SESSION_A, transcript: goodTranscript },
      { agentSessionId: SESSION_B, transcript: unrecognizedTranscript },
      { agentSessionId: "cccccccc-0000-0000-0000-000000000003", transcript: [] },
    ];
    const store = new Map<string, FakeTurnRow>();

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage: makeFetchPage(rows).fetchPage,
    });

    expect(result.transcriptsScanned).toBe(3);
    expect(result.transcriptsProcessed).toBe(1);
    // Both the unrecognized-shape transcript AND the genuinely-empty one count
    // as "skipped" (written === 0), but only the former is a real failure.
    expect(result.transcriptsSkipped).toBe(2);
    expect(result.nonEmptyYieldedZero).toBe(1);
  });

  test("mt#2457 perf: pages through fetchPage in bounded batches instead of one unbounded load", async () => {
    const rows: FakeTranscriptRow[] = Array.from({ length: 5 }, (_, i) => ({
      agentSessionId: `session-${String(i).padStart(2, "0")}`,
      transcript: [userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2)],
    }));
    const store = new Map<string, FakeTurnRow>();
    const { fetchPage, getCallCount } = makeFetchPage(rows);

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage,
      batchSize: 2,
    });

    expect(result.transcriptsScanned).toBe(5);
    expect(result.transcriptsProcessed).toBe(5);
    // 5 rows at batchSize=2 → pages of 2, 2, 1. The final page is short
    // (1 < batchSize), so the loop stops right there without an extra
    // empty-page round-trip — bounded regardless of corpus size, never one
    // big unbatched load.
    expect(getCallCount()).toBe(3);
  });

  test("mt#2457 perf: resumes from afterId, skipping already-processed rows", async () => {
    const rows: FakeTranscriptRow[] = Array.from({ length: 4 }, (_, i) => ({
      agentSessionId: `session-${String(i).padStart(2, "0")}`,
      transcript: [userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2)],
    }));
    const store = new Map<string, FakeTurnRow>();
    const { fetchPage } = makeFetchPage(rows);

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage,
      afterId: "session-01",
    });

    // Only session-02 and session-03 should have been scanned/written.
    expect(result.transcriptsScanned).toBe(2);
    expect(result.transcriptsProcessed).toBe(2);
    expect(store.size).toBe(2);
    expect(store.has(turnKey("session-00", 0))).toBe(false);
    expect(store.has(turnKey("session-02", 0))).toBe(true);
  });

  test("mt#2457 perf: invokes onBatchComplete with running totals + last id, once per batch", async () => {
    const rows: FakeTranscriptRow[] = Array.from({ length: 3 }, (_, i) => ({
      agentSessionId: `session-${String(i).padStart(2, "0")}`,
      transcript: [userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2)],
    }));
    const store = new Map<string, FakeTurnRow>();
    const { fetchPage } = makeFetchPage(rows);
    const checkpoints: Array<{ scanned: number; lastId: string }> = [];

    await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage,
      batchSize: 1,
      onBatchComplete: (partial, lastId) => {
        checkpoints.push({ scanned: partial.transcriptsScanned, lastId });
      },
    });

    expect(checkpoints).toEqual([
      { scanned: 1, lastId: "session-00" },
      { scanned: 2, lastId: "session-01" },
      { scanned: 3, lastId: "session-02" },
    ]);
  });

  test("mt#2457 R1 review: sets aborted=true and stops the sweep when a batch fetch fails", async () => {
    // Page 1 succeeds (2 rows); page 2's fetch throws. The sweep must stop
    // (not retry indefinitely) AND the returned result must say so via
    // `aborted` — before this fix, only a log line recorded the failure, so a
    // caller reading just the returned counts could not distinguish this from
    // a clean end-of-corpus completion.
    const rows: FakeTranscriptRow[] = Array.from({ length: 2 }, (_, i) => ({
      agentSessionId: `session-${String(i).padStart(2, "0")}`,
      transcript: [userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2)],
    }));
    const store = new Map<string, FakeTurnRow>();
    let fetchCallCount = 0;
    const flakyFetchPage = async (): Promise<TranscriptPageRow[]> => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return rows.map((r) => ({ agentSessionId: r.agentSessionId, transcript: r.transcript }));
      }
      throw new Error("simulated fetch failure");
    };

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage: flakyFetchPage,
      batchSize: 2,
    });

    expect(result.aborted).toBe(true);
    // The first page's rows were still processed before the abort.
    expect(result.transcriptsScanned).toBe(2);
    expect(result.transcriptsProcessed).toBe(2);
    expect(fetchCallCount).toBe(2);
  });

  test("mt#2457 R1 review: a chunk write failure counts as errored (not skipped), even with a partial write", async () => {
    // A transcript spanning 3 bulk-insert chunks (two full + a remainder).
    // Fail only the middle chunk so `written` is > 0 — this must still be
    // classified as `transcriptsErrored`, not folded into
    // `transcriptsProcessed` just because SOME turns landed.
    const REMAINDER = 20;
    const TURN_COUNT = DEFAULT_TURN_CHUNK_SIZE * 2 + REMAINDER;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const rows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript: lines }];
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb(rows, store, undefined, (callIndex) => callIndex === 1);

    const result = await extractTurnsForAllTranscripts(asPg(db), {
      fetchPage: makeFetchPage(rows).fetchPage,
    });

    expect(result.transcriptsScanned).toBe(1);
    expect(result.transcriptsErrored).toBe(1);
    expect(result.transcriptsProcessed).toBe(0);
    expect(result.transcriptsSkipped).toBe(0);
    // The two successful chunks still count toward turnsWritten.
    expect(result.turnsWritten).toBe(DEFAULT_TURN_CHUNK_SIZE + REMAINDER);
    // mt#3911: and the sweep reports what was EXTRACTED alongside it, so the
    // partial write is visible in the aggregate rather than only in the log.
    expect(result.turnsExtracted).toBe(TURN_COUNT);
  });
});

// ── mt#3911: chunk sizing, split-and-retry, and result rendering ────────────

describe("chunk sizing and split-and-retry (mt#3911)", () => {
  /** Build a transcript that extracts to exactly `n` turns. */
  function linesFor(n: number): RawTurnLine[] {
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    return lines;
  }

  test("a chunk that exceeds the statement timeout is SPLIT and retried, not abandoned", async () => {
    // The originating defect: one chunk timed out, `erroredChunks` went to 1,
    // and that ALONE cost the session its orphan removal — the rows were
    // perfectly writable, just not in one statement that size.
    const store = new Map<string, FakeTurnRow>();
    const deleted: { turnIndex: number }[] = [{ turnIndex: 900 }];
    const db = makeDb(
      [],
      store,
      undefined,
      // Anything larger than half a chunk times out; the halves succeed.
      (_callIndex, batchSize) => (batchSize > DEFAULT_TURN_CHUNK_SIZE / 2 ? "timeout" : false),
      () => deleted
    );

    const result = await writeTurnsForTranscript(
      asPg(db),
      SESSION_A,
      linesFor(DEFAULT_TURN_CHUNK_SIZE)
    );

    // Every turn landed, via two half-sized statements.
    expect(result.written).toBe(DEFAULT_TURN_CHUNK_SIZE);
    expect(store.size).toBe(DEFAULT_TURN_CHUNK_SIZE);
    expect(result.chunkSplits).toBe(1);
    // The point of the whole fix: a timeout no longer counts as a chunk error,
    // so the orphan DELETE still runs.
    expect(result.erroredChunks).toBe(0);
    expect(result.orphansDeleted).toBe(1);
  });

  test("a chunk failing for a NON-timeout reason is NOT split — it fails once, immediately", async () => {
    // Splitting a deterministic failure (the U+0000 class of mem#750) would
    // turn one fast failure into a cascade of slow ones, so the retry is
    // deliberately narrow.
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb([], store, undefined, (_callIndex, batchSize) =>
      batchSize > DEFAULT_TURN_CHUNK_SIZE / 2 ? true : false
    );

    const result = await writeTurnsForTranscript(
      asPg(db),
      SESSION_A,
      linesFor(DEFAULT_TURN_CHUNK_SIZE)
    );

    expect(result.erroredChunks).toBe(1);
    expect(result.chunkSplits).toBe(0);
    expect(result.written).toBe(0);
  });

  test("split-and-retry CONVERGES when every attempt times out — it does not loop forever", async () => {
    // Bisection has to bottom out. Without the MIN_TURN_CHUNK_SIZE floor a
    // permanently-timing-out range would split until every chunk was a single
    // row, paying a full timeout per row.
    const store = new Map<string, FakeTurnRow>();
    const attempted: number[] = [];
    const db = makeDb(
      [],
      store,
      (n) => attempted.push(n),
      () => "timeout"
    );

    const result = await writeTurnsForTranscript(
      asPg(db),
      SESSION_A,
      linesFor(DEFAULT_TURN_CHUNK_SIZE)
    );

    expect(result.written).toBe(0);
    expect(result.erroredChunks).toBeGreaterThan(0);
    expect(result.chunkSplits).toBeGreaterThan(0);
    // The floor property itself: bisection halts once a chunk is at or below
    // MIN_TURN_CHUNK_SIZE, so no attempt is ever smaller than half the floor.
    // Asserted over the ATTEMPTED batch sizes rather than a derived chunk
    // count — the count depends on how the halves round, which is arithmetic
    // about the test, not a property of the writer.
    expect(attempted.length).toBeGreaterThan(1);
    expect(Math.min(...attempted)).toBeGreaterThanOrEqual(MIN_TURN_CHUNK_SIZE / 2);
    // And it terminated: every row is accounted for by exactly one failed
    // leaf chunk, with nothing retried into an endless split.
    const leaves = attempted.filter((n) => n <= MIN_TURN_CHUNK_SIZE);
    expect(leaves.reduce((a, b) => a + b, 0)).toBe(DEFAULT_TURN_CHUNK_SIZE);
  });

  test("the orphan DELETE bounds on what was EXTRACTED, not on what was written", async () => {
    // The spec's regression criterion. The bound is single-sourced in the
    // writer (`orphanBound`) and used by both the query and this log line, so
    // pinning the logged value pins the query's bound; swapping it to
    // `written` fails here.
    //
    // Honest limit: a run whose chunks all succeed has written === extracted,
    // so this asserts the VALUE and the single-sourcing, not a case where the
    // two diverge — a partial write skips the delete entirely by design, so no
    // end-to-end run can exhibit the divergence.
    const warnCalls: { message: string }[] = [];
    const logSink: TurnWriterLogSink = {
      warn: (message) => warnCalls.push({ message }),
      error: () => {},
    };
    const TURN_COUNT = 7;
    const db = makeDb([], new Map<string, FakeTurnRow>(), undefined, undefined, () => [
      { turnIndex: 42 },
    ]);

    const result = await writeTurnsForTranscript(
      asPg(db),
      SESSION_A,
      linesFor(TURN_COUNT),
      logSink
    );

    expect(result.extracted).toBe(TURN_COUNT);
    expect(warnCalls.some((c) => c.message.includes(`turn_index >= ${result.extracted}`))).toBe(
      true
    );
  });
});

describe("formatExtractAllTurnsResult (render-from-shape, mt#3911)", () => {
  const base = (over: Partial<ExtractAllTurnsResult> = {}): ExtractAllTurnsResult => ({
    transcriptsScanned: 0,
    transcriptsProcessed: 0,
    transcriptsSkipped: 0,
    transcriptsErrored: 0,
    turnsWritten: 0,
    turnsExtracted: 0,
    chunkSplits: 0,
    orphanDeletesFailed: 0,
    nonEmptyYieldedZero: 0,
    orphansDeleted: 0,
    aborted: false,
    ...over,
  });

  test("surfaces a counter this call site never names — the property the fix is for", () => {
    // mt#3514 added `orphansDeleted`, plumbed it through three modules, and no
    // output site printed it. Here the formatter reads the result's own keys,
    // so the counter appears without anyone editing a field list.
    const rendered = formatExtractAllTurnsResult(
      base({ turnsWritten: 5, turnsExtracted: 5, orphansDeleted: 3 })
    );
    expect(rendered).toContain("orphansDeleted=3");
  });

  test("a partial write renders DEGRADED even when no transcript landed in the errored bucket", () => {
    const rendered = formatExtractAllTurnsResult(base({ turnsExtracted: 604, turnsWritten: 104 }));
    expect(rendered.startsWith("DEGRADED(")).toBe(true);
    // Both numbers present, so the shortfall is readable rather than implied.
    expect(rendered).toContain("turnsExtracted=604");
    expect(rendered).toContain("turnsWritten=104");
  });

  test("a clean run carries no DEGRADED marker, and still reports the two always-shown counters", () => {
    const rendered = formatExtractAllTurnsResult(
      base({ transcriptsProcessed: 1, transcriptsScanned: 1, turnsExtracted: 12, turnsWritten: 12 })
    );
    expect(rendered).not.toContain("DEGRADED");
    expect(rendered).toContain("turnsExtracted=12");
    expect(rendered).toContain("turnsWritten=12");
  });

  test("zero-valued counters stay out of the line, so a clean run reads clean", () => {
    const rendered = formatExtractAllTurnsResult(base({ turnsExtracted: 1, turnsWritten: 1 }));
    expect(rendered).not.toContain("chunkSplits");
    expect(rendered).not.toContain("aborted");
  });

  test("SC5: a NO-OP orphan delete is visible at zero — the shape of the original incident", () => {
    // "the delete ran and found nothing" must be distinguishable from "the
    // delete never ran" from the output line alone, with no database query.
    const rendered = formatExtractAllTurnsResult(base({ turnsExtracted: 604, turnsWritten: 604 }));
    expect(rendered).toContain("orphansDeleted=0");
  });

  test("isDegradedExtraction flags an aborted sweep even when every counter looks healthy", () => {
    expect(isDegradedExtraction(base({ turnsExtracted: 3, turnsWritten: 3, aborted: true }))).toBe(
      true
    );
    expect(isDegradedExtraction(base({ turnsExtracted: 3, turnsWritten: 3 }))).toBe(false);
  });
});

describe("isStatementTimeout (mt#3911)", () => {
  test("recognizes the SQLSTATE for a cancelled statement", () => {
    expect(isStatementTimeout(Object.assign(new Error("nope"), { code: "57014" }))).toBe(true);
  });

  test("recognizes the driver message nested on `cause` — the shape drizzle actually produced", () => {
    const wrapped = Object.assign(new Error("write CHUNK failed"), {
      cause: new Error("canceling statement due to statement timeout"),
    });
    expect(isStatementTimeout(wrapped)).toBe(true);
  });

  test("does NOT match an unrelated failure", () => {
    expect(isStatementTimeout(new Error("duplicate key value violates unique constraint"))).toBe(
      false
    );
    expect(isStatementTimeout(undefined)).toBe(false);
  });
});

describe("AT2 (mt#3911): a failed orphan DELETE is visibly degraded at the CLI", () => {
  test("orphanDeleteFailed reaches the rendered message text, not just the exit code", () => {
    // The spec's acceptance test 2. Walks the real path end to end: a write
    // whose chunks all succeeded but whose orphan DELETE threw must classify
    // as errored, aggregate as a failed transcript, and RENDER as degraded.
    // Before mt#3911 the same run printed `extracted=<n>` and nothing else —
    // indistinguishable from a clean success.
    const written = classifyWriteOutcome({
      extracted: 12,
      written: 12,
      nonEmptyYieldedZero: false,
      erroredChunks: 0,
      orphansDeleted: 0,
      orphanDeleteFailed: true,
      chunkSplits: 0,
    });
    expect(written.bucket).toBe("errored");

    const aggregate: ExtractAllTurnsResult = {
      transcriptsScanned: 1,
      transcriptsProcessed: 0,
      transcriptsSkipped: 0,
      transcriptsErrored: written.bucket === "errored" ? 1 : 0,
      turnsWritten: written.turnsWritten,
      turnsExtracted: written.turnsExtracted,
      chunkSplits: written.chunkSplits,
      orphanDeletesFailed: written.orphanDeleteFailed ? 1 : 0,
      nonEmptyYieldedZero: 0,
      orphansDeleted: written.orphansDeleted,
      aborted: false,
    };

    const rendered = formatExtractAllTurnsResult(aggregate);
    expect(rendered).toContain("DEGRADED");
    expect(rendered).toContain("transcriptsErrored=1");
    // SC5's other half, and the gap PR #2771 R2 caught: the FIELD ITSELF must
    // reach the line. Before that round `orphanDeleteFailed` existed on
    // WriteTurnsResult and was honored by the bucketing, but was carried
    // nowhere the renderer could see — so this assertion passed only via the
    // DEGRADED marker, which several unrelated conditions also set. That is
    // the same plumbed-but-never-rendered defect this task exists to fix, one
    // level down.
    expect(rendered).toContain("orphanDeletesFailed=1");
    // A zero-delete run and a FAILED-delete run must not render identically.
    const cleanRun = formatExtractAllTurnsResult({ ...aggregate, transcriptsErrored: 0 });
    expect(rendered).not.toBe(cleanRun);
  });
});
