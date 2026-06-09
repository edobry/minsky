/**
 * Tests for PerTurnEmbeddingPipeline — the vector-only embedding backfill (ADR-019).
 *
 * The pipeline no longer extracts turns (that moved to turn-writer.ts). It
 * selects turn rows whose `embedding IS NULL`, embeds their text, and UPDATEs
 * only the `embedding` column. Tests cover:
 *  - embeds null-embedding turns and writes the vector
 *  - already-embedded turns are not selected (so not re-embedded)
 *  - empty candidate set → no embedding calls
 *  - embedding batch failure → turnsErrored, no embedding written
 *  - batching across batchSize
 *
 * @see ./per-turn-embedding-pipeline.ts
 * @see mt#2381
 */

import { describe, test, expect } from "bun:test";

import { PerTurnEmbeddingPipeline } from "./per-turn-embedding-pipeline";
import type { EmbeddingService } from "../ai/embeddings/types";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";

// ── Fake embedding service ──────────────────────────────────────────────────

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 4 }, (_, i) => seed + i * 0.1);
}

function makeFakeEmbeddingService(opts: { failOnCall?: boolean } = {}): EmbeddingService & {
  calls: number;
} {
  const svc = {
    calls: 0,
    async generateEmbedding(_content: string): Promise<number[]> {
      if (opts.failOnCall) throw new Error("Simulated embedding failure");
      svc.calls++;
      return fakeEmbedding(svc.calls);
    },
    async generateEmbeddings(contents: string[]): Promise<number[][]> {
      if (opts.failOnCall) throw new Error("Simulated embedding failure");
      return contents.map(() => {
        svc.calls++;
        return fakeEmbedding(svc.calls);
      });
    },
  };
  return svc;
}

// ── Fake DB: select(null-embedding turns) + update(embedding) ────────────────

interface SeedTurn {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  embedding: number[] | null;
}

function key(sid: string, idx: number): string {
  return `${sid}:${idx}`;
}

/**
 * Models the two queries the vector-only pipeline issues:
 *   select({...}).from(turns).where(embedding IS NULL AND has-text [AND session])
 *   update(turns).set({embedding}).where(session, turnIndex)
 *
 * The select returns rows with `embedding === null` and at least one non-null
 * text column (mirroring the SQL WHERE). Updates are applied to candidates in
 * select order (the pipeline preserves order), so the fake correlates each
 * update to the next selected candidate via a FIFO of keys.
 */
function makeDb(seed: SeedTurn[]) {
  const store = new Map<string, SeedTurn>();
  for (const s of seed) store.set(key(s.agentSessionId, s.turnIndex), { ...s });
  let selectOrder: string[] = [];
  let ptr = 0;

  const db = {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => {
            const cands = [...store.values()].filter(
              (r) => r.embedding === null && (r.userText !== null || r.assistantText !== null)
            );
            selectOrder = cands.map((r) => key(r.agentSessionId, r.turnIndex));
            ptr = 0;
            return Promise.resolve(
              cands.map((r) => ({
                agentSessionId: r.agentSessionId,
                turnIndex: r.turnIndex,
                userText: r.userText,
                assistantText: r.assistantText,
              }))
            );
          },
        }),
      };
    },
    update(_table: unknown) {
      return {
        set(vals: { embedding?: number[] }) {
          return {
            where: (_cond: unknown): Promise<void> => {
              const k = selectOrder[ptr++];
              if (k && store.has(k)) {
                const row = store.get(k);
                if (row) row.embedding = vals.embedding ?? null;
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return { db, store };
}

type FakeDb = ReturnType<typeof makeDb>["db"];
function makePipeline(db: FakeDb, svc: EmbeddingService, batchSize = 10): PerTurnEmbeddingPipeline {
  return new PerTurnEmbeddingPipeline(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    svc,
    { batchSize }
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PerTurnEmbeddingPipeline (vector-only backfill)", () => {
  test("embeds null-embedding turns and writes the vector", async () => {
    const { db, store } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "q1",
        assistantText: "a1",
        embedding: null,
      },
      {
        agentSessionId: SESSION_A,
        turnIndex: 1,
        userText: "q2",
        assistantText: "a2",
        embedding: null,
      },
    ]);
    const result = await makePipeline(db, makeFakeEmbeddingService()).run();

    expect(result.turnsScanned).toBe(2);
    expect(result.turnsEmbedded).toBe(2);
    expect(result.turnsErrored).toBe(0);
    expect(result.embeddingCallsMade).toBe(2);
    expect(store.get(key(SESSION_A, 0))?.embedding).not.toBeNull();
    expect(store.get(key(SESSION_A, 1))?.embedding).not.toBeNull();
  });

  test("already-embedded turns are not selected (not re-embedded)", async () => {
    const existing = [9, 9, 9, 9];
    const { db, store } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "embedded",
        assistantText: "x",
        embedding: existing,
      },
      {
        agentSessionId: SESSION_A,
        turnIndex: 1,
        userText: "fresh",
        assistantText: "y",
        embedding: null,
      },
    ]);
    const svc = makeFakeEmbeddingService();
    const result = await makePipeline(db, svc).run();

    // Only the null-embedding row is a candidate.
    expect(result.turnsScanned).toBe(1);
    expect(result.turnsEmbedded).toBe(1);
    // The already-embedded row keeps its exact vector.
    expect(store.get(key(SESSION_A, 0))?.embedding).toBe(existing);
    expect(store.get(key(SESSION_A, 1))?.embedding).not.toBeNull();
  });

  test("empty candidate set → no embedding calls", async () => {
    const { db } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "x",
        assistantText: "y",
        embedding: [1, 2, 3, 4],
      },
    ]);
    const svc = makeFakeEmbeddingService();
    const result = await makePipeline(db, svc).run();

    expect(result.turnsScanned).toBe(0);
    expect(result.embeddingCallsMade).toBe(0);
    expect(svc.calls).toBe(0);
  });

  test("embedding batch failure → turnsErrored, embedding stays null", async () => {
    const { db, store } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "q",
        assistantText: "a",
        embedding: null,
      },
    ]);
    const result = await makePipeline(db, makeFakeEmbeddingService({ failOnCall: true })).run();

    expect(result.turnsScanned).toBe(1);
    expect(result.turnsEmbedded).toBe(0);
    expect(result.turnsErrored).toBe(1);
    expect(store.get(key(SESSION_A, 0))?.embedding).toBeNull();
  });

  test("batches across batchSize (3 candidates, batchSize 2 → all embedded)", async () => {
    const { db } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "1",
        assistantText: null,
        embedding: null,
      },
      {
        agentSessionId: SESSION_A,
        turnIndex: 1,
        userText: "2",
        assistantText: null,
        embedding: null,
      },
      {
        agentSessionId: SESSION_A,
        turnIndex: 2,
        userText: "3",
        assistantText: null,
        embedding: null,
      },
    ]);
    const result = await makePipeline(db, makeFakeEmbeddingService(), 2).run();

    expect(result.turnsScanned).toBe(3);
    expect(result.turnsEmbedded).toBe(3);
    expect(result.embeddingCallsMade).toBe(3);
  });
});
