/**
 * Tests for the unified run-list conversation merge (mt#2767).
 *
 * Mirrors the mockMultiTableDb pattern established by
 * `context-inspector.test.ts` — a Drizzle-shaped mock that branches on table
 * identity, extended here with an `.innerJoin()` step for the
 * workspace-link forward-direction query.
 */
import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { boundedUserTurnsExecute } from "../testing/bounded-user-turns-double";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { ALL_PROJECTS } from "@minsky/domain/project/scope";
import { createCachedRunMerge, mergeConversationRows } from "./run-merge";

const CONV_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const CONV_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const CONV_C = "cccccccc-0000-0000-0000-00000000000c";
const CONV_D = "dddddddd-0000-0000-0000-00000000000d";
const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";
const WORKSPACE_1 = "workspace-session-1";

/** Shared fixture string — extracted to satisfy custom/no-magic-string-duplication. */
const FLAKY_TEST_SUITE_PROMPT = "look into the flaky test suite";
/** Shared fixture string — extracted to satisfy custom/no-magic-string-duplication. */
const SOME_PARENT_OUTSIDE_WINDOW = "some-parent-outside-window";

interface TranscriptRow {
  agentSessionId: string;
  cwd: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** mt#3070 — model the conversation ran on; optional in fixtures that predate the field. */
  model?: string | null;
  /** mt#4728 — project attribution; optional in fixtures that predate the field. */
  projectId?: string | null;
}

interface WorkspaceLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  confidence: number | null;
  detectedAt: Date | null;
  startedAt: Date | null;
  cwd: string | null;
  /** mt#3070 — model of the linked conversation; optional in fixtures that predate the field. */
  model?: string | null;
}

interface Fixture {
  transcripts: TranscriptRow[];
  /** Rows for the forward (workspace -> conversation) join query. */
  workspaceLinks?: WorkspaceLinkRow[];
  /** Rows for the reverse (conversation -> any workspace) existence query. */
  conversationLinks?: { agentSessionId: string }[];
  spawns?: {
    parentAgentSessionId: string;
    childAgentSessionId: string | null;
    agentKind: string | null;
  }[];
  turns?: { agentSessionId: string; turnIndex: number; userText: string | null }[];
}

function mockDb(fixture: Fixture, onQuery?: () => void): PostgresJsDatabase {
  return {
    select: () => {
      onQuery?.();
      return {
        from: (table: unknown) => {
          if (table === agentTranscriptsTable) {
            return {
              // mt#4728: the ALL_PROJECTS branch calls `.orderBy()` directly
              // on `.from()`'s return (the exact pre-mt#4728 shape); a
              // scoped call adds a `.where()` step first. Both resolve the
              // SAME fixture — the fixture itself represents "what the DB
              // already returned for this call", matching every other
              // table in this mock (see workspaceLinks/conversationLinks
              // below, which are likewise pre-filtered by the test author
              // rather than interpreted from a `where()` argument).
              where: () => ({
                orderBy: () => ({ limit: () => Promise.resolve(fixture.transcripts) }),
              }),
              orderBy: () => ({ limit: () => Promise.resolve(fixture.transcripts) }),
            };
          }
          if (table === minskySessionLinksTable) {
            return {
              // Forward direction (workspace -> conversation): .innerJoin().where()
              innerJoin: () => ({ where: () => Promise.resolve(fixture.workspaceLinks ?? []) }),
              // Reverse direction (conversation -> any workspace): bare .where()
              where: () => Promise.resolve(fixture.conversationLinks ?? []),
            };
          }
          if (table === agentSpawnsTable) {
            return { where: () => Promise.resolve(fixture.spawns ?? []) };
          }
          throw new Error("mockDb: unexpected table in .from()");
        },
      };
    },
    // mt#4655 — the user-turn read is a raw `db.execute` with a per-session
    // bound, not a `.select().from()` chain, so it cannot be answered by table
    // identity above.
    execute: boundedUserTurnsExecute(fixture.turns),
  } as unknown as PostgresJsDatabase;
}

