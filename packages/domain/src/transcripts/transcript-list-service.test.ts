/**
 * Unit tests for TranscriptListService (mt#2818).
 *
 * Uses a fake DB whose `.select(cols)` calls are discriminated by the
 * selected column SET (not call order) — required because
 * `fetchEnrichment` fires five queries concurrently via `Promise.all`, so a
 * single shared "last selected cols" variable (the pattern used by
 * transcript-fts-service.test.ts, whose calls are sequential) would race.
 * Each chain closes over its own `cols` instead.
 */

import { describe, test, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TranscriptListService } from "./transcript-list-service";
import type { TranscriptListRow } from "./transcript-list-service";

type DrizzlePgDb = PostgresJsDatabase;
type FakeRow = Record<string, unknown>;

interface FakeDbRows {
  baseRows?: FakeRow[];
  turnStatsRows?: FakeRow[];
  turnCandidateRows?: FakeRow[];
  linkRows?: FakeRow[];
  spawnRows?: FakeRow[];
  invocationRows?: FakeRow[];
  sessionTaskRows?: FakeRow[];
  /** When set, throws instead of resolving — simulates an enrichment-query failure. */
  throwOnEnrichment?: boolean;
}

function resolveRowsForCols(cols: Record<string, unknown>, rows: FakeDbRows): FakeRow[] {
  const keys = Object.keys(cols);
  if (keys.includes("summary")) return rows.baseRows ?? [];
  if (rows.throwOnEnrichment) throw new Error("simulated enrichment failure");
  if (keys.includes("turnCount")) return rows.turnStatsRows ?? [];
  if (keys.includes("turnIndex")) return rows.turnCandidateRows ?? [];
  if (keys.includes("minskySessionId")) return rows.linkRows ?? [];
  if (keys.includes("childAgentSessionId")) return rows.spawnRows ?? [];
  if (keys.includes("agentType")) return rows.invocationRows ?? [];
  if (keys.includes("sessionId")) return rows.sessionTaskRows ?? [];
  return [];
}

function makeChain(cols: Record<string, unknown>, rows: FakeDbRows) {
  const chain: {
    where: (c?: unknown) => typeof chain;
    groupBy: (c?: unknown) => typeof chain;
    orderBy: (c?: unknown) => typeof chain;
    then: <T>(resolve: (v: FakeRow[]) => T, reject?: (e: unknown) => T) => Promise<T>;
  } = {
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    then: (resolve, reject) =>
      new Promise<FakeRow[]>((res) => res(resolveRowsForCols(cols, rows))).then(
        resolve,
        reject as ((e: unknown) => unknown) | undefined
      ),
  };
  return chain;
}

function makeFakeDb(rows: FakeDbRows): DrizzlePgDb {
  return {
    select: (cols: Record<string, unknown>) => ({
      from: (_table: unknown) => makeChain(cols, rows),
    }),
  } as unknown as DrizzlePgDb;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBaseRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    agentSessionId: "conv-a",
    harness: "claude_code",
    startedAt: new Date("2026-07-15T10:00:00Z"),
    endedAt: new Date("2026-07-15T10:30:00Z"),
    cwd: "/Users/x/Projects/minsky",
    summary: null,
    relatedTaskIds: [],
    relatedPrNumbers: [],
    lastIngestedJsonlTimestamp: new Date("2026-07-15T10:30:00Z"),
    ...overrides,
  };
}

