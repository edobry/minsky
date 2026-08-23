/**
 * Unit tests for TranscriptFtsService.
 *
 * Uses a fake DB (stubbed .select().from()... chain) that discriminates
 * queries by the selected column set, so `searchText` and `getSession`
 * each get the right canned rows regardless of call order.
 *
 * Query detection heuristic (matches actual service select() calls):
 *   - turn rows:      "turnIndex" in cols && "userText" in cols
 *   - existence:      "agentSessionId" in cols && Object.keys(cols).length === 1
 *   - count/groupBy:  everything else (agentSessionId + count)
 *
 * @see mt#1355 — this file
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ConversationId } from "../ids";
import { TranscriptFtsService } from "./transcript-fts-service";
import type { TranscriptTurnResult } from "./transcript-fts-service";

/** Mint a ConversationId from a literal — the documented cast path (`ids.ts`). */
const conv = (id: string) => id as ConversationId;

// ── Type alias for the heavy Drizzle type ────────────────────────────────────

type DrizzlePgDb = PostgresJsDatabase;

// ── Fake row helpers ──────────────────────────────────────────────────────────

type FakeRow = Record<string, unknown>;

function makeTurnRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    agentSessionId: "session-a",
    turnIndex: 0,
    userText: "Hello from user",
    assistantText: "Hi from assistant",
    startedAt: null,
    endedAt: null,
    isSpawnBoundary: false,
    score: 0.85,
    sessionStartedAt: new Date("2025-01-01"),
    sessionModel: "claude-3-5-sonnet",
    sessionCwd: "/Users/dev/Projects/minsky",
    relatedTaskIds: ["mt#100"],
    relatedPrNumbers: ["#42"],
    ...overrides,
  };
}

function makeCountRow(sessionId: string, count: number): FakeRow {
  return { agentSessionId: sessionId, count };
}

function makeExistenceRow(sessionId: string): FakeRow {
  return { agentSessionId: sessionId };
}

// ── Column-set detection helpers ──────────────────────────────────────────────

function isTurnSelectCols(cols: unknown): boolean {
  if (!cols || typeof cols !== "object") return false;
  return "turnIndex" in (cols as object) && "userText" in (cols as object);
}

function isExistenceSelectCols(cols: unknown): boolean {
  if (!cols || typeof cols !== "object") return false;
  const keys = Object.keys(cols as object);
  return keys.length === 1 && "agentSessionId" in (cols as object);
}

// ── Fake DB factory ───────────────────────────────────────────────────────────

/**
 * Builds a fake Drizzle-style fluent DB stub.
 *
 * The select() call receives the column map; we inspect it to decide which
 * canned result set to return. This avoids the prior bug where a fixed ordered
 * list of results was consumed in the wrong order.
 *
 * @param turnRows     Rows returned for turn-column queries.
 * @param countRows    Rows returned for count/groupBy queries.
 * @param existenceRows Rows returned for existence-check queries (single agentSessionId col).
 */
/**
 * WHERE conditions the fake was handed, most recent first (mt#4289).
 *
 * The fake deliberately IGNORES conditions when deciding what to return — that
 * is what keeps it simple. But a filter that is never applied and a filter
 * applied correctly produce identical canned rows here, so a result-only
 * assertion cannot tell them apart. Recording the argument lets a test assert
 * the condition was BUILT, which is the half of the filter this fake can see.
 */
let capturedWhereConditions: unknown[] = [];

/**
 * True iff a captured WHERE tree filters on a column with this DB name.
 *
 * Two cheaper probes were tried first and BOTH were can't-fail (mem#704):
 *
 * - A plain recursive column-name search returns true either way, because every
 *   condition carries a `Column`, every `Column` back-references its `Table`,
 *   and the table object holds every column of the table. Hence `SKIP_KEYS`.
 * - `queryChunks.length` does not vary: drizzle's `and()` renders as a fixed
 *   3-chunk shape (open paren, joined body, close paren) whatever the condition
 *   count. Measured directly, 2 conditions and 3 conditions both give 3.
 *
 * The version below was checked against a positive control (`user_text`, which
 * IS filtered in both arms) before being used to assert a negative.
 */
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

