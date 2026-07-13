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
 *
 * @see ./turn-writer.ts
 * @see mt#2381
 */

import { describe, test, expect } from "bun:test";

import type { RawTurnLine } from "./transcript-source";
import { writeTurnsForTranscript, extractTurnsForAllTranscripts } from "./turn-writer";

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
 * Crucially, the upsert SIMULATES the embedding-preservation invariant: because
 * writeTurnsForTranscript never includes `embedding` in `values`, on conflict the
 * fake leaves the existing row's `embedding` untouched (matching a SET clause that
 * omits the embedding column).
 */
function makeDb(transcriptRows: FakeTranscriptRow[], store: Map<string, FakeTurnRow>) {
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
        values(v: Partial<FakeTurnRow> & { agentSessionId: string; turnIndex: number }) {
          const key = turnKey(v.agentSessionId, v.turnIndex);
          const ftsText = [v.userText, v.assistantText].filter(Boolean).join(" ") || null;
          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
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

    const written = await writeTurnsForTranscript(asPg(db), SESSION_A, transcript);

    expect(written).toBe(2);
    expect(store.size).toBe(2);
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

  test("empty transcript → 0 rows", async () => {
    const store = new Map<string, FakeTurnRow>();
    expect(await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, [])).toBe(0);
    expect(store.size).toBe(0);
  });

  test("null transcript → 0 rows", async () => {
    const store = new Map<string, FakeTurnRow>();
    expect(await writeTurnsForTranscript(asPg(makeDb([], store)), SESSION_A, null)).toBe(0);
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

    const result = await extractTurnsForAllTranscripts(asPg(makeDb(transcriptRows, store)));

    expect(result.transcriptsScanned).toBe(3);
    expect(result.transcriptsProcessed).toBe(2);
    expect(result.transcriptsSkipped).toBe(1);
    expect(result.turnsWritten).toBe(3); // 2 from A, 1 from B
    expect(store.size).toBe(3);
  });
});