describe("mergeConversationRows (mt#2767)", () => {
  test("dedup: a conversation linked to a workspace produces NO standalone row and is attached to the workspace instead", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [{ agentSessionId: CONV_A, cwd: "/repo", startedAt, endedAt: null }],
      workspaceLinks: [
        {
          agentSessionId: CONV_A,
          minskySessionId: WORKSPACE_1,
          confidence: 1.0,
          detectedAt: startedAt,
          startedAt,
          cwd: "/repo",
        },
      ],
      conversationLinks: [{ agentSessionId: CONV_A }],
    });

    const result = await mergeConversationRows(db, [WORKSPACE_1]);

    expect(result.standaloneRows).toEqual([]);
    const attrs = result.workspaceAttrsBySessionId.get(WORKSPACE_1);
    expect(attrs?.conversationId).toBe(CONV_A);
    expect(attrs?.cwd).toBe("/repo");
    expect(attrs?.subagents).toEqual([]);
  });

  test("unlinked, non-subagent conversation becomes a standalone principal-conversation row", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt, endedAt: null }],
      turns: [{ agentSessionId: CONV_B, turnIndex: 0, userText: FLAKY_TEST_SUITE_PROMPT }],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const row = result.standaloneRows[0];
    if (!row) throw new Error("expected a standalone row");
    expect(row.kind).toBe("principal-conversation");
    expect(row.sessionId).toBe(CONV_B);
    expect(row.conversationId).toBe(CONV_B);
    expect(row.title.startsWith(FLAKY_TEST_SUITE_PROMPT)).toBe(true);
    expect(row.subagents).toEqual([]);
  });

  test("(mt#2784) a markup-only first turn falls to the next substantive user turn, never raw XML", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt, endedAt: null }],
      turns: [
        {
          agentSessionId: CONV_B,
          turnIndex: 0,
          userText: "<command-message>error-handling</command-message>",
        },
        {
          agentSessionId: CONV_B,
          turnIndex: 1,
          userText: FLAKY_TEST_SUITE_PROMPT,
        },
      ],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const row = result.standaloneRows[0];
    if (!row) throw new Error("expected a standalone row");
    expect(row.title).not.toContain("<command-");
    expect(row.title.startsWith(FLAKY_TEST_SUITE_PROMPT)).toBe(true);
  });

  test("(mt#2784) a conversation with ONLY markup turns falls through to the timestamp·cwd fallback", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt, endedAt: null }],
      turns: [
        {
          agentSessionId: CONV_B,
          turnIndex: 0,
          userText: "<command-message>error-handling</command-message>",
        },
      ],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const row = result.standaloneRows[0];
    if (!row) throw new Error("expected a standalone row");
    expect(row.title).not.toContain("<command-");
    expect(row.title).toContain("2026-07-13 20:00");
  });

  test("subagent nests under its parent workspace row when the parent is visible", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        { agentSessionId: CONV_A, cwd: "/repo", startedAt, endedAt: null }, // parent, linked to workspace
        { agentSessionId: CONV_C, cwd: "/repo/sub", startedAt, endedAt: null }, // subagent child
      ],
      workspaceLinks: [
        {
          agentSessionId: CONV_A,
          minskySessionId: WORKSPACE_1,
          confidence: 1.0,
          detectedAt: startedAt,
          startedAt,
          cwd: "/repo",
        },
      ],
      conversationLinks: [{ agentSessionId: CONV_A }], // only the parent is workspace-linked
      spawns: [{ parentAgentSessionId: CONV_A, childAgentSessionId: CONV_C, agentKind: "Explore" }],
    });

    const result = await mergeConversationRows(db, [WORKSPACE_1]);

    // The subagent conversation must NOT appear as its own standalone row.
    expect(result.standaloneRows.find((r) => r.sessionId === CONV_C)).toBeUndefined();
    expect(result.standaloneRows).toEqual([]);

    const attrs = result.workspaceAttrsBySessionId.get(WORKSPACE_1);
    expect(attrs?.subagents).toHaveLength(1);
    expect(attrs?.subagents[0]?.conversationId).toBe(CONV_C);
    expect(attrs?.subagents[0]?.label).toContain("Explore");
  });

  test("subagent nests under its parent principal-conversation row when the parent is an unlinked top-level conversation", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        { agentSessionId: CONV_B, cwd: "/repo", startedAt, endedAt: null }, // unlinked parent (principal conversation)
        { agentSessionId: CONV_C, cwd: "/repo/sub", startedAt, endedAt: null }, // subagent child
      ],
      spawns: [
        { parentAgentSessionId: CONV_B, childAgentSessionId: CONV_C, agentKind: "general-purpose" },
      ],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const parentRow = result.standaloneRows.find((r) => r.sessionId === CONV_B);
    if (!parentRow) throw new Error("expected the parent principal-conversation row");
    expect(parentRow.kind).toBe("principal-conversation");
    expect(parentRow.subagents).toHaveLength(1);
    expect(parentRow.subagents[0]?.conversationId).toBe(CONV_C);
    // The child never appears as its own top-level row.
    expect(result.standaloneRows.find((r) => r.sessionId === CONV_C)).toBeUndefined();
  });

  test("subagent whose parent is NOT in the current window collapses into a synthetic subagent-group row", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [{ agentSessionId: CONV_D, cwd: "/repo/sub", startedAt, endedAt: null }],
      spawns: [
        {
          parentAgentSessionId: SOME_PARENT_OUTSIDE_WINDOW,
          childAgentSessionId: CONV_D,
          agentKind: "refactorer",
        },
      ],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const groupRow = result.standaloneRows[0];
    if (!groupRow) throw new Error("expected a synthetic group row");
    expect(groupRow.kind).toBe("subagent-group");
    expect(groupRow.sessionId).toBe(`group:${SOME_PARENT_OUTSIDE_WINDOW}`);
    expect(groupRow.subagents).toHaveLength(1);
    expect(groupRow.subagents[0]?.conversationId).toBe(CONV_D);
    expect(groupRow.title).toContain("1 subagent run");
  });

  test("degrades to empty result on any query failure — never throws", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("simulated DB failure");
      },
    } as unknown as PostgresJsDatabase;

    const result = await mergeConversationRows(throwingDb, [WORKSPACE_1]);
    expect(result.standaloneRows).toEqual([]);
    expect(result.workspaceAttrsBySessionId.size).toBe(0);
  });

  test("empty conversation window produces no standalone rows and no workspace attrs", async () => {
    const db = mockDb({ transcripts: [] });
    const result = await mergeConversationRows(db, [WORKSPACE_1]);
    expect(result.standaloneRows).toEqual([]);
    expect(result.workspaceAttrsBySessionId.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Project scoping (mt#4728) — conversation-derived rows (principal-
// conversation / subagent-group) now honor the same ProjectScope
// listSessions already applies, and a NULL-attribution row is always
// included regardless of scope.
// ---------------------------------------------------------------------------

describe("mergeConversationRows — project scoping (mt#4728)", () => {
  test("ALL_PROJECTS (default): the query never calls .where() — exact pre-mt#4728 shape", async () => {
    // No `where` key at all: if the code mistakenly called `.where()` on the
    // ALL_PROJECTS path, this would throw "where is not a function".
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === agentTranscriptsTable) {
            return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
          }
          if (table === minskySessionLinksTable) {
            return {
              innerJoin: () => ({ where: () => Promise.resolve([]) }),
              where: () => Promise.resolve([]),
            };
          }
          if (table === agentSpawnsTable) return { where: () => Promise.resolve([]) };
          throw new Error("unexpected table");
        },
      }),
      execute: boundedUserTurnsExecute([]),
    } as unknown as PostgresJsDatabase;

    // Explicit ALL_PROJECTS and the omitted (default) form both take the
    // no-`.where()` branch.
    await expect(mergeConversationRows(db, [], ALL_PROJECTS)).resolves.toBeDefined();
    await expect(mergeConversationRows(db, [])).resolves.toBeDefined();
  });

  test("a specific project scope: the query calls .where() before .orderBy() — never the direct pre-mt#4728 shape", async () => {
    // No direct `orderBy` on `.from()`'s return: if the code mistakenly took
    // the ALL_PROJECTS branch, this would throw "orderBy is not a function".
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === agentTranscriptsTable) {
            return {
              where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
            };
          }
          if (table === minskySessionLinksTable) {
            return {
              innerJoin: () => ({ where: () => Promise.resolve([]) }),
              where: () => Promise.resolve([]),
            };
          }
          if (table === agentSpawnsTable) return { where: () => Promise.resolve([]) };
          throw new Error("unexpected table");
        },
      }),
      execute: boundedUserTurnsExecute([]),
    } as unknown as PostgresJsDatabase;

    await expect(mergeConversationRows(db, [], PROJECT_A)).resolves.toBeDefined();
  });

  test("AT1: a standalone principal-conversation row surfaces its own resolved projectId, and NULL-attribution rows are never excluded by JS-level logic", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const CONV_NULL = "99999999-0000-0000-0000-000000000099";
    // Represents what Postgres would already have returned for
    // `project_id = PROJECT_A OR project_id IS NULL` — a project-B row is
    // never in this list, matching what the real WHERE clause excludes.
    const db = mockDb({
      transcripts: [
        { agentSessionId: CONV_A, cwd: "/repo-a", startedAt, endedAt: null, projectId: PROJECT_A },
        { agentSessionId: CONV_NULL, cwd: "/repo-null", startedAt, endedAt: null, projectId: null },
      ],
    });

    const result = await mergeConversationRows(db, [], PROJECT_A);

    expect(result.standaloneRows).toHaveLength(2);
    const byId = new Map(result.standaloneRows.map((r) => [r.sessionId, r]));
    expect(byId.get(CONV_A)?.projectId).toBe(PROJECT_A);
    expect(byId.get(CONV_NULL)?.projectId).toBeNull();
  });

  test("AT2: a synthetic subagent-group row's own projectId is always null, mirroring the model aggregation carve-out", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_D,
          cwd: "/repo/sub",
          startedAt,
          endedAt: null,
          projectId: PROJECT_A,
        },
      ],
      spawns: [
        {
          parentAgentSessionId: SOME_PARENT_OUTSIDE_WINDOW,
          childAgentSessionId: CONV_D,
          agentKind: "refactorer",
        },
      ],
    });

    const result = await mergeConversationRows(db, [], PROJECT_A);

    expect(result.standaloneRows).toHaveLength(1);
    const groupRow = result.standaloneRows[0];
    if (!groupRow) throw new Error("expected a synthetic group row");
    expect(groupRow.projectId).toBeNull();
  });

  test("two-project fixture: a query scoped to project B never returns project A's principal-conversation row (simulates the live-verified peezombie leak)", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    // Simulates the WHERE clause already having excluded CONV_A (project A)
    // when scoped to PROJECT_B — the fixture IS the post-filter result set,
    // per this file's established mocking convention (see the header
    // comment on mockDb's agentTranscriptsTable branch above).
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_B,
          cwd: "/repo-peezombie",
          startedAt,
          endedAt: null,
          projectId: PROJECT_B,
        },
      ],
    });

    const result = await mergeConversationRows(db, [], PROJECT_B);

    expect(result.standaloneRows).toHaveLength(1);
    expect(result.standaloneRows.find((r) => r.sessionId === CONV_A)).toBeUndefined();
    expect(result.standaloneRows[0]?.sessionId).toBe(CONV_B);
    expect(result.standaloneRows[0]?.projectId).toBe(PROJECT_B);
  });
});

