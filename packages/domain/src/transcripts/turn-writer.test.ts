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

import { describe, test, expect, spyOn } from "bun:test";

import type { RawTurnLine } from "./transcript-source";
import {
  writeTurnsForTranscript,
  extractTurnsForAllTranscripts,
  type TranscriptPageRow,
} from "./turn-writer";
import { log } from "@minsky/shared/logger";

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
 * Crucially, the upsert SIMULATES the embedding-preservation invariant: because
 * writeTurnsForTranscript never includes `embedding` in `values`, on conflict the
 * fake leaves the existing row's `embedding` untouched (matching a SET clause that
 * omits the embedding column).
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
   */
  failInsertCall?: (callIndex: number, batchSize: number) => boolean
) {
  type TurnValues = Partial<FakeTurnRow> & { agentSessionId: string; turnIndex: number };
  let insertCallIndex = -1;

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

  return {
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
              if (failInsertCall?.(callIndex, rows.length)) {
                return Promise.reject(new Error(`simulated insert failure (call ${callIndex})`));
              }
              for (const row of rows) upsertOne(row);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
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
    // A session with more turns than the chunk size (500) — build 1,200 turns
    // (2,400 raw lines) so the write spans 3 chunks (500 + 500 + 200). Before
    // mt#2457 this was 1,200 individual awaited INSERT round-trips; a handful
    // of legacy sessions in the real corpus run into the thousands of turns,
    // which made even a single session's reconciliation take on the order of
    // a minute over a remote Postgres connection.
    const TURN_COUNT = 1200;
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
    // 3 bulk-insert calls (500 + 500 + 200), not 1,200 single-row calls.
    expect(batchSizes).toEqual([500, 500, 200]);
  });

  test("mt#2457 R1 review: a failed chunk upsert is counted via erroredChunks, not silently swallowed", async () => {
    // 1,200 turns → 3 chunks (500 + 500 + 200). Fail only the SECOND chunk
    // (call index 1) so this also verifies a PARTIAL failure: chunk 1 and 3
    // succeed (written should reflect only the successful chunks), but the
    // transcript as a whole must be flagged as having an error.
    const TURN_COUNT = 1200;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb([], store, undefined, (callIndex) => callIndex === 1);

    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    const result = await writeTurnsForTranscript(asPg(db), SESSION_A, lines);

    expect(result.erroredChunks).toBe(1);
    // Only the two successful chunks (500 + 200) landed; the failed middle
    // chunk (500) did not silently count as written.
    expect(result.written).toBe(700);
    expect(store.size).toBe(700);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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

    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    const result = await writeTurnsForTranscript(
      asPg(makeDb([], store)),
      SESSION_A,
      unrecognizedTranscript
    );

    expect(result.written).toBe(0);
    expect(result.nonEmptyYieldedZero).toBe(true);
    expect(store.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("yielded");
    warnSpy.mockRestore();
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

    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage: makeFetchPage(rows).fetchPage,
    });
    warnSpy.mockRestore();

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

    const errorSpy = spyOn(log, "error").mockImplementation(() => {});
    const result = await extractTurnsForAllTranscripts(asPg(makeDb(rows, store)), {
      fetchPage: flakyFetchPage,
      batchSize: 2,
    });
    errorSpy.mockRestore();

    expect(result.aborted).toBe(true);
    // The first page's rows were still processed before the abort.
    expect(result.transcriptsScanned).toBe(2);
    expect(result.transcriptsProcessed).toBe(2);
    expect(fetchCallCount).toBe(2);
  });

  test("mt#2457 R1 review: a chunk write failure counts as errored (not skipped), even with a partial write", async () => {
    // A 1,200-turn transcript spans 3 bulk-insert chunks (500 + 500 + 200).
    // Fail only the middle chunk so `written` (700) is > 0 — this must still
    // be classified as `transcriptsErrored`, not folded into
    // `transcriptsProcessed` just because SOME turns landed.
    const TURN_COUNT = 1200;
    const lines: RawTurnLine[] = [];
    for (let i = 0; i < TURN_COUNT; i++) {
      lines.push(userLine(`u${i}`, TS1), assistantLine(`a${i}`, [], TS2));
    }
    const rows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript: lines }];
    const store = new Map<string, FakeTurnRow>();
    const db = makeDb(rows, store, undefined, (callIndex) => callIndex === 1);

    const warnSpy = spyOn(log, "warn").mockImplementation(() => {});
    const result = await extractTurnsForAllTranscripts(asPg(db), {
      fetchPage: makeFetchPage(rows).fetchPage,
    });
    warnSpy.mockRestore();

    expect(result.transcriptsScanned).toBe(1);
    expect(result.transcriptsErrored).toBe(1);
    expect(result.transcriptsProcessed).toBe(0);
    expect(result.transcriptsSkipped).toBe(0);
    // The two successful chunks (500 + 200) still count toward turnsWritten.
    expect(result.turnsWritten).toBe(700);
  });
});
