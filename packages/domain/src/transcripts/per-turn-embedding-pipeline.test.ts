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

import {
  PerTurnEmbeddingPipeline,
  DEFAULT_MAX_CANDIDATES_PER_RUN,
} from "./per-turn-embedding-pipeline";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

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

  // Records the row cap the pipeline asked the DB for, so a test can assert the
  // bound is pushed into the QUERY rather than applied after loading everything
  // (mt#4212 — loading everything is the defect).
  let requestedLimit: number | null = null;

  // How many columns the candidate query ordered by (mt#4623). Null means the
  // query never ordered — which is the state in which the partial index is
  // INERT, so a test asserts against it rather than only against the limit.
  let orderedBy: number | null = null;

  const db = {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            // mt#4623: the candidate query is ORDERED, and the ordering is what
            // makes `idx_agent_transcript_turns_embedding_backlog` usable at all
            // — without it the planner takes a Seq Scan. The fake models the sort
            // rather than swallowing the call, so a run's draw here matches what
            // the real query returns.
            orderBy: (...cols: unknown[]) => {
              orderedBy = cols.length;
              return {
                limit: (n: number) => {
                  requestedLimit = n;
                  const cands = [...store.values()]
                    .filter(
                      (r) =>
                        r.embedding === null && (r.userText !== null || r.assistantText !== null)
                    )
                    .sort(
                      (a, b) =>
                        a.agentSessionId.localeCompare(b.agentSessionId) ||
                        a.turnIndex - b.turnIndex
                    )
                    .slice(0, n);
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
              };
            },
          }),
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

  return {
    db,
    store,
    getRequestedLimit: () => requestedLimit,
    getOrderedBy: () => orderedBy,
  };
}

type FakeDb = ReturnType<typeof makeDb>["db"];
function makePipeline(db: FakeDb, svc: EmbeddingService, batchSize = 10): PerTurnEmbeddingPipeline {
  return new PerTurnEmbeddingPipeline(db as unknown as PostgresJsDatabase, svc, { batchSize });
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
    // 2 turns, default batchSize 10 → 1 generateEmbeddings call.
    expect(result.embeddingCallsMade).toBe(1);
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
    // 3 candidates, batchSize 2 → 2 generateEmbeddings calls (batches of 2 + 1).
    expect(result.embeddingCallsMade).toBe(2);
  });
});

describe("candidate ordering (mt#4623)", () => {
  test("the candidate query orders by the partial index's columns, so the index is usable", async () => {
    const { db, getOrderedBy } = makeDb([
      {
        agentSessionId: SESSION_A,
        turnIndex: 0,
        userText: "t",
        assistantText: null,
        embedding: null,
      },
    ]);

    await makePipeline(db, makeFakeEmbeddingService()).run();

    // Two columns: (agent_session_id, turn_index), matching
    // `idx_agent_transcript_turns_embedding_backlog`. This is not a style
    // preference — measured on a 367,159-row / 313 MB reproduction of
    // production, the planner IGNORES that index without the ordering (Seq
    // Scan, 40,123 buffers, 63.0 ms) and uses it with (Index Scan, 17 buffers,
    // 0.059 ms). It over-estimates the predicate at 141,913 rows against an
    // actual 62, so LIMIT looks satisfiable early in a scan that in fact reads
    // the whole table. An unordered query ships a 16 kB index that nothing
    // reads.
    expect(getOrderedBy()).toBe(2);
  });
});

describe("candidate-load bound (mt#4212)", () => {
  function seedTurns(n: number): SeedTurn[] {
    return Array.from({ length: n }, (_, i) => ({
      agentSessionId: SESSION_A,
      turnIndex: i,
      userText: `turn ${i}`,
      assistantText: null,
      embedding: null,
    }));
  }

  test("the row cap is pushed into the query, not applied after loading", async () => {
    const { db, getRequestedLimit } = makeDb(seedTurns(50));
    const svc = makeFakeEmbeddingService();
    const pipeline = new PerTurnEmbeddingPipeline(db as unknown as PostgresJsDatabase, svc, {
      batchSize: 10,
      maxCandidatesPerRun: 12,
    });

    const result = await pipeline.run();

    // The unbounded SELECT loaded every unembedded turn's full text — 208,715
    // rows / ~159 MB on 2026-08-17 — and the pooler dropped the connection
    // before the pipeline embedded anything.
    expect(getRequestedLimit()).toBe(12);
    expect(result.turnsScanned).toBe(12);
    expect(result.turnsEmbedded).toBe(12);
  });

  test("defaults to DEFAULT_MAX_CANDIDATES_PER_RUN when unset", async () => {
    const { db, getRequestedLimit } = makeDb(seedTurns(3));
    await makePipeline(db, makeFakeEmbeddingService()).run();
    expect(getRequestedLimit()).toBe(DEFAULT_MAX_CANDIDATES_PER_RUN);
  });

  test("successive runs drain a backlog larger than one run's bound", async () => {
    const { db, store } = makeDb(seedTurns(25));
    const svc = makeFakeEmbeddingService();
    const pipeline = new PerTurnEmbeddingPipeline(db as unknown as PostgresJsDatabase, svc, {
      batchSize: 10,
      maxCandidatesPerRun: 10,
    });

    // Progress without an ORDER BY: each embedded turn leaves the candidate set
    // permanently, so the backlog drains regardless of which rows a run draws.
    for (let i = 0; i < 3; i++) await pipeline.run();

    const remaining = [...store.values()].filter((r) => r.embedding === null);
    expect(remaining).toHaveLength(0);
  });
});
