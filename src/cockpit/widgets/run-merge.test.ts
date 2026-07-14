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
import { agentTranscriptTurnsTable } from "@minsky/domain/storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "@minsky/domain/storage/schemas/agent-spawns-schema";
import { minskySessionLinksTable } from "@minsky/domain/storage/schemas/minsky-session-links-schema";
import { createCachedRunMerge, mergeConversationRows } from "./run-merge";

const CONV_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const CONV_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const CONV_C = "cccccccc-0000-0000-0000-00000000000c";
const CONV_D = "dddddddd-0000-0000-0000-00000000000d";
const WORKSPACE_1 = "workspace-session-1";

interface TranscriptRow {
  agentSessionId: string;
  cwd: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

interface WorkspaceLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  confidence: number | null;
  detectedAt: Date | null;
  startedAt: Date | null;
  cwd: string | null;
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
          if (table === agentTranscriptTurnsTable) {
            return { where: () => Promise.resolve(fixture.turns ?? []) };
          }
          throw new Error("mockDb: unexpected table in .from()");
        },
      };
    },
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
      turns: [{ agentSessionId: CONV_B, turnIndex: 0, userText: "look into the flaky test suite" }],
    });

    const result = await mergeConversationRows(db, []);

    expect(result.standaloneRows).toHaveLength(1);
    const row = result.standaloneRows[0];
    if (!row) throw new Error("expected a standalone row");
    expect(row.kind).toBe("principal-conversation");
    expect(row.sessionId).toBe(CONV_B);
    expect(row.conversationId).toBe(CONV_B);
    expect(row.title.startsWith("look into the flaky test suite")).toBe(true);
    expect(row.subagents).toEqual([]);
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
          parentAgentSessionId: "some-parent-outside-window",
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
    expect(groupRow.sessionId).toBe("group:some-parent-outside-window");
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
});
