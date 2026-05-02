/**
 * Unit tests for TranscriptSimilarityService.
 *
 * Uses a fake DB (stubbed .select().from().innerJoin()... chain) and a fake
 * EmbeddingService to verify the service's filtering, exclusion, and metadata
 * attachment behaviour without touching a real database.
 *
 * @see mt#1354 — this file
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TranscriptSimilarityService } from "./transcript-similarity-service";
import type {
  TranscriptTurnResult,
  TranscriptSessionResult,
} from "./transcript-similarity-service";

/**
 * Test seam: the service's constructor takes a real Drizzle PG database, but
 * tests inject a fluent-builder fake. Using a single `as unknown as` shape lets
 * each test cast the fake without re-importing the heavy Postgres type 12×
 * (which the magic-string-duplication rule flagged as a duplication smell).
 */
type DrizzlePgDb = PostgresJsDatabase;

// ── Fake EmbeddingService ─────────────────────────────────────────────────────

class FakeEmbeddingService {
  readonly lastGenerateEmbeddingCall: { text?: string } = {};

  async generateEmbedding(content: string): Promise<number[]> {
    this.lastGenerateEmbeddingCall.text = content;
    // Return a deterministic mock vector.
    return [0.1, 0.2, 0.3];
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    return contents.map(() => [0.1, 0.2, 0.3]);
  }
}

// ── Fake DB builder ──────────────────────────────────────────────────────────
// The service uses a Drizzle-style fluent query builder. We simulate it with
// a chainable fake that returns canned rows at .limit().

type FakeSelectResult = Record<string, unknown>;

function makeFakeDb(rows: FakeSelectResult[], countRows: FakeSelectResult[] = []) {
  let callCount = 0;

  const limitFn = (n: number) => {
    // The first call is the main query; subsequent calls are getMessageCounts.
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(rows.slice(0, n));
    }
    return Promise.resolve(countRows);
  };

  const orderByFn = (_expr: unknown) => ({ limit: limitFn });

  const whereFn = (_condition: unknown) => ({ orderBy: orderByFn, limit: limitFn });

  const innerJoinFn = (_table: unknown, _on: unknown) => ({
    where: whereFn,
    orderBy: orderByFn,
  });

  const fromFn = (_table: unknown) => ({
    innerJoin: innerJoinFn,
    where: whereFn,
    orderBy: orderByFn,
    limit: limitFn,
  });

  const selectFn = (_fields: unknown) => ({ from: fromFn });

  return { select: selectFn };
}

// ── Turn result rows ─────────────────────────────────────────────────────────

