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
import type { ConversationId } from "../ids";
import { TranscriptSimilarityService, buildResumeHint } from "./transcript-similarity-service";

/** Mint a ConversationId from a literal — the documented cast path (`ids.ts`). */
const conv = (id: string) => id as ConversationId;
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

/**
 * WHERE conditions the fake was handed, most recent first (mt#4289).
 *
 * The fake ignores conditions when choosing rows, so an applied filter and a
 * dropped one return the identical canned set — recording the argument is the
 * only way a test can tell them apart. See the FTS suite's `whereTreeFiltersOn`
 * for why a naive column-name walk cannot: every `Column` back-references its
 * `Table`, which holds every column of the table.
 */
let capturedWhereConditions: unknown[] = [];

/**
 * Raw statements the service issued via `execute()` (mt#4919) — today just the
 * `SET LOCAL hnsw.iterative_scan` that `withIterativeScan` emits. Rendered to a
 * string so a test can assert on the SQL text rather than on drizzle's internal
 * chunk representation.
 */
let capturedStatements: string[] = [];

/** The three fragments the mt#4919 assertions look for in the emitted SQL. */
const SET_LOCAL = "SET LOCAL";
const ITERATIVE_SCAN = "hnsw.iterative_scan";
const STRICT_ORDER = "strict_order";

/**
 * Flatten a drizzle SQL template into something assertable.
 *
 * PR #3588 R1 flagged the dependence on drizzle's internal `queryChunks` shape
 * as brittle across upgrades. It is, and the failure direction is the safe one:
 * if that shape changes, this returns `String(statement)` — `"[object Object]"`
 * — which contains none of the substrings the tests assert, so they go RED
 * rather than silently passing. A brittle assertion that fails loudly on an
 * upgrade is the intended trade here; the alternative is asserting nothing
 * about the SQL text at all.
 */
function renderSql(statement: unknown): string {
  const chunks = (statement as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(statement);
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown })?.value;
      return Array.isArray(value) ? value.join("") : "";
    })
    .join("");
}

const SKIP_KEYS = new Set(["table"]);

function whereTreeFiltersOn(trees: unknown[], columnName: string): boolean {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 14 || node === null || typeof node !== "object") return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if ((node as { name?: unknown }).name === columnName) return true;
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (walk(value, depth + 1)) return true;
    }
    return false;
  };
  return trees.some((tree) => walk(tree, 0));
}

function makeFakeDb(rows: FakeSelectResult[], countRows: FakeSelectResult[] = []) {
  let callCount = 0;
  capturedWhereConditions = [];
  capturedStatements = [];

  const executeFn = (statement: unknown) => {
    capturedStatements.push(renderSql(statement));
    return Promise.resolve([]);
  };

  const limitFn = (n: number) => {
    // The first call is the main query; subsequent calls are getMessageCounts.
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(rows.slice(0, n));
    }
    return Promise.resolve(countRows);
  };

  const orderByFn = (_expr: unknown) => ({ limit: limitFn });

  const whereFn = (condition: unknown) => {
    capturedWhereConditions.unshift(condition);
    return { orderBy: orderByFn, limit: limitFn };
  };

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

  const scope = { select: selectFn, execute: executeFn };

  // mt#4919: the vector-ordered queries now run inside a transaction that
  // issues `SET LOCAL hnsw.iterative_scan`. The fake runs the callback against
  // the same scope so query behaviour is unchanged, and records the statements
  // so a test can assert the setting was actually issued.
  const transactionFn = async <T>(run: (tx: typeof scope) => Promise<T> | PromiseLike<T>) =>
    run(scope);

  return { ...scope, transaction: transactionFn };
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
    sessionCwd: "/Users/dev/Projects/minsky",
    relatedTaskIds: ["mt#100"],
    relatedPrNumbers: ["#42"],
    ...overrides,
  };
}