function makeFakeDb(
  turnRows: FakeRow[],
  countRows: FakeRow[] = [],
  existenceRows: FakeRow[] = []
): DrizzlePgDb {
  let selectedCols: unknown = null;
  capturedWhereConditions = [];

  // We store cols at select() time and read them at limit()/resolve time.
  const resolveFn = (n?: number): Promise<FakeRow[]> => {
    if (isTurnSelectCols(selectedCols)) {
      const result = n !== undefined ? turnRows.slice(0, n) : turnRows;
      return Promise.resolve(result);
    }
    if (isExistenceSelectCols(selectedCols)) {
      const result = n !== undefined ? existenceRows.slice(0, n) : existenceRows;
      return Promise.resolve(result);
    }
    // groupBy count query
    return Promise.resolve(countRows);
  };

  // Build the fluent chain. Every path that the service calls must return
  // an object with the next method in the chain.
  const limitFn = (n: number) => resolveFn(n);
  const orderByFn = (_expr: unknown) => ({
    limit: limitFn,
    then: resolveFn(undefined).then.bind(resolveFn(undefined)),
  });
  const groupByFn = (_col: unknown) => ({
    then: (resolve: (v: FakeRow[]) => unknown) => resolveFn().then(resolve),
  });
  const whereFn = (cond: unknown) => {
    capturedWhereConditions.unshift(cond);
    return {
      orderBy: orderByFn,
      limit: limitFn,
      groupBy: groupByFn,
      then: (resolve: (v: FakeRow[]) => unknown) => resolveFn().then(resolve),
    };
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
    groupBy: groupByFn,
    then: (resolve: (v: FakeRow[]) => unknown) => resolveFn().then(resolve),
  });
  const selectFn = (cols: unknown) => {
    selectedCols = cols;
    return { from: fromFn };
  };

  return { select: selectFn } as unknown as DrizzlePgDb;
}

// ── Tests: searchText ─────────────────────────────────────────────────────────

