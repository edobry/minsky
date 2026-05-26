/**
 * Tests for PerTurnEmbeddingPipeline.
 *
 * Uses in-memory fakes for the DB and EmbeddingService — no real Postgres or
 * OpenAI API calls. Tests cover:
 *  - Per-transcript row count matches expected turn count
 *  - embedding column is non-null after processing
 *  - fts_text auto-populates (via the GENERATED column simulation in fake DB)
 *  - Cost-summary log line emitted at end of run
 *  - N Agent-type tool calls produce N rows with is_spawn_boundary = true
 *  - assistant_text for spawn-boundary turns excludes subagent transcript content
 *  - Idempotent upsert: re-running does not duplicate rows
 *  - Empty/null transcripts are skipped
 *  - Embedding failures degrade gracefully (rows still written, embedding null)
 *
 * @see mt#1352 — per-turn-embedding-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import type { RawTurnLine } from "./transcript-source";
import { PerTurnEmbeddingPipeline } from "./per-turn-embedding-pipeline";
import type { PipelineRunResult } from "./per-turn-embedding-pipeline";
import type { EmbeddingService } from "../ai/embeddings/types";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
const TS3 = "2026-01-01T12:00:00.000Z";
const TS4 = "2026-01-01T13:00:00.000Z";

// ── Fake embeddings ───────────────────────────────────────────────────────────

/** Fixed-dimension fake embedding for deterministic test assertions. */
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 4 }, (_, i) => seed + i * 0.1);
}

function makeFakeEmbeddingService(opts: { failOnCall?: boolean } = {}): EmbeddingService {
  let callCount = 0;
  return {
    async generateEmbedding(content: string): Promise<number[]> {
      if (opts.failOnCall) throw new Error("Simulated embedding failure");
      callCount++;
      return fakeEmbedding(callCount);
    },
    async generateEmbeddings(contents: string[]): Promise<number[][]> {
      if (opts.failOnCall) throw new Error("Simulated embedding failure");
      return contents.map((_, i) => {
        callCount++;
        return fakeEmbedding(callCount + i);
      });
    },
  };
}

// ── Fake DB ───────────────────────────────────────────────────────────────────

/** One row in the fake agent_transcripts store. */
interface FakeTranscriptRow {
  agentSessionId: string;
  transcript: RawTurnLine[] | null;
}

/** One row in the fake agent_transcript_turns store. */
export interface FakeTurnRow {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  toolCalls: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
  embedding: number[] | null;
  /** Simulated GENERATED column: populated when userText or assistantText is set. */
  ftsText: string | null;
  isSpawnBoundary: boolean;
}

/**
 * Creates a minimal fake DB that mimics drizzle's fluent builder surface for
 * the PerTurnEmbeddingPipeline's queries:
 *   (1) select { agentSessionId, transcript } from agent_transcripts
 *   (2) insert ... values(...).onConflictDoUpdate(...) on agent_transcript_turns
 */
function makeDb(transcriptRows: FakeTranscriptRow[], turnsStore: Map<string, FakeTurnRow>) {
  // Key for the turns store: "agentSessionId:turnIndex"
  function turnKey(sessionId: string, turnIndex: number): string {
    return `${sessionId}:${turnIndex}`;
  }

  const db = {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => {
          // The pipeline only selects from agent_transcripts.
          // We detect this by returning our transcript rows.
          return Promise.resolve(
            transcriptRows.map((r) => ({
              agentSessionId: r.agentSessionId,
              transcript: r.transcript,
            }))
          );
        },
      };
    },

    insert(_table: unknown) {
      return {
        values(values: Partial<FakeTurnRow> & { agentSessionId: string; turnIndex: number }) {
          const sid = values.agentSessionId;
          const idx = values.turnIndex;
          const key = turnKey(sid, idx);

          // Simulate GENERATED fts_text column behavior from Postgres.
          const ftsText = [values.userText, values.assistantText].filter(Boolean).join(" ") || null;

          const newRow: FakeTurnRow = {
            agentSessionId: sid,
            turnIndex: idx,
            userText: values.userText ?? null,
            assistantText: values.assistantText ?? null,
            toolCalls: values.toolCalls ?? null,
            startedAt: values.startedAt ?? null,
            endedAt: values.endedAt ?? null,
            embedding: (values.embedding as number[] | undefined) ?? null,
            ftsText,
            isSpawnBoundary: values.isSpawnBoundary ?? false,
          };

          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              // Upsert: overwrite existing row with same key.
              turnsStore.set(key, newRow);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return db;
}

// ── Transcript fixtures ───────────────────────────────────────────────────────

function userLine(text: string, ts = TS1): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

function assistantLine(
  text: string,
  toolCalls: Record<string, unknown>[] = [],
  ts = TS2
): RawTurnLine {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolCalls);
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content },
  };
}