/**
 * The first result's snippet, failing loudly rather than comparing against
 * `undefined` — `snippet` is optional on the shared result type, so an
 * `expect(undefined).toContain(...)` would otherwise report a confusing
 * mismatch instead of "the field was never populated".
 */
function results0(results: TranscriptTurnResult[]): string {
  const snippet = results[0]?.snippet;
  if (snippet === undefined) {
    throw new Error("expected the first result to carry a snippet, got undefined");
  }
  return snippet;
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

    describe("snippet (mt#4917)", () => {
      test("every semantic hit carries a snippet — it carried none at all before", async () => {
        const db = makeFakeDb([makeTurnRow({ userText: "the pooler question" })], []);
        const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

        const results = await svc.search("test query", { limit: 5 });

        expect(results[0]?.snippet).toBe("the pooler question");
      });

      test("prefers the user side, matching the full-text surface's convention", async () => {
        const db = makeFakeDb(
          [makeTurnRow({ userText: "asked this", assistantText: "answered that" })],
          []
        );
        const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

        expect((await svc.search("q", {}))[0]?.snippet).toBe("asked this");
      });

      test("falls through to the assistant side when the user side is null or empty", async () => {
        for (const userText of [null, ""]) {
          const db = makeFakeDb([makeTurnRow({ userText, assistantText: "answered that" })], []);
          const svc = new TranscriptSimilarityService(
            db as unknown as DrizzlePgDb,
            embeddingService
          );
          expect((await svc.search("q", {}))[0]?.snippet).toBe("answered that");
        }
      });

      test("is bounded — a huge turn does not become a huge snippet", async () => {
        // The reason the field exists: a transcript turn runs to hundreds of
        // kilobytes, and the whole point is that a hit can be read without it.
        const db = makeFakeDb([makeTurnRow({ userText: "word ".repeat(50_000) })], []);
        const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

        const snippet = results0(await svc.search("q", {}));
        // 400 chars of text plus the single ellipsis truncateSnippet appends.
        expect(snippet.length).toBeLessThanOrEqual(401);
        expect(snippet.endsWith("…")).toBe(true);
      });

      test("strips harness markup rather than quoting it back", async () => {
        const db = makeFakeDb(
          [makeTurnRow({ userText: "<system-reminder>ignore me</system-reminder>real prose" })],
          []
        );
        const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

        const snippet = results0(await svc.search("q", {}));
        expect(snippet).not.toContain("system-reminder");
        expect(snippet).toContain("real prose");
      });

      test("a turn with no text at all yields an empty snippet, not undefined", async () => {
        const db = makeFakeDb([makeTurnRow({ userText: null, assistantText: null })], []);
        const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

        expect((await svc.search("q", {}))[0]?.snippet).toBe("");
      });
    });

    test("resumeHint (mt#2523, mt#3440): each result carries a directory-pinned resume hint", async () => {
      const rows = [makeTurnRow({ agentSessionId: "session-resume-me" })];
      const db = makeFakeDb(rows, [{ agentSessionId: "session-resume-me", count: 1 }]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      const results = await svc.search("test query");
      expect(results[0]?.resumeHint).toBe(
        "cd '/Users/dev/Projects/minsky' && claude --resume session-resume-me"
      );
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

      await expect(svc.findSimilarSession(conv("unknown-session"))).rejects.toThrow(
        /session not found/
      );
    });

    test("throws when session has no summary_embedding", async () => {
      const seedRows = [{ summaryEmbedding: null }];
      const db = makeFakeDb(seedRows as FakeSelectResult[]);
      const svc = new TranscriptSimilarityService(db as unknown as DrizzlePgDb, embeddingService);

      await expect(svc.findSimilarSession(conv("session-a"))).rejects.toThrow(
        /no summary_embedding/
      );
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

      const results = await svc.findSimilarSession(conv("session-a"));
      expect(results).toHaveLength(1);
      const result = results[0] as TranscriptSessionResult;
      expect(result.agentSessionId).toBe("session-b");
      expect(typeof result.score).toBe("number");
      expect(result.parentAgentSessionId).toBeNull();
    });
  });
});