// ---------------------------------------------------------------------------
// Per-node model (mt#3070) — agent_transcripts.model threaded through
// SubagentEntry / WorkspaceConversationAttrs / StandaloneRunRow.
// ---------------------------------------------------------------------------

describe("per-node model (mt#3070)", () => {
  test("AT: two subagent invocations whose transcripts carry a model — each entry surfaces its own model", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const CONV_E = "eeeeeeee-0000-0000-0000-00000000000e";
    const db = mockDb({
      transcripts: [
        { agentSessionId: CONV_A, cwd: "/repo", startedAt, endedAt: null, model: null }, // parent, linked to workspace
        {
          agentSessionId: CONV_C,
          cwd: "/repo/sub",
          startedAt,
          endedAt: null,
          model: "claude-sonnet-5",
        },
        {
          agentSessionId: CONV_E,
          cwd: "/repo/sub2",
          startedAt,
          endedAt: null,
          model: "claude-sonnet-5",
        },
      ],
      workspaceLinks: [
        {
          agentSessionId: CONV_A,
          minskySessionId: WORKSPACE_1,
          confidence: 1.0,
          detectedAt: startedAt,
          startedAt,
          cwd: "/repo",
          model: null,
        },
      ],
      conversationLinks: [{ agentSessionId: CONV_A }],
      spawns: [
        { parentAgentSessionId: CONV_A, childAgentSessionId: CONV_C, agentKind: "Explore" },
        {
          parentAgentSessionId: CONV_A,
          childAgentSessionId: CONV_E,
          agentKind: "general-purpose",
        },
      ],
    });

    const result = await mergeConversationRows(db, [WORKSPACE_1]);

    const attrs = result.workspaceAttrsBySessionId.get(WORKSPACE_1);
    expect(attrs?.subagents).toHaveLength(2);
    const byId = new Map(attrs?.subagents.map((e) => [e.conversationId, e]));
    expect(byId.get(CONV_C)?.model).toBe("claude-sonnet-5");
    expect(byId.get(CONV_E)?.model).toBe("claude-sonnet-5");
  });

  test("AT: a subagent with a NULL model surfaces model: null — never a guess", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        { agentSessionId: CONV_A, cwd: "/repo", startedAt, endedAt: null, model: null },
        { agentSessionId: CONV_C, cwd: "/repo/sub", startedAt, endedAt: null, model: null },
      ],
      workspaceLinks: [
        {
          agentSessionId: CONV_A,
          minskySessionId: WORKSPACE_1,
          confidence: 1.0,
          detectedAt: startedAt,
          startedAt,
          cwd: "/repo",
          model: null,
        },
      ],
      conversationLinks: [{ agentSessionId: CONV_A }],
      spawns: [{ parentAgentSessionId: CONV_A, childAgentSessionId: CONV_C, agentKind: "Explore" }],
    });

    const result = await mergeConversationRows(db, [WORKSPACE_1]);

    const attrs = result.workspaceAttrsBySessionId.get(WORKSPACE_1);
    expect(attrs?.subagents).toHaveLength(1);
    expect(attrs?.subagents[0]?.model).toBeNull();
  });

  test("workspace ('dispatched-agent') row surfaces the model of its best-linked conversation", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_A,
          cwd: "/repo",
          startedAt,
          endedAt: null,
          model: "claude-opus-4-8",
        },
      ],
      workspaceLinks: [
        {
          agentSessionId: CONV_A,
          minskySessionId: WORKSPACE_1,
          confidence: 1.0,
          detectedAt: startedAt,
          startedAt,
          cwd: "/repo",
          model: "claude-opus-4-8",
        },
      ],
      conversationLinks: [{ agentSessionId: CONV_A }],
    });

    const result = await mergeConversationRows(db, [WORKSPACE_1]);

    const attrs = result.workspaceAttrsBySessionId.get(WORKSPACE_1);
    expect(attrs?.model).toBe("claude-opus-4-8");
  });

  test("a principal-conversation standalone row surfaces its own model", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_B,
          cwd: "/repo",
          startedAt,
          endedAt: null,
          model: "claude-haiku-4-5-20251001",
        },
      ],
      turns: [{ agentSessionId: CONV_B, turnIndex: 0, userText: FLAKY_TEST_SUITE_PROMPT }],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    expect(result.standaloneRows[0]?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("a synthetic subagent-group row's OWN model is always null, even though its children carry models — a group aggregates N children with potentially different models", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_D,
          cwd: "/repo/sub",
          startedAt,
          endedAt: null,
          model: "claude-sonnet-5",
        },
      ],
      spawns: [
        {
          parentAgentSessionId: SOME_PARENT_OUTSIDE_WINDOW,
          childAgentSessionId: CONV_D,
          agentKind: "refactorer",
        },
      ],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const groupRow = result.standaloneRows[0];
    if (!groupRow) throw new Error("expected a synthetic group row");
    expect(groupRow.model).toBeNull();
    // The child entry within the group still carries its own model.
    expect(groupRow.subagents[0]?.model).toBe("claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// createCachedRunMerge (mt#2767 latency follow-up) — the short-TTL,
// request-deduplicating cache added after the live-measured 2-9s regression
// (2026-07-14) against the pre-merge baseline's 0.33s warm.
// ---------------------------------------------------------------------------

describe("createCachedRunMerge (mt#2767 latency follow-up)", () => {
  test("repeated calls with the same key hit cache — the DB is queried only once", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000); // long TTL — this test asserts on hits, not expiry

    const r1 = await cached.getMerge(db, [WORKSPACE_1]);
    const r2 = await cached.getMerge(db, [WORKSPACE_1]);

    expect(r1).toBe(r2); // same resolved object — served from cache, not re-derived
    // Each mergeConversationRows() pass issues 4 top-level db.select() calls
    // (transcripts, workspace links, conversation links, spawns) plus one
    // more for turns when conversationIds is non-empty — the exact count
    // doesn't matter here, only that a SECOND getMerge() call adds none.
    expect(queryCount).toBeGreaterThan(0);
    const afterFirst = queryCount;
    await cached.getMerge(db, [WORKSPACE_1]);
    expect(queryCount).toBe(afterFirst);
  });

  test("a different workspace-id set is a cache miss — the DB is queried again", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000);

    await cached.getMerge(db, [WORKSPACE_1]);
    const afterFirst = queryCount;
    await cached.getMerge(db, ["a-different-workspace-id"]);
    expect(queryCount).toBeGreaterThan(afterFirst);
  });

  test("concurrent calls with the same key share ONE in-flight promise (no fan-out)", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000);

    // Fire two calls back-to-back without awaiting the first — both should
    // resolve to the SAME promise, not trigger two independent query passes.
    const [r1, r2] = await Promise.all([
      cached.getMerge(db, [WORKSPACE_1]),
      cached.getMerge(db, [WORKSPACE_1]),
    ]);
    expect(r1).toBe(r2);
    const soleQueryCount = queryCount;

    await cached.getMerge(db, [WORKSPACE_1]);
    expect(queryCount).toBe(soleQueryCount); // third call still hits cache
  });

  test("expired entries trigger a fresh query", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(10); // 10ms TTL

    await cached.getMerge(db, [WORKSPACE_1]);
    const afterFirst = queryCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await cached.getMerge(db, [WORKSPACE_1]);
    expect(queryCount).toBeGreaterThan(afterFirst);
  });

  test("sorted key: the same id set in a different order is still a cache hit", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000);

    await cached.getMerge(db, ["workspace-a", "workspace-b"]);
    const afterFirst = queryCount;
    await cached.getMerge(db, ["workspace-b", "workspace-a"]); // reordered
    expect(queryCount).toBe(afterFirst);
  });

  // mt#4728: the cache key must include the project scope, or two different
  // project filters (or two operators viewing different projects) within
  // the same TTL window would share a cached merge keyed only on the
  // workspace-id set — reintroducing the cross-project leak this task
  // fixes, through the cache rather than the query.
  test("(mt#4728) the SAME empty workspace-id set under two different project scopes is a cache miss for each other, never a hit", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000);

    // Both calls pass the SAME (empty) workspace-id set — the pre-mt#4728
    // key would collide here.
    await cached.getMerge(db, [], PROJECT_A);
    const afterFirst = queryCount;
    await cached.getMerge(db, [], PROJECT_B);
    expect(queryCount).toBeGreaterThan(afterFirst); // must NOT be served from PROJECT_A's cache entry
  });

  test("(mt#4728) an explicit ALL_PROJECTS scope and an omitted scope share one cache entry — the default is ALL_PROJECTS", async () => {
    let queryCount = 0;
    const db = mockDb(
      { transcripts: [{ agentSessionId: CONV_B, cwd: "/repo", startedAt: null, endedAt: null }] },
      () => queryCount++
    );
    const cached = createCachedRunMerge(60_000);

    await cached.getMerge(db, [WORKSPACE_1]); // omitted -> defaults to ALL_PROJECTS
    const afterFirst = queryCount;
    await cached.getMerge(db, [WORKSPACE_1], ALL_PROJECTS); // explicit
    expect(queryCount).toBe(afterFirst); // same cache entry
  });
});