describe("TranscriptFtsService", () => {
  describe("searchText", () => {
    test("returns ranked turns with parent-session metadata attached", async () => {
      const turnRows = [
        makeTurnRow({ agentSessionId: "session-a", turnIndex: 0, score: 0.9 }),
        makeTurnRow({ agentSessionId: "session-b", turnIndex: 1, score: 0.7 }),
      ];
      const countRows = [makeCountRow("session-a", 5), makeCountRow("session-b", 3)];
      const db = makeFakeDb(turnRows, countRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("hello");

      expect(results).toHaveLength(2);
      const first = results[0] as TranscriptTurnResult;
      expect(first.agentSessionId).toBe("session-a");
      expect(first.turnIndex).toBe(0);
      expect(first.sessionMetadata).toBeDefined();
      expect(first.sessionMetadata.agentSessionId).toBe("session-a");
      expect(first.sessionMetadata.model).toBe("claude-3-5-sonnet");
      expect(first.sessionMetadata.relatedTaskIds).toEqual(["mt#100"]);
      expect(first.sessionMetadata.relatedPrNumbers).toEqual(["#42"]);
    });

    test("returns empty array when no turns match", async () => {
      const db = makeFakeDb([], []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("unmatched query");
      expect(results).toHaveLength(0);
    });

    test("score is coerced to number when pg driver returns a string", async () => {
      const turnRows = [makeTurnRow({ score: "0.75" })];
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test");
      const result = results[0] as TranscriptTurnResult;
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeCloseTo(0.75);
    });

    test("parentAgentSessionId is null (mt#1327 not yet implemented)", async () => {
      const db = makeFakeDb([makeTurnRow()], []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test");
      const result = results[0] as TranscriptTurnResult;
      expect(result.sessionMetadata.parentAgentSessionId).toBeNull();
    });

    test("messageCount falls back to 0 when session missing from count rows", async () => {
      const turnRows = [makeTurnRow({ agentSessionId: "session-z" })];
      // Return empty count rows → session-z is absent.
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test");
      const result = results[0] as TranscriptTurnResult;
      expect(result.sessionMetadata.messageCount).toBe(0);
    });

    test("messageCount is populated from count rows when present", async () => {
      const turnRows = [makeTurnRow({ agentSessionId: "session-a" })];
      const countRows = [makeCountRow("session-a", 12)];
      const db = makeFakeDb(turnRows, countRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test");
      const result = results[0] as TranscriptTurnResult;
      expect(result.sessionMetadata.messageCount).toBe(12);
    });

    test("role filter: service passes filter into query (fake DB still returns row)", async () => {
      // The fake DB ignores WHERE conditions but we verify the service
      // doesn't crash and returns the canned rows.
      const turnRows = [makeTurnRow({ userText: "user message", assistantText: null })];
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test", { role: "user" });
      expect(results).toHaveLength(1);
    });

    test("date range filter: service does not crash when from/to provided", async () => {
      const turnRows = [makeTurnRow()];
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test", {
        dateRange: { from: new Date("2024-01-01"), to: new Date("2025-12-31") },
      });
      expect(results).toHaveLength(1);
    });

    test("session filter: service does not crash when sessionId provided", async () => {
      const turnRows = [makeTurnRow({ agentSessionId: "session-a" })];
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test", { sessionId: "session-a" });
      expect(results).toHaveLength(1);
      expect(results[0]?.agentSessionId).toBe("session-a");
    });

    test("resumeHint (mt#2523, mt#3440): each result carries a directory-pinned resume hint", async () => {
      const turnRows = [makeTurnRow({ agentSessionId: "session-resume-me" })];
      const db = makeFakeDb(turnRows, []);
      const svc = new TranscriptFtsService(db);

      const results = await svc.searchText("test");
      expect(results[0]?.resumeHint).toBe(
        "cd '/Users/dev/Projects/minsky' && claude --resume session-resume-me"
      );
    });
  });

  // ── Tests: getSession ────────────────────────────────────────────────────────

  describe("getSession", () => {
    test("returns turns ordered by turn_index with session metadata", async () => {
      const existenceRows = [makeExistenceRow("session-x")];
      const turnRows = [
        makeTurnRow({ agentSessionId: "session-x", turnIndex: 0 }),
        makeTurnRow({ agentSessionId: "session-x", turnIndex: 1 }),
        makeTurnRow({ agentSessionId: "session-x", turnIndex: 2 }),
      ];
      const countRows = [makeCountRow("session-x", 3)];
      const db = makeFakeDb(turnRows, countRows, existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-x"));

      expect(results).toHaveLength(3);
      expect(results[0]?.turnIndex).toBe(0);
      expect(results[1]?.turnIndex).toBe(1);
      expect(results[2]?.turnIndex).toBe(2);
    });

    test("score is 1.0 sentinel for getSession results", async () => {
      const existenceRows = [makeExistenceRow("session-x")];
      const turnRows = [makeTurnRow({ agentSessionId: "session-x" })];
      const db = makeFakeDb(turnRows, [], existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-x"));
      expect(results[0]?.score).toBe(1.0);
    });

    test("throws when session not found", async () => {
      // Existence rows = empty → session not found path.
      const db = makeFakeDb([], [], []);
      const svc = new TranscriptFtsService(db);

      await expect(svc.getSession(conv("nonexistent-session"))).rejects.toThrow(
        /session not found/
      );
    });

    test("turnRange slicing: turnRange option does not crash when provided", async () => {
      const existenceRows = [makeExistenceRow("session-y")];
      const turnRows = [
        makeTurnRow({ agentSessionId: "session-y", turnIndex: 10 }),
        makeTurnRow({ agentSessionId: "session-y", turnIndex: 15 }),
      ];
      const countRows = [makeCountRow("session-y", 20)];
      const db = makeFakeDb(turnRows, countRows, existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-y"), {
        turnRange: { start: 10, end: 20 },
      });
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    test("session metadata is attached to each turn", async () => {
      const existenceRows = [makeExistenceRow("session-meta")];
      const turnRows = [
        makeTurnRow({
          agentSessionId: "session-meta",
          sessionModel: "claude-3-opus",
          relatedTaskIds: ["mt#200"],
        }),
      ];
      const db = makeFakeDb(turnRows, [], existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-meta"));
      const result = results[0] as TranscriptTurnResult;
      expect(result.sessionMetadata.agentSessionId).toBe("session-meta");
      expect(result.sessionMetadata.model).toBe("claude-3-opus");
      expect(result.sessionMetadata.relatedTaskIds).toEqual(["mt#200"]);
    });

    test("messageCount is populated for getSession results", async () => {
      const existenceRows = [makeExistenceRow("session-cnt")];
      const turnRows = [makeTurnRow({ agentSessionId: "session-cnt" })];
      const countRows = [makeCountRow("session-cnt", 7)];
      const db = makeFakeDb(turnRows, countRows, existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-cnt"));
      expect(results[0]?.sessionMetadata.messageCount).toBe(7);
    });

    test("resumeHint (mt#2523, mt#3440): getSession results also carry the directory-pinned hint", async () => {
      const existenceRows = [makeExistenceRow("session-x")];
      const turnRows = [makeTurnRow({ agentSessionId: "session-x" })];
      const db = makeFakeDb(turnRows, [], existenceRows);
      const svc = new TranscriptFtsService(db);

      const results = await svc.getSession(conv("session-x"));
      expect(results[0]?.resumeHint).toBe(
        "cd '/Users/dev/Projects/minsky' && claude --resume session-x"
      );
    });
  });
});

// ── user_origin: the provenance field and its filter (mt#4289) ────────────────

describe("TranscriptFtsService — userOrigin (mt#4289)", () => {
  test("searchText carries userOrigin through to the result", async () => {
    const db = makeFakeDb([makeTurnRow({ userOrigin: "compact_summary" })]);
    const svc = new TranscriptFtsService(db);

    const results = await svc.searchText("anything");

    expect(results[0]?.userOrigin).toBe("compact_summary");
  });

  test("getSession carries it too — a whole-session read is a labelling surface as well", async () => {
    const db = makeFakeDb(
      [makeTurnRow({ agentSessionId: "session-o", userOrigin: "human" })],
      [],
      [makeExistenceRow("session-o")]
    );
    const svc = new TranscriptFtsService(db);

    const results = await svc.getSession(conv("session-o"));

    expect(results[0]?.userOrigin).toBe("human");
  });

  test("a row predating the column reports null, not a fabricated 'human'", async () => {
    // The BACKFILL decides what pre-mt#4289 rows say. Until it runs they are
    // NULL, and the read path must pass that through — inventing `human` here
    // would make "not yet classified" indistinguishable from "verified operator".
    const db = makeFakeDb([makeTurnRow({ userOrigin: null })]);
    const svc = new TranscriptFtsService(db);

    const results = await svc.searchText("anything");

    expect(results[0]?.userOrigin).toBeNull();
  });

  test("originKind filters on user_origin; omitting it does not", async () => {
    // The fake ignores conditions when choosing rows, so BOTH calls return the
    // same canned row — a result assertion cannot tell an applied filter from a
    // dropped one. The condition tree is the only place the difference shows.
    const svc = new TranscriptFtsService(makeFakeDb([makeTurnRow()]));
    await svc.searchText("anything", { role: "user" });
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_origin")).toBe(false);
    // Positive control for the probe itself: `role: "user"` DOES filter on
    // user_text, so a probe that can see anything must see this.
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_text")).toBe(true);

    const svc2 = new TranscriptFtsService(makeFakeDb([makeTurnRow()]));
    await svc2.searchText("anything", { role: "user", originKind: "human" });
    expect(whereTreeFiltersOn(capturedWhereConditions, "user_origin")).toBe(true);
  });
});