// ── buildResumeHint (mt#3440) ─────────────────────────────────────────────────

describe("buildResumeHint (mt#3440)", () => {
  // The defect: the hint used to be a bare `claude --resume <id>`, which fails
  // from any directory other than the conversation's own with
  // "No conversation found with session ID" — indistinguishable from the
  // conversation being gone. Reproduced against the live binary in the task's
  // Planning Audit; these tests pin the corrected shape.

  test("AT1: with a known cwd, the command is runnable from anywhere", () => {
    expect(buildResumeHint("abc-123", "/Users/dev/Projects/minsky")).toBe(
      "cd '/Users/dev/Projects/minsky' && claude --resume abc-123"
    );
  });

  test("AT2: with no recorded cwd, it says so instead of emitting a silently-failing command", () => {
    const hint = buildResumeHint("abc-123", null);
    // Must NOT be the bare command that would fail from the wrong directory
    // without explanation.
    expect(hint).not.toBe("claude --resume abc-123");
    expect(hint).toContain("claude --resume abc-123");
    expect(hint).toContain("not recorded");
    // Still a valid single-line shell command (the explanation is a comment).
    expect(hint).toContain("#");
  });

  test("AT2: undefined cwd is treated the same as null", () => {
    expect(buildResumeHint("abc-123", undefined)).toBe(buildResumeHint("abc-123", null));
    expect(buildResumeHint("abc-123")).toBe(buildResumeHint("abc-123", null));
  });

  test("AT2: an empty-string cwd degrades to the unknown form, not `cd ''`", () => {
    expect(buildResumeHint("abc-123", "")).toBe(buildResumeHint("abc-123", null));
  });

  test("AT3: a cwd containing spaces is quoted", () => {
    expect(buildResumeHint("abc-123", "/Users/dev/My Projects/minsky")).toBe(
      "cd '/Users/dev/My Projects/minsky' && claude --resume abc-123"
    );
  });

  test("AT3: a cwd containing a single quote is escaped, not left to break the command", () => {
    expect(buildResumeHint("abc-123", "/Users/dev/it's/minsky")).toBe(
      `cd '/Users/dev/it'\\''s/minsky' && claude --resume abc-123`
    );
  });
});

// ── originKind filter parity with the FTS surface (mt#4289) ──────────────────

describe("TranscriptSimilarityService — originKind (mt#4289)", () => {
  test("search() carries userOrigin through to the result", async () => {
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow({ userOrigin: "compact_summary" })]) as never,
      new FakeEmbeddingService() as never
    );

    const results = await svc.search("anything");

    expect(results[0]?.userOrigin).toBe("compact_summary");
  });

  test("search() filters on user_origin when originKind is given, and not otherwise", async () => {
    // PR #3182 R1 (BLOCKING): the field shipped on this surface but the FILTER
    // did not, so `originKind` worked on FTS and silently did nothing here —
    // two search surfaces answering the same question differently.
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );
    await svc.search("anything", { role: "user" });
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_origin")).toBe(false);
    // Positive control for the probe: `role: "user"` DOES filter on user_text.
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_text")).toBe(true);

    const svc2 = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );
    await svc2.search("anything", { role: "user", originKind: "human" });
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_origin")).toBe(true);
  });
});

/**
 * mt#4919 — the iterative-scan setting.
 *
 * **What these tests prove, and what they do NOT.** The defect is a property of
 * the LIVE pgvector index — a filter applied after a bounded HNSW scan — so no
 * fake can reproduce it, and none of these assert that recall is actually
 * fixed. They assert the narrower thing a unit test CAN own: that the service
 * issues the setting, on the right statements, with the right value. The recall
 * claim itself is verified against prod and recorded in the PR body and in
 * mt#4919's spec; treat that as the evidence, not this file.
 */
