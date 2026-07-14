/**
 * Integration tests for AgentSpawnsPipeline's mt#2756 wiring: every resolved
 * spawn drives `writeSpawnLink` (spawn-link-writer.ts) using the SAME Agent
 * tool call prompt text already loaded for agent_kind/spawn_type extraction.
 *
 * Kept in a separate file from `agent-spawns-pipeline.test.ts` (which covers
 * the pre-existing extraction behavior in isolation) because this file's fake
 * DB must route `insert()` calls to TWO different destination tables
 * (`agent_spawns` and `minsky_session_links`) by table identity, which the
 * original fixture doesn't need.
 *
 * @see ./agent-spawns-pipeline.ts
 * @see ./spawn-link-writer.ts
 * @see mt#2756
 */

import { describe, test, expect } from "bun:test";

import { AgentSpawnsPipeline } from "./agent-spawns-pipeline";
import { agentSpawnsTable } from "../storage/schemas/agent-spawns-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { SUBAGENT_SPAWN_LINK_TYPE, SUBAGENT_SPAWN_CONFIDENCE } from "./spawn-link-writer";

const SESSIONS_DIR = "/state/minsky/sessions";
const PARENT = "aaaaaaaa-0000-0000-0000-000000000001";
const CHILD = "bbbbbbbb-0000-0000-0000-000000000002";
const WORKSPACE_SESSION = "cccccccc-0000-0000-0000-000000000003";
const CWD = "/Users/test/Projects/minsky";
const TS_SPAWN = new Date("2026-01-01T10:00:00.000Z");

function promptWithSessionDir(sessionId: string): string {
  return (
    `You are working in Minsky session at ${SESSIONS_DIR}/${sessionId}. ` +
    `All file paths MUST be absolute paths under this directory.\n\nDo the task.`
  );
}

function makeAgentToolCall(
  opts: { sessionId?: string; prompt?: string } = {}
): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "toolu_agent_1",
    name: "Agent",
    input: {
      ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
      prompt: opts.prompt ?? "Do the task.",
    },
  };
}

interface FakeSpawnRow {
  parentAgentSessionId: string;
  parentTurnIndex: number;
  childAgentSessionId: string | null;
}

interface FakeLinkRow {
  agentSessionId: string;
  minskySessionId: string;
  linkType: string;
  confidence: number | null;
}

/**
 * Fake DB routing `insert()` by TABLE IDENTITY (the actual imported drizzle
 * table object), not by values shape — more robust than duck-typing since
 * AgentSpawnsPipeline and writeSpawnLink each always insert into their own
 * fixed table.
 */
function makeDb(opts: {
  turnRows: Array<{
    agentSessionId: string;
    turnIndex: number;
    toolCalls: unknown;
    endedAt: Date | null;
    parentCwd: string | null;
  }>;
  spawnsStore: Map<string, FakeSpawnRow>;
  linksStore: Map<string, FakeLinkRow>;
}) {
  const { turnRows, spawnsStore, linksStore } = opts;

  return {
    select(_fields?: Record<string, unknown>) {
      return {
        from: (_table: unknown) => ({
          innerJoin: (_joinTable: unknown, _condition: unknown) => ({
            where: (_condition2: unknown) =>
              Promise.resolve(
                turnRows.map((t) => ({
                  agentSessionId: t.agentSessionId,
                  turnIndex: t.turnIndex,
                  toolCalls: t.toolCalls,
                  endedAt: t.endedAt,
                  parentCwd: t.parentCwd,
                }))
              ),
          }),
          where: (_condition: unknown) => Promise.resolve([]),
        }),
      };
    },
    insert(table: unknown) {
      if (table === agentSpawnsTable) {
        return {
          values(v: FakeSpawnRow) {
            const key = `${v.parentAgentSessionId}:${v.parentTurnIndex}`;
            return {
              onConflictDoUpdate(_opts: unknown): Promise<void> {
                spawnsStore.set(key, { ...v });
                return Promise.resolve();
              },
            };
          },
        };
      }
      if (table === minskySessionLinksTable) {
        return {
          values(v: FakeLinkRow) {
            return {
              onConflictDoNothing(): Promise<void> {
                const key = `${v.agentSessionId}:${v.minskySessionId}`;
                if (!linksStore.has(key)) linksStore.set(key, { ...v });
                return Promise.resolve();
              },
            };
          },
        };
      }
      throw new Error("makeDb: insert() called with an unrecognized table");
    },
  };
}