function agentToolCall(id = "toolu_agent_1"): Record<string, unknown> {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: {
      description: "Fix mt#999",
      prompt: "Dispatch to subagent.",
    },
  };
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
          content: [{ type: "text", text: "subagent transcript content here..." }],
        },
      ],
    },
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────

type FakeDb = ReturnType<typeof makeDb>;

function makePipeline(
  db: FakeDb,
  embeddingService: EmbeddingService,
  batchSize = 10
): PerTurnEmbeddingPipeline {
  return new PerTurnEmbeddingPipeline(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    embeddingService,
    { batchSize }
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PerTurnEmbeddingPipeline", () => {
  describe("basic extraction", () => {
    test("per-transcript row count matches expected turn count", async () => {
      // One transcript with two user+assistant pairs → 2 turns.
      const transcript: RawTurnLine[] = [
        userLine("turn 1", TS1),
        assistantLine("response 1", [], TS2),
        userLine("turn 2", TS3),
        assistantLine("response 2", [], TS4),
      ];

      const transcriptRows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript }];
      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb(transcriptRows, turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      const result: PipelineRunResult = await pipeline.run();

      expect(result.transcriptsScanned).toBe(1);
      expect(result.transcriptsProcessed).toBe(1);
      expect(result.turnsWritten).toBe(2);

      // Verify two rows landed in the store.
      const rows = Array.from(turnsStore.values()).filter((r) => r.agentSessionId === SESSION_A);
      expect(rows).toHaveLength(2);
    });

    test("embedding column is non-null after processing", async () => {
      const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi back", [], TS2)];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();

      const rows = Array.from(turnsStore.values());
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.embedding).not.toBeNull();
      expect(Array.isArray(row.embedding)).toBe(true);
      expect((row.embedding as number[]).length).toBeGreaterThan(0);
    });

    test("fts_text auto-populates from the GENERATED column simulation", async () => {
      const transcript: RawTurnLine[] = [
        userLine("search for this", TS1),
        assistantLine("found it here", [], TS2),
      ];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();

      const row = turnsStore.get(`${SESSION_A}:0`);
      expect(row).toBeDefined();
      if (!row) return;
      // fts_text in the fake combines userText and assistantText.
      expect(row.ftsText).not.toBeNull();
      expect(row.ftsText).toContain("search for this");
      expect(row.ftsText).toContain("found it here");
    });

    test("cost-summary: embeddingCallsMade reflects actual calls", async () => {
      // 3 turns with non-empty text → 3 embedding calls
      const transcript: RawTurnLine[] = [
        userLine("q1", TS1),
        assistantLine("a1", [], TS2),
        userLine("q2", TS3),
        assistantLine("a2", [], TS4),
      ];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      const result = await pipeline.run();

      // 2 turns, each with non-empty userText+assistantText → 2 embedding calls
      expect(result.embeddingCallsMade).toBe(2);
      // The result mirrors the cost-summary log line fields.
      expect(result.transcriptsScanned).toBe(1);
      expect(result.transcriptsProcessed).toBe(1);
      expect(result.turnsWritten).toBe(2);
      expect(result.transcriptsErrored).toBe(0);
    });
  });

  describe("spawn-boundary turns", () => {
    test("N Agent tool calls produce N rows with is_spawn_boundary = true", async () => {
      const transcript: RawTurnLine[] = [
        userLine("first task", TS1),
        assistantLine("dispatching first agent", [agentToolCall("toolu_a1")], TS2),
        userLine("second task", TS3),
        assistantLine("dispatching second agent", [agentToolCall("toolu_a2")], TS4),
      ];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();

      const rows = Array.from(turnsStore.values()).filter((r) => r.agentSessionId === SESSION_A);
      const spawnBoundaries = rows.filter((r) => r.isSpawnBoundary === true);
      expect(spawnBoundaries).toHaveLength(2);
    });

    test("spawn-boundary turns: assistant_text excludes subagent transcript content", async () => {
      // The spawn-boundary turn has the Agent tool call.
      // The tool_result user line that follows carries the subagent transcript.
      // extractTurns excludes tool_result blocks from userText — the extractor
      // already enforces this; we verify the end-to-end pipeline honors it.
      const transcript: RawTurnLine[] = [
        userLine("run subagent", TS1),
        assistantLine("dispatching to subagent now.", [agentToolCall("toolu_agent_1")], TS2),
        toolResultLine("toolu_agent_1", TS3),
        assistantLine("subagent completed", [], TS4),
      ];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();

      const rows = Array.from(turnsStore.values()).filter((r) => r.agentSessionId === SESSION_A);

      // The spawn-boundary turn is turn 0.
      const spawnRow = rows.find((r) => r.isSpawnBoundary === true);
      expect(spawnRow).toBeDefined();
      if (!spawnRow) return;

      // assistant_text only has the text block, NOT subagent content.
      expect(spawnRow.assistantText).toBe("dispatching to subagent now.");
      expect(spawnRow.assistantText).not.toContain("subagent transcript content");

      // The key assertion: no row contains "subagent transcript content" in assistantText.
      // (The tool_result user line becomes a partial turn with null content — nothing leaks.)
      for (const row of rows) {
        expect(row.assistantText ?? "").not.toContain("subagent transcript content");
      }
    });

    test("non-spawn-boundary turns have is_spawn_boundary = false", async () => {
      const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi", [], TS2)];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();

      const rows = Array.from(turnsStore.values());
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(row.isSpawnBoundary).toBe(false);
    });
  });

  describe("idempotency", () => {
    test("re-running over the same transcript upserts (no duplicate rows)", async () => {
      const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi", [], TS2)];

      const transcriptRows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript }];
      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb(transcriptRows, turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      await pipeline.run();
      const sizeAfterFirst = turnsStore.size;
      // Run again — should upsert, not append.
      await pipeline.run();

      expect(turnsStore.size).toBe(sizeAfterFirst);
    });
  });

  describe("error handling", () => {
    test("empty transcript is skipped gracefully", async () => {
      const transcriptRows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript: [] }];
      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb(transcriptRows, turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      const result = await pipeline.run();

      expect(result.transcriptsScanned).toBe(1);
      expect(result.transcriptsSkipped).toBe(1);
      expect(result.turnsWritten).toBe(0);
      expect(turnsStore.size).toBe(0);
    });

    test("null transcript is skipped gracefully", async () => {
      const transcriptRows: FakeTranscriptRow[] = [{ agentSessionId: SESSION_A, transcript: null }];
      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb(transcriptRows, turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      const result = await pipeline.run();

      expect(result.transcriptsSkipped).toBe(1);
      expect(turnsStore.size).toBe(0);
    });

    test("embedding failure: rows still written with null embedding", async () => {
      const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi", [], TS2)];

      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb([{ agentSessionId: SESSION_A, transcript }], turnsStore);
      // Fail the embedding service for all calls.
      const pipeline = makePipeline(db, makeFakeEmbeddingService({ failOnCall: true }));

      const result = await pipeline.run();

      // Turn rows should still be written.
      expect(result.turnsWritten).toBe(1);
      const row = turnsStore.get(`${SESSION_A}:0`);
      expect(row).toBeDefined();
      if (!row) return;
      // Embedding is null because the embedding call failed.
      expect(row.embedding).toBeNull();
      // But text content was still written.
      expect(row.userText).toBe("hello");
      expect(row.assistantText).toBe("hi");
    });

    test("multiple transcripts: one failing does not abort the sweep", async () => {
      const transcript: RawTurnLine[] = [userLine("hello", TS1), assistantLine("hi", [], TS2)];

      const transcriptRows: FakeTranscriptRow[] = [
        { agentSessionId: SESSION_A, transcript },
        { agentSessionId: SESSION_B, transcript },
      ];
      const turnsStore = new Map<string, FakeTurnRow>();

      // Override insert to throw on the first transcript only.
      const baseDb = makeDb(transcriptRows, turnsStore);
      let insertCount = 0;
      const db = {
        ...baseDb,
        insert(_table: unknown) {
          insertCount++;
          if (insertCount === 1) {
            return {
              values: (_vals: unknown) => ({
                onConflictDoUpdate: (_opts: unknown): Promise<void> =>
                  Promise.reject(new Error("Simulated insert failure")),
              }),
            };
          }
          return baseDb.insert(_table);
        },
      };

      const pipeline = makePipeline(
        db as unknown as ReturnType<typeof makeDb>,
        makeFakeEmbeddingService()
      );

      const result = await pipeline.run();

      // SESSION_B should succeed even though SESSION_A's first turn failed.
      expect(result.transcriptsScanned).toBe(2);
      // At least one transcript produced some turns.
      expect(result.turnsWritten).toBeGreaterThanOrEqual(1);
    });
  });

  describe("multi-transcript sweep", () => {
    test("sweeps multiple transcripts and counts correctly", async () => {
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
      ];
      const turnsStore = new Map<string, FakeTurnRow>();
      const db = makeDb(transcriptRows, turnsStore);
      const pipeline = makePipeline(db, makeFakeEmbeddingService());

      const result = await pipeline.run();

      expect(result.transcriptsScanned).toBe(2);
      expect(result.transcriptsProcessed).toBe(2);
      expect(result.turnsWritten).toBe(3); // 2 from A, 1 from B
      expect(turnsStore.size).toBe(3);
    });
  });
});