function makeTurnRow(overrides: Partial<FakeSelectResult> = {}): FakeSelectResult {
  return {
    agentSessionId: "session-a",
    turnIndex: 0,
    userText: "Hello",
    assistantText: "Hi",
    startedAt: null,
    endedAt: null,
    isSpawnBoundary: false,
    score: 0.12,
    sessionStartedAt: new Date("2025-01-01"),
    sessionModel: "claude-3-5-sonnet",
    relatedTaskIds: ["mt#100"],
    relatedPrNumbers: ["#42"],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TranscriptSimilarityService", () => {
  let embeddingService: FakeEmbeddingService;

  beforeEach(() => {
    embeddingService = new FakeEmbeddingService();
  });

  describe("search", () => {
    test("returns ranked turns with parent-session metadata", async () => {
      const rows = [
        makeTurnRow({ agentSessionId: "session-a", turnIndex: 0, score: 0.1 }),
        makeTurnRow({ agentSessionId: "session-b", turnIndex: 1, score: 0.2 }),
      ];
      const countRows = [
        { agentSessionId: "session-a", count: 5 },
        { agentSessionId: "session-b", count: 3 },
      ];
      const db = makeFakeDb(rows, countRows);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.search("test query", { limit: 5 });

      expect(results).toHaveLength(2);
      const first = results[0] as TranscriptTurnResult;
      expect(first.agentSessionId).toBe("session-a");
      expect(first.turnIndex).toBe(0);
      expect(typeof first.score).toBe("number");
      expect(first.sessionMetadata).toBeDefined();
      expect(first.sessionMetadata.agentSessionId).toBe("session-a");
      expect(first.sessionMetadata.model).toBe("claude-3-5-sonnet");
    });

    test("embeds the query string via EmbeddingService", async () => {
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await svc.search("MCP staleness signaling");

      expect(embeddingService.lastGenerateEmbeddingCall.text).toBe("MCP staleness signaling");
    });

    test("returns empty array when no turns match", async () => {
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.search("no results query");
      expect(results).toHaveLength(0);
    });

    test("propagates embedding errors", async () => {
      const brokenEmbeddingService = {
        generateEmbedding: async () => {
          throw new Error("API unavailable");
        },
        generateEmbeddings: async () => {
          throw new Error("API unavailable");
        },
      };
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(
        db as unknown as DrizzlePgDb,
        brokenEmbeddingService
      );

      await expect(svc.search("query")).rejects.toThrow(/API unavailable/);
    });

    test("result score is always a number", async () => {
      // score may come back as a string from pg driver
      const rows = [makeTurnRow({ score: "0.42" })];
      const db = makeFakeDb(rows, []);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.search("test");
      const result = results[0] as TranscriptTurnResult;
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeCloseTo(0.42);
    });

    test("parentAgentSessionId is null (mt#1327 not yet implemented)", async () => {
      const rows = [makeTurnRow()];
      const db = makeFakeDb(rows, []);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.search("test");
      const result = results[0] as TranscriptTurnResult;
      expect(result.sessionMetadata.parentAgentSessionId).toBeNull();
    });
  });

  describe("findSimilarTurn", () => {
    test("rejects invalid turnId format (no colon separator)", async () => {
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarTurn("bad-format")).rejects.toThrow(/invalid turnId format/);
    });

    test("rejects turnId with non-numeric turnIndex", async () => {
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarTurn("session-a:xyz")).rejects.toThrow(/invalid turnIndex/);
    });

    test("throws when seed turn is not found", async () => {
      // First DB call (seed fetch) returns empty.
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarTurn("session-a:0")).rejects.toThrow(/turn not found/);
    });

    test("throws when seed turn has no embedding", async () => {
      // Return a row with null embedding.
      const seedRows = [{ embedding: null }];
      const db = makeFakeDb(seedRows as FakeSelectResult[]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarTurn("session-a:0")).rejects.toThrow(/no embedding/);
    });
  });

  describe("findSimilarSession", () => {
    test("throws when session is not found", async () => {
      const db = makeFakeDb([]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarSession("unknown-session")).rejects.toThrow(/session not found/);
    });

    test("throws when session has no summary_embedding", async () => {
      const seedRows = [{ summaryEmbedding: null }];
      const db = makeFakeDb(seedRows as FakeSelectResult[]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarSession("session-a")).rejects.toThrow(/no summary_embedding/);
    });

    test("returns session results with score as number", async () => {
      const seedRow: FakeSelectResult = { summaryEmbedding: [0.1, 0.2, 0.3] };
      // Second call is the neighbours query.
      let callCount = 0;
      const db = {
        select: (_fields: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond: unknown) => ({
              orderBy: (_expr: unknown) => ({
                limit: (_n: number) => {
                  callCount++;
                  if (callCount === 1) return Promise.resolve([seedRow]);
                  return Promise.resolve([
                    {
                      agentSessionId: "session-b",
                      startedAt: null,
                      model: null,
                      summary: "A related session",
                      relatedTaskIds: [],
                      relatedPrNumbers: [],
                      score: "0.25",
                    },
                  ]);
                },
              }),
              limit: (_n: number) => {
                callCount++;
                if (callCount === 1) return Promise.resolve([seedRow]);
                return Promise.resolve([]);
              },
            }),
          }),
        }),
      };

      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.findSimilarSession("session-a");
      expect(results).toHaveLength(1);
      const result = results[0] as TranscriptSessionResult;
      expect(result.agentSessionId).toBe("session-b");
      expect(typeof result.score).toBe("number");
      expect(result.parentAgentSessionId).toBeNull();
    });
  });
});
