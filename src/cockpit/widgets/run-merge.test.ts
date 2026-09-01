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

/** Shared kind literal — extracted to satisfy custom/no-magic-string-duplication. */
const KIND_PRINCIPAL_CONVERSATION = "principal-conversation";
/** Shared kind literal (mt#4733) — extracted to satisfy custom/no-magic-string-duplication. */
const KIND_UNATTRIBUTED_SUMMARY = "unattributed-summary";

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
    expect(parentRow.kind).toBe(KIND_PRINCIPAL_CONVERSATION);
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
  // mt#4728 negative control (mt#3244): a first version of these two tests
  // asserted only `.resolves.toBeDefined()` against a mock shaped so the
  // WRONG branch would throw. That is not a discriminating assertion —
  // `mergeConversationRows` wraps its whole body in a top-level try/catch
  // that swallows ANY error into `EMPTY_RESULT`, which is itself "defined".
  // Forcing the ALL_PROJECTS branch unconditionally (simulating the
  // pre-mt#4728 code) left both tests GREEN. Rewritten below to spy on
  // which branch actually ran, so a caught exception can no longer read as
  // a pass.
  test("ALL_PROJECTS (default): the query never calls .where() — exact pre-mt#4728 shape", async () => {
    let sawWhere = false;
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === agentTranscriptsTable) {
            return {
              where: () => {
                sawWhere = true;
                return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
              },
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
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

    // Explicit ALL_PROJECTS and the omitted (default) form both take the
    // no-`.where()` branch.
    await mergeConversationRows(db, [], ALL_PROJECTS);
    expect(sawWhere).toBe(false);
    await mergeConversationRows(db, []);
    expect(sawWhere).toBe(false);
  });

  test("a specific project scope: the query calls .where() before .orderBy() — never the direct pre-mt#4728 shape", async () => {
    let sawWhere = false;
    let sawDirectOrderBy = false;
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table === agentTranscriptsTable) {
            return {
              where: () => {
                sawWhere = true;
                return { orderBy: () => ({ limit: () => Promise.resolve([]) }) };
              },
              orderBy: () => {
                sawDirectOrderBy = true;
                return { limit: () => Promise.resolve([]) };
              },
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

    await mergeConversationRows(db, [], PROJECT_A);
    expect(sawWhere).toBe(true);
    expect(sawDirectOrderBy).toBe(false);
  });

  // mt#4733 superseded this test's original assertion: pre-mt#4733,
  // CONV_NULL surfaced as its own standalone "principal-conversation" row
  // with `projectId: null`. Live measurement (mt#4733's spec) found that
  // literally-correct behavior produced a 45:2 flood ratio in production —
  // every NULL-attribution row rendered as a full peer of the filtered
  // project's own rows. This does not contradict the mt#4728 reviewer's
  // NULL-inclusion decision (the row is still represented, never silently
  // dropped); it refines HOW it's represented under a specific filter —
  // collapsed into one "unattributed-summary" aggregate (SC2) rather than
  // N individual peers. See run-merge.ts's module header.
  test("AT1 (mt#4733): a standalone principal-conversation row surfaces its own resolved projectId; a NULL-attribution row folds into the collapsed unattributed-summary row instead of becoming its own peer", async () => {
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

    // Still 2 rows — but the second is the collapsed aggregate, not
    // CONV_NULL's own row.
    expect(result.standaloneRows).toHaveLength(2);
    const byKind = new Map(result.standaloneRows.map((r) => [r.kind, r]));
    expect(byKind.get(KIND_PRINCIPAL_CONVERSATION)?.sessionId).toBe(CONV_A);
    expect(byKind.get(KIND_PRINCIPAL_CONVERSATION)?.projectId).toBe(PROJECT_A);

    const summary = byKind.get(KIND_UNATTRIBUTED_SUMMARY);
    expect(summary).toBeDefined();
    expect(summary?.projectId).toBeNull();
    // CONV_NULL is never dropped — it's still present, inside the
    // collapsed row's expandable list.
    expect(summary?.subagents).toHaveLength(1);
    expect(summary?.subagents[0]?.conversationId).toBe(CONV_NULL);
    expect(summary?.title).toContain("1 unattributed conversation");
    // No standalone row bears CONV_NULL's own sessionId.
    expect(result.standaloneRows.find((r) => r.sessionId === CONV_NULL)).toBeUndefined();
  });

  test("(mt#4733) ALL_PROJECTS is unaffected — NULL-attribution rows still render individually, exact pre-mt#4733 shape", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const CONV_NULL_1 = "99999999-0000-0000-0000-000000000001";
    const CONV_NULL_2 = "99999999-0000-0000-0000-000000000002";
    const db = mockDb({
      transcripts: [
        {
          agentSessionId: CONV_NULL_1,
          cwd: "/repo-null-1",
          startedAt,
          endedAt: null,
          projectId: null,
        },
        {
          agentSessionId: CONV_NULL_2,
          cwd: "/repo-null-2",
          startedAt,
          endedAt: null,
          projectId: null,
        },
      ],
    });

    const result = await mergeConversationRows(db, []); // omitted -> ALL_PROJECTS

    expect(result.standaloneRows).toHaveLength(2);
    expect(result.standaloneRows.every((r) => r.kind === KIND_PRINCIPAL_CONVERSATION)).toBe(true);
    expect(result.standaloneRows.find((r) => r.kind === KIND_UNATTRIBUTED_SUMMARY)).toBeUndefined();
  });

  test("(mt#4733) SC1: under a specific project scope, the standalone row count does not exceed what the same NULL population would produce unfiltered", async () => {
    const startedAt = new Date("2026-07-13T20:00:00.000Z");
    const NULL_IDS = Array.from({ length: 5 }, (_, i) => `99999999-0000-0000-0000-00000000010${i}`);

    // Unfiltered (ALL_PROJECTS): the top-recency window happens to include
    // only 2 of the NULL conversations (the rest are crowded out by more
    // frequent same-project activity in the real ORDER BY ... LIMIT window —
    // out of scope to simulate the ranking itself here, so this fixture
    // just represents a plausible unfiltered window directly).
    const unfilteredDb = mockDb({
      transcripts: [
        { agentSessionId: CONV_B, cwd: "/repo-b", startedAt, endedAt: null, projectId: PROJECT_B },
        ...NULL_IDS.slice(0, 2).map((id) => ({
          agentSessionId: id,
          cwd: "/repo-null",
          startedAt,
          endedAt: null,
          projectId: null as string | null,
        })),
      ],
    });
    const unfiltered = await mergeConversationRows(unfilteredDb, [], ALL_PROJECTS);

    // Filtered to PROJECT_B: the window shift (mt#4733's cause 1) admits
    // ALL 5 NULL conversations — pre-mt#4733 this would have produced 1 + 5
    // = 6 standalone rows, WORSE than the unfiltered 3. Post-fix, they
    // collapse to a single aggregate.
    const filteredDb = mockDb({
      transcripts: [
        { agentSessionId: CONV_B, cwd: "/repo-b", startedAt, endedAt: null, projectId: PROJECT_B },
        ...NULL_IDS.map((id) => ({
          agentSessionId: id,
          cwd: "/repo-null",
          startedAt,
          endedAt: null,
          projectId: null as string | null,
        })),
      ],
    });
    const filtered = await mergeConversationRows(filteredDb, [], PROJECT_B);

    expect(unfiltered.standaloneRows).toHaveLength(3); // 1 project-B + 2 individual NULL rows
    expect(filtered.standaloneRows).toHaveLength(2); // 1 project-B + 1 collapsed aggregate
    expect(filtered.standaloneRows.length).toBeLessThanOrEqual(unfiltered.standaloneRows.length);

    const summary = filtered.standaloneRows.find((r) => r.kind === KIND_UNATTRIBUTED_SUMMARY);
    expect(summary?.subagents).toHaveLength(5);
    expect(summary?.title).toContain("5 unattributed conversations");
  });

  // mt#4733 cause 2 ("un-merge" interaction) — verify, don't assume. A
  // subagent whose parent conversation is linked to a workspace that falls
  // OUT of view under a project filter used to manufacture a new standalone
  // "subagent-group" row for it; unfiltered, the same subagent would have
  // nested invisibly inside the parent workspace's row. Reproduced with a
  // two-project fixture: the parent (CONV_A) belongs to PROJECT_A and is
  // linked to WORKSPACE_1; the child (CONV_C) is NULL-attributed. Filtering
  // to PROJECT_B excludes CONV_A from the window entirely (its project_id
  // matches neither PROJECT_B nor null) and the caller's workspaceSessionIds
  // no longer include WORKSPACE_1 (PROJECT_B has no workspace of its own).
  describe("(mt#4733) the un-merge interaction — a subagent absorbed unfiltered renders standalone under a filter", () => {
    test("verified: the child folds into the unattributed-summary aggregate, NOT a new standalone subagent-group row", async () => {
      const startedAt = new Date("2026-07-13T20:00:00.000Z");

      // Unfiltered: the parent is visible and linked to its workspace, so
      // the child nests invisibly inside that workspace's row — 0
      // standalone rows.
      const unfilteredDb = mockDb({
        transcripts: [
          {
            agentSessionId: CONV_A,
            cwd: "/repo-a",
            startedAt,
            endedAt: null,
            projectId: PROJECT_A,
          },
          { agentSessionId: CONV_C, cwd: "/repo-a/sub", startedAt, endedAt: null, projectId: null },
        ],
        workspaceLinks: [
          {
            agentSessionId: CONV_A,
            minskySessionId: WORKSPACE_1,
            confidence: 1.0,
            detectedAt: startedAt,
            startedAt,
            cwd: "/repo-a",
          },
        ],
        conversationLinks: [{ agentSessionId: CONV_A }],
        spawns: [
          { parentAgentSessionId: CONV_A, childAgentSessionId: CONV_C, agentKind: "Explore" },
        ],
      });
      const unfiltered = await mergeConversationRows(unfilteredDb, [WORKSPACE_1], ALL_PROJECTS);
      expect(unfiltered.standaloneRows).toEqual([]);
      expect(unfiltered.workspaceAttrsBySessionId.get(WORKSPACE_1)?.subagents).toHaveLength(1);

      // Filtered to PROJECT_B: CONV_A (project_id = PROJECT_A) is excluded
      // from the window entirely; WORKSPACE_1 is not in the caller's
      // (project-filtered) workspaceSessionIds either — matching what
      // agents.ts's listSessions(projectScope) would actually return when
      // PROJECT_B owns no workspaces.
      const filteredDb = mockDb({
        transcripts: [
          { agentSessionId: CONV_C, cwd: "/repo-a/sub", startedAt, endedAt: null, projectId: null },
        ],
        spawns: [
          { parentAgentSessionId: CONV_A, childAgentSessionId: CONV_C, agentKind: "Explore" },
        ],
      });
      const filtered = await mergeConversationRows(filteredDb, [], PROJECT_B);

      // The fix: CONV_C folds into the unattributed aggregate rather than
      // manufacturing a new "subagent-group" row.
      expect(filtered.standaloneRows).toHaveLength(1);
      const row = filtered.standaloneRows[0];
      if (!row) throw new Error("expected one row");
      expect(row.kind).toBe(KIND_UNATTRIBUTED_SUMMARY);
      expect(row.subagents.map((e) => e.conversationId)).toEqual([CONV_C]);
      // Never the un-fixed shape (a bare "N subagent runs (parent not
      // shown)" row) — that would be the pre-mt#4733 un-merge defect.
      expect(filtered.standaloneRows.some((r) => r.kind === "subagent-group")).toBe(false);
    });

    test("a mixed group (one attributed child, one unattributed) partitions: the attributed child keeps a real subagent-group row, the unattributed child folds away", async () => {
      const startedAt = new Date("2026-07-13T20:00:00.000Z");
      const CONV_ATTRIBUTED_CHILD = "99999999-0000-0000-0000-000000000201";
      const CONV_NULL_CHILD = "99999999-0000-0000-0000-000000000202";
      const PARENT_OUT_OF_VIEW = "parent-not-in-window";

      const db = mockDb({
        transcripts: [
          {
            agentSessionId: CONV_ATTRIBUTED_CHILD,
            cwd: "/repo-b/sub",
            startedAt,
            endedAt: null,
            projectId: PROJECT_B,
          },
          {
            agentSessionId: CONV_NULL_CHILD,
            cwd: "/repo-unknown/sub",
            startedAt,
            endedAt: null,
            projectId: null,
          },
        ],
        spawns: [
          {
            parentAgentSessionId: PARENT_OUT_OF_VIEW,
            childAgentSessionId: CONV_ATTRIBUTED_CHILD,
            agentKind: "Explore",
          },
          {
            parentAgentSessionId: PARENT_OUT_OF_VIEW,
            childAgentSessionId: CONV_NULL_CHILD,
            agentKind: "refactorer",
          },
        ],
      });

      const result = await mergeConversationRows(db, [], PROJECT_B);

      expect(result.standaloneRows).toHaveLength(2);
      const group = result.standaloneRows.find((r) => r.kind === "subagent-group");
      const summary = result.standaloneRows.find((r) => r.kind === KIND_UNATTRIBUTED_SUMMARY);
      expect(group?.subagents.map((e) => e.conversationId)).toEqual([CONV_ATTRIBUTED_CHILD]);
      expect(summary?.subagents.map((e) => e.conversationId)).toEqual([CONV_NULL_CHILD]);
    });
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