describe("TranscriptSimilarityService — iterative scan (mt#4919)", () => {
  test("search() issues SET LOCAL hnsw.iterative_scan around the vector query", async () => {
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );

    await svc.search("anything", { limit: 20, role: "user" });

    expect(capturedStatements).toHaveLength(1);
    expect(capturedStatements[0]).toContain(ITERATIVE_SCAN);
  });

  test("it is SET LOCAL, not a bare SET — the setting must not outlive the transaction", async () => {
    // A bare SET persists on a POOLED connection and would silently change
    // every later query issued by any other caller that happens to get it.
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );

    await svc.search("anything", {});

    expect(capturedStatements[0]).toContain(SET_LOCAL);
  });

  test("it is strict_order — relaxed_order would give up exact distance ordering", async () => {
    // Both values fix the recall problem (measured); strict_order is chosen so a
    // ranked surface keeps its ranking. Pinned so a later edit has to be
    // deliberate rather than incidental.
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );

    await svc.search("anything", {});

    expect(capturedStatements[0]).toContain(STRICT_ORDER);
    expect(capturedStatements[0]).not.toContain("relaxed_order");
  });

  test("findSimilarTurn() issues it too — it filters, so it has the same exposure", async () => {
    // PR #3588 R1: only search() was covered. findSimilarTurn wraps the same
    // way and needs its own assertion, so removing one wrapper cannot pass.
    //
    // Its own fake rather than makeFakeDb: this method issues THREE selects
    // (seed embedding, then neighbours, then message counts) where search()
    // issues two, and the shared fake's call-ordering is built for the latter.
    const statements: string[] = [];
    let selectCount = 0;
    const scope: Record<string, unknown> = {
      execute: (statement: unknown) => {
        statements.push(renderSql(statement));
        return Promise.resolve([]);
      },
      transaction: <T>(run: (tx: unknown) => Promise<T> | PromiseLike<T>) => run(scope),
      select: (_fields?: unknown) => {
        selectCount++;
        const resolve = (n?: number) => {
          // 1: the seed turn's embedding. 2: the neighbours. 3+: message counts.
          if (selectCount === 1) return Promise.resolve([{ embedding: [0.1, 0.2, 0.3] }]);
          if (selectCount === 2) return Promise.resolve([makeTurnRow()].slice(0, n));
          return Promise.resolve([]);
        };
        // Every builder step returns the same tail, so any chain order the
        // service uses resolves — `.from().innerJoin().where().orderBy().limit()`
        // for the neighbour query, `.from().where().limit()` for the seed.
        const tail: Record<string, unknown> = {
          orderBy: () => tail,
          where: () => tail,
          innerJoin: () => tail,
          groupBy: () => Promise.resolve([]),
          limit: resolve,
        };
        return { from: () => tail };
      },
    };

    const svc = new TranscriptSimilarityService(
      scope as never,
      new FakeEmbeddingService() as never
    );

    await svc.findSimilarTurn("session-a:0", { limit: 20, originKind: "human" });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(SET_LOCAL);
    expect(statements[0]).toContain(ITERATIVE_SCAN);
    expect(statements[0]).toContain(STRICT_ORDER);
  });

  test("the setting is issued even with no filters — the scan saturates regardless", async () => {
    // Measured: unfiltered, limits [5,10,15,20,30,50] returned
    // [5,10,15,20,30,41]. The ANN candidate budget caps a large-limit query
    // whether or not a filter is present, so this is not conditional on opts.
    const svc = new TranscriptSimilarityService(
      makeFakeDb([makeTurnRow()]) as never,
      new FakeEmbeddingService() as never
    );

    await svc.search("anything", { limit: 50 });

    expect(capturedStatements).toHaveLength(1);
    expect(capturedStatements[0]).toContain(ITERATIVE_SCAN);
  });
});