describe("TranscriptListService", () => {
  describe("listConversations", () => {
    test("maps base rows with zeroed enrichment when no enrichment rows resolve", async () => {
      const db = makeFakeDb({ baseRows: [makeBaseRow()] });
      const svc = new TranscriptListService(db);

      const { conversations, truncation } = await svc.listConversations();

      expect(conversations).toHaveLength(1);
      const row = conversations[0] as TranscriptListRow;
      expect(row.agentSessionId).toBe("conv-a");
      expect(row.turnCount).toBe(0);
      expect(row.firstTurnAt).toBeNull();
      expect(row.lastTurnAt).toBeNull();
      expect(row.linkedTaskId).toBeNull();
      expect(row.firstUserTurnCandidates).toEqual([]);
      expect(row.subagentSpawnAgentKind).toBeNull();
      expect(truncation).toEqual({ returned: 1, total: 1, truncated: false });
    });

    test("returns empty conversations + zero truncation when the store is empty", async () => {
      const db = makeFakeDb({ baseRows: [] });
      const svc = new TranscriptListService(db);

      const { conversations, truncation } = await svc.listConversations();
      expect(conversations).toEqual([]);
      expect(truncation).toEqual({ returned: 0, total: 0, truncated: false });
    });

    test("applies the loud mt#2817 cap: total reflects all rows, returned/truncated reflect the limit", async () => {
      const baseRows = [
        makeBaseRow({ agentSessionId: "conv-a" }),
        makeBaseRow({ agentSessionId: "conv-b" }),
        makeBaseRow({ agentSessionId: "conv-c" }),
      ];
      const db = makeFakeDb({ baseRows });
      const svc = new TranscriptListService(db);

      const { conversations, truncation } = await svc.listConversations({ limit: 2 });
      expect(conversations).toHaveLength(2);
      expect(truncation).toEqual({ returned: 2, total: 3, truncated: true });
    });

    test("turn stats (count/first/last) are attached from the turn-stats query", async () => {
      const db = makeFakeDb({
        baseRows: [makeBaseRow({ agentSessionId: "conv-a" })],
        turnStatsRows: [
          {
            agentSessionId: "conv-a",
            turnCount: 4,
            firstTurnAt: new Date("2026-07-15T10:00:00Z"),
            lastTurnAt: new Date("2026-07-15T10:25:00Z"),
          },
        ],
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      const row = conversations[0] as TranscriptListRow;
      expect(row.turnCount).toBe(4);
      expect(row.firstTurnAt).toEqual(new Date("2026-07-15T10:00:00Z"));
      expect(row.lastTurnAt).toEqual(new Date("2026-07-15T10:25:00Z"));
    });

    test("earliest-first user-turn candidates are sorted by turnIndex ascending", async () => {
      const db = makeFakeDb({
        baseRows: [makeBaseRow({ agentSessionId: "conv-a" })],
        turnCandidateRows: [
          { agentSessionId: "conv-a", turnIndex: 2, userText: "third" },
          { agentSessionId: "conv-a", turnIndex: 0, userText: "first" },
          { agentSessionId: "conv-a", turnIndex: 1, userText: "second" },
        ],
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      const row = conversations[0] as TranscriptListRow;
      expect(row.firstUserTurnCandidates).toEqual(["first", "second", "third"]);
    });

    test("tier-1 linkedTaskId resolves via minsky_session_links -> sessions.taskId", async () => {
      const db = makeFakeDb({
        baseRows: [makeBaseRow({ agentSessionId: "conv-a" })],
        linkRows: [
          {
            agentSessionId: "conv-a",
            minskySessionId: "session-xyz",
            confidence: 1,
            detectedAt: new Date("2026-07-15T09:00:00Z"),
          },
        ],
        sessionTaskRows: [{ sessionId: "session-xyz", taskId: "2818" }],
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      const row = conversations[0] as TranscriptListRow;
      expect(row.linkedTaskId).toBe("mt#2818");
    });

    test("tier-3 subagent inputs (spawn kind + invocation) are attached", async () => {
      const db = makeFakeDb({
        baseRows: [makeBaseRow({ agentSessionId: "conv-a" })],
        spawnRows: [{ childAgentSessionId: "conv-a", agentKind: "Explore" }],
        invocationRows: [
          {
            agentSessionId: "conv-a",
            taskId: "2818",
            agentType: "implementer",
            startedAt: new Date("2026-07-15T09:00:00Z"),
          },
        ],
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      const row = conversations[0] as TranscriptListRow;
      expect(row.subagentSpawnAgentKind).toBe("Explore");
      expect(row.subagentInvocationAgentType).toBe("implementer");
      expect(row.subagentInvocationTaskId).toBe("mt#2818");
    });

    test("enrichment-query failure degrades to zeroed enrichment, never throws", async () => {
      const db = makeFakeDb({
        baseRows: [makeBaseRow({ agentSessionId: "conv-a" })],
        throwOnEnrichment: true,
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      expect(conversations).toHaveLength(1);
      const row = conversations[0] as TranscriptListRow;
      expect(row.turnCount).toBe(0);
      expect(row.linkedTaskId).toBeNull();
    });

    test("base row fields (harness, summary, relatedTaskIds, lastIngestedJsonlTimestamp) pass through", async () => {
      const db = makeFakeDb({
        baseRows: [
          makeBaseRow({
            agentSessionId: "conv-a",
            harness: "claude_code",
            summary: "Implemented mt#2818.",
            relatedTaskIds: ["mt#2818"],
            relatedPrNumbers: ["#1234"],
          }),
        ],
      });
      const svc = new TranscriptListService(db);

      const { conversations } = await svc.listConversations();
      const row = conversations[0] as TranscriptListRow;
      expect(row.harness).toBe("claude_code");
      expect(row.summary).toBe("Implemented mt#2818.");
      expect(row.relatedTaskIds).toEqual(["mt#2818"]);
      expect(row.relatedPrNumbers).toEqual(["#1234"]);
      expect(row.lastIngestedJsonlTimestamp).toEqual(new Date("2026-07-15T10:30:00Z"));
    });
  });
});
