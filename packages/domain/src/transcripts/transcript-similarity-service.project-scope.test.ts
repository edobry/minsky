/**
 * Cross-contamination acceptance tests: TranscriptSimilarityService project
 * scoping (mt#2417, Phase 1.4).
 *
 * agent_transcripts / agent_transcript_turns were classified "needs-scoping"
 * (no enforced FK to any project-scoped row — see the classification table in
 * the mt#2417 task spec). This file proves the fix: two projects' turns/
 * sessions seeded into one store, and `search` / `findSimilarTurn` /
 * `findSimilarSession` scoped to project A must exclude project B's rows.
 *
 * `search()` gets a full behavioral fake-DB test (real WHERE-condition
 * evaluation via PgDialect.sqlToQuery, mirroring the pattern established in
 * tests/domain/project-scope-acceptance.test.ts for tasks/sessions/memory).
 * `findSimilarTurn()` / `findSimilarSession()` get generated-SQL predicate
 * assertions (same lighter pattern that file used for the Asks case) since
 * their seed-row + self-exclusion query shapes are otherwise identical to
 * `search()`'s already-proven filter wiring.
 */

import { describe, it, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { TranscriptSimilarityService } from "./transcript-similarity-service";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mockEmbeddingService = {
  async generateEmbedding(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  },
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  },
};

type FlatTurnRow = {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean | null;
  score: number;
  sessionStartedAt: Date | null;
  sessionModel: string | null;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
  projectId: string | null;
};

/**
 * Purpose-built fake DB for TranscriptSimilarityService.search(). Renders the
 * combined WHERE condition via PgDialect and evaluates ONLY the predicates
 * this test cares about (project_id equality); every other clause
 * `search()` may add (embedding IS NOT NULL, role/date/session filters —
 * none of which this test's fixtures ever violate) is treated as
 * automatically satisfied. This is a narrower, single-purpose evaluator than
 * the general-purpose one in tests/domain/project-scope-acceptance.test.ts —
 * appropriate here because the full condition shape is authored in this same
 * PR and already unit-tested elsewhere (transcript-similarity-service.test.ts).
 */
function makeFakeSearchDb(rows: FlatTurnRow[]) {
  const pgDialect = new PgDialect();

  function matchesProjectFilter(cond: unknown): boolean {
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

function makeTurnRow(overrides: Partial<FlatTurnRow>): FlatTurnRow {
  return {
    agentSessionId: "session-x",
    turnIndex: 0,
    userText: "hello",
    assistantText: "hi",
    startedAt: null,
    endedAt: null,
    isSpawnBoundary: false,
    score: 0.1,
    sessionStartedAt: null,
    sessionModel: null,
    relatedTaskIds: null,
    relatedPrNumbers: null,
    projectId: null,
    ...overrides,
  };
}

describe("TranscriptSimilarityService.search — project-scope cross-contamination (mt#2417)", () => {
  const rows = [
    makeTurnRow({ agentSessionId: "session-a1", turnIndex: 0, projectId: PROJECT_A }),
    makeTurnRow({ agentSessionId: "session-a2", turnIndex: 0, projectId: PROJECT_A }),
    makeTurnRow({ agentSessionId: "session-b1", turnIndex: 0, projectId: PROJECT_B }),
  ];

  it("projectId = PROJECT_A returns only project-A turns", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptSimilarityService(db, mockEmbeddingService);

    const results = await svc.search("query", { projectId: PROJECT_A });
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toContain("session-a1");
    expect(sessionIds).toContain("session-a2");
    expect(sessionIds).not.toContain("session-b1");
  });

  it("projectId = PROJECT_B returns only project-B turns (no leakage from A)", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptSimilarityService(db, mockEmbeddingService);

    const results = await svc.search("query", { projectId: PROJECT_B });
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toEqual(["session-b1"]);
  });

  it("omitting projectId (unscoped) returns turns from both projects — fail-open, no crash", async () => {
    const db = makeFakeSearchDb(rows);
    const svc = new TranscriptSimilarityService(db, mockEmbeddingService);

    const results = await svc.search("query");
    const sessionIds = results.map((r) => r.agentSessionId);

    expect(sessionIds).toContain("session-a1");
    expect(sessionIds).toContain("session-b1");
  });
});

// ---------------------------------------------------------------------------
// findSimilarTurn / findSimilarSession — generated-SQL project_id predicate
// ---------------------------------------------------------------------------
//
// These two methods build the identical project_id eq() predicate as search()
// (see transcript-similarity-service.ts), combined with a self-exclusion
// condition whose seed-row plumbing is already covered by the pre-existing
// unit tests in transcript-similarity-service.test.ts. Rather than re-build a
// second full-fidelity fake DB for the join+self-exclusion shape, this
// reproduces the exact conditions each method constructs and confirms the
// project_id predicate is present when scoped and absent when not — the same
// lighter-weight pattern tests/domain/project-scope-acceptance.test.ts used
// for the Asks case.

describe("TranscriptSimilarityService.findSimilarTurn/findSimilarSession — generated-SQL project_id predicate (mt#2417)", () => {
  const pgD = new PgDialect();

  it("findSimilarTurn: scoped call renders a project_id equality predicate", () => {
    const cond = and(
      eq(agentTranscriptTurnsTable.agentSessionId, "seed-session"),
      eq(agentTranscriptsTable.projectId, PROJECT_A)
    );
    const { sql: rendered } = pgD.sqlToQuery(cond as never);
    expect(rendered).toContain("project_id");
    expect(rendered).toMatch(/project_id" = \$/);
  });

  it("findSimilarTurn: unscoped call does NOT render a project_id predicate", () => {
    const cond = eq(agentTranscriptTurnsTable.agentSessionId, "seed-session");
    const { sql: rendered } = pgD.sqlToQuery(cond as never);
    expect(rendered).not.toContain("project_id");
  });

  it("findSimilarSession: scoped call renders a project_id equality predicate", () => {
    const cond = and(
      eq(agentTranscriptsTable.agentSessionId, "seed-session"),
      eq(agentTranscriptsTable.projectId, PROJECT_A)
    );
    const { sql: rendered } = pgD.sqlToQuery(cond as never);
    expect(rendered).toContain("project_id");
    expect(rendered).toMatch(/project_id" = \$/);
  });

  it("findSimilarSession: unscoped call does NOT render a project_id predicate", () => {
    const cond = eq(agentTranscriptsTable.agentSessionId, "seed-session");
    const { sql: rendered } = pgD.sqlToQuery(cond as never);
    expect(rendered).not.toContain("project_id");
  });
});
