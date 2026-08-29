/**
 * Cross-contamination acceptance tests: TranscriptFtsService project scoping
 * (mt#4727), mirroring `transcript-similarity-service.project-scope.test.ts`
 * (mt#2417 Phase 1.4) — that file covers `TranscriptSimilarityService.search`;
 * this one covers its FTS sibling. `TranscriptFtsSearchOptions.projectId`
 * already existed and was already applied in `searchText()`'s query
 * (`eq(agentTranscriptsTable.projectId, opts.projectId)`) before this task —
 * it just had no dedicated two-project fixture test until now, discovered
 * while wiring `routes/conversation-search.ts` through to it (mt#4727,
 * reviewer round 1).
 *
 * `searchText()` gets a full behavioral fake-DB test (real WHERE-condition
 * evaluation via PgDialect.sqlToQuery), same pattern as the similarity
 * service's `search()` test.
 */

import { describe, it, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TranscriptFtsService } from "./transcript-fts-service";

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type FlatTurnRow = {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  userOrigin: string | null;
  assistantText: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean | null;
  score: number;
  snippet: string | null;
  sessionStartedAt: Date | null;
  sessionModel: string | null;
  sessionCwd: string | null;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
  projectId: string | null;
};

function makeTurnRow(overrides: Partial<FlatTurnRow>): FlatTurnRow {
  return {
    agentSessionId: "session-x",
    turnIndex: 0,
    userText: "hello",
    userOrigin: null,
    assistantText: "hi",
    startedAt: null,
    endedAt: null,
    isSpawnBoundary: false,
    score: 0.1,
    snippet: "hello",
    sessionStartedAt: null,
    sessionModel: null,
    sessionCwd: null,
    relatedTaskIds: null,
    relatedPrNumbers: null,
    projectId: null,
    ...overrides,
  };
}

/**
 * Purpose-built fake DB for TranscriptFtsService.searchText(). Same
 * WHERE-condition-rendering approach as
 * `transcript-similarity-service.project-scope.test.ts`'s `makeFakeSearchDb`:
 * renders the combined condition via PgDialect and evaluates only the
 * project_id predicate — every other clause `searchText()` adds (the FTS
 * match, role/date filters — none of which this test's fixtures violate) is
 * treated as automatically satisfied. Handles TWO distinct `select().from()`
 * chains: the main search (`.innerJoin().where().orderBy().limit()`) and the
 * per-session message-count query (`.where().groupBy()`).
 */
function makeFakeSearchDb(rows: FlatTurnRow[]): PostgresJsDatabase {
  const pgDialect = new PgDialect();

  function matchesProjectFilter(cond: unknown): true | ((row: FlatTurnRow) => boolean) {
    const { sql: rendered, params } = pgDialect.sqlToQuery(cond as never);
    const match = /"agent_transcripts"\."project_id" = \$(\d+)/.exec(rendered);
    if (!match) return true; // no project predicate present -> unscoped, matches all
    const paramIdx = Number(match[1]) - 1;
    const wantedProjectId = params[paramIdx];
    return (row: FlatTurnRow) => row.projectId === wantedProjectId;
  }

  return {
    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          return {
            innerJoin(_joinTable: unknown, _on: unknown) {
              return {
                where(cond: unknown) {
                  const predicate = matchesProjectFilter(cond);
                  const filtered = typeof predicate === "function" ? rows.filter(predicate) : rows;
                  return {
                    orderBy(_expr: unknown) {
                      return { limit: (n: number) => Promise.resolve(filtered.slice(0, n)) };
                    },
                  };
                },
              };
            },
            where(_cond: unknown) {
              // getMessageCounts() path — count doesn't affect this test's assertions.
              return { groupBy: (_col: unknown) => Promise.resolve([]) };
            },
          };
        },
      };
    },
  } as unknown as PostgresJsDatabase;
}

describe("TranscriptFtsService.searchText — project-scope cross-contamination (mt#4727)", () => {
  const rows = [
    makeTurnRow({ agentSessionId: "session-a1", turnIndex: 0, projectId: PROJECT_A }),
    makeTurnRow({ agentSessionId: "session-a2", turnIndex: 0, projectId: PROJECT_A }),
    makeTurnRow({ agentSessionId: "session-b1", turnIndex: 0, projectId: PROJECT_B }),
  ];

  it("projectId = PROJECT_A returns only project-A turns", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptFtsService(db);

    const results = await svc.searchText("hello", { projectId: PROJECT_A });
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toContain("session-a1");
    expect(sessionIds).toContain("session-a2");
    expect(sessionIds).not.toContain("session-b1");
  });

  it("projectId = PROJECT_B returns only project-B turns (no leakage from A)", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptFtsService(db);

    const results = await svc.searchText("hello", { projectId: PROJECT_B });
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toEqual(["session-b1"]);
  });

  it("omitting projectId (unscoped) returns turns from both projects — fail-open, no crash", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptFtsService(db);

    const results = await svc.searchText("hello");
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toContain("session-a1");
    expect(sessionIds).toContain("session-b1");
  });
});