type FakeDb = ReturnType<typeof makeDb>;
function asPg(db: FakeDb) {
  return db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase;
}

describe("AgentSpawnsPipeline — subagent_spawn link wiring (mt#2756)", () => {
  test("writes a subagent_spawn link when child resolves via metadata and prompt embeds a session dir", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          toolCalls: [
            makeAgentToolCall({
              sessionId: CHILD,
              prompt: promptWithSessionDir(WORKSPACE_SESSION),
            }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result = await pipeline.run();

    expect(result.spawnLinksWritten).toBe(1);
    const linkRow = linksStore.get(`${CHILD}:${WORKSPACE_SESSION}`);
    expect(linkRow).toEqual({
      agentSessionId: CHILD,
      minskySessionId: WORKSPACE_SESSION,
      linkType: SUBAGENT_SPAWN_LINK_TYPE,
      confidence: SUBAGENT_SPAWN_CONFIDENCE,
    });
  });

  test("does not write a link when child_agent_session_id is unresolved", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          // No session_id metadata, and the select().where() heuristic query
          // above returns [] unconditionally, so childAgentSessionId stays null.
          toolCalls: [makeAgentToolCall({ prompt: promptWithSessionDir(WORKSPACE_SESSION) })],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result = await pipeline.run();

    expect(result.childUnresolved).toBe(1);
    expect(result.spawnLinksWritten).toBe(0);
    expect(linksStore.size).toBe(0);
  });

  test("does not write a link when the prompt has no session dir, even though child resolves", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          toolCalls: [
            makeAgentToolCall({ sessionId: CHILD, prompt: "Do the task, no session info." }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result = await pipeline.run();

    expect(result.childLinkedFromMetadata).toBe(1);
    expect(result.spawnLinksWritten).toBe(0);
    expect(linksStore.size).toBe(0);
  });

  test("runForSession() drives the same spawn-link wiring as run()", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          toolCalls: [
            makeAgentToolCall({
              sessionId: CHILD,
              prompt: promptWithSessionDir(WORKSPACE_SESSION),
            }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result = await pipeline.runForSession(PARENT);

    expect(result.spawnLinksWritten).toBe(1);
    expect(linksStore.get(`${CHILD}:${WORKSPACE_SESSION}`)?.linkType).toBe(
      SUBAGENT_SPAWN_LINK_TYPE
    );
  });

  test("idempotent: re-running over an already-linked spawn does not duplicate", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          toolCalls: [
            makeAgentToolCall({
              sessionId: CHILD,
              prompt: promptWithSessionDir(WORKSPACE_SESSION),
            }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result1 = await pipeline.run();
    expect(linksStore.size).toBe(1);
    const result2 = await pipeline.run();

    expect(linksStore.size).toBe(1);
    expect(result1.spawnLinksWritten).toBe(1);
    expect(result2.spawnLinksWritten).toBe(1);
  });

  test("multiple spawns in one sweep each independently drive spawn-link writes", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const linksStore = new Map<string, FakeLinkRow>();
    const CHILD2 = "dddddddd-0000-0000-0000-000000000004";
    const WORKSPACE2 = "eeeeeeee-0000-0000-0000-000000000005";
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: PARENT,
          turnIndex: 0,
          toolCalls: [
            makeAgentToolCall({
              sessionId: CHILD,
              prompt: promptWithSessionDir(WORKSPACE_SESSION),
            }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
        {
          agentSessionId: PARENT,
          turnIndex: 2,
          toolCalls: [
            makeAgentToolCall({ sessionId: CHILD2, prompt: promptWithSessionDir(WORKSPACE2) }),
          ],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      spawnsStore,
      linksStore,
    });
    const pipeline = new AgentSpawnsPipeline(asPg(db), SESSIONS_DIR);

    const result = await pipeline.run();

    expect(result.spawnLinksWritten).toBe(2);
    expect(linksStore.has(`${CHILD}:${WORKSPACE_SESSION}`)).toBe(true);
    expect(linksStore.has(`${CHILD2}:${WORKSPACE2}`)).toBe(true);
  });
});
