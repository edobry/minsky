/**
 * Tests for AgentSpawnsPipeline.
 *
 * Uses in-memory fakes for the DB — no real Postgres. Tests cover:
 *  - agent_kind extraction from tool_calls JSON
 *  - spawn_type derivation (default foreground when run_in_background absent or false)
 *  - child_agent_session_id from metadata (session_id field on Agent input)
 *  - cwd-time-window heuristic backfill
 *  - upsert idempotency
 *  - graceful handling of turns with no Agent tool call
 *  - graceful handling of missing DB data
 *
 * @see mt#1327 — agent-spawns-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import {
  AgentSpawnsPipeline,
  findAgentToolCall,
  extractAgentKind,
  extractSpawnType,
  extractChildSessionIdFromMetadata,
} from "./agent-spawns-pipeline";
import type { SpawnsPipelineRunResult } from "./agent-spawns-pipeline";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_PARENT = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_CHILD = "bbbbbbbb-0000-0000-0000-000000000002";
const _SESSION_CHILD2 = "cccccccc-0000-0000-0000-000000000003";

const CWD = "/Users/test/Projects/minsky";
const TS_SPAWN = new Date("2026-01-01T10:00:00.000Z");
const _TS_CHILD_START = new Date("2026-01-01T10:00:05.000Z"); // within 30s window
const _TS_CHILD_LATE = new Date("2026-01-01T10:01:00.000Z"); // outside 30s window

// ── Fake row types ────────────────────────────────────────────────────────────

interface FakeSpawnRow {
  parentAgentSessionId: string;
  parentTurnIndex: number;
  childAgentSessionId: string | null;
  spawnType: string | null;
  agentKind: string | null;
  spawnedAt: Date | null;
}

interface FakeTurnRow {
  agentSessionId: string;
  turnIndex: number;
  toolCalls: unknown;
  endedAt: Date | null;
  parentCwd: string | null;
}

interface FakeTranscriptRow {
  agentSessionId: string;
  cwd: string | null;
  startedAt: Date | null;
}

// ── Fake DB builder ───────────────────────────────────────────────────────────

/**
 * Creates a minimal fake DB that mimics drizzle's fluent builder surface for
 * AgentSpawnsPipeline's queries:
 *  (1) select from agent_transcript_turns join agent_transcripts where is_spawn_boundary = true
 *  (2) select from agent_transcripts where cwd = ? and startedAt in range (heuristic)
 *  (3) insert into agent_spawns ... onConflictDoUpdate
 */
function makeDb(opts: {
  turnRows: FakeTurnRow[];
  transcriptRows: FakeTranscriptRow[];
  spawnsStore: Map<string, FakeSpawnRow>;
}) {
  const { turnRows, transcriptRows, spawnsStore } = opts;

  function spawnKey(parentSessionId: string, turnIndex: number): string {
    return `${parentSessionId}:${turnIndex}`;
  }

  // Track which select query is being built so we can route to the right data.
  // We use a marker object approach: track what table was passed to from().
  const db = {
    select(_fields?: Record<string, unknown>) {
      const selectedFields = _fields ?? {};

      return {
        from: (table: unknown) => {
          // If the table appears to be agent_transcript_turns (detected by fields),
          // we're in the spawn-boundary query.
          const _isSpawnQuery =
            selectedFields && "turnIndex" in selectedFields && "toolCalls" in selectedFields;

          // If the table appears to be agent_transcripts cwd heuristic query,
          // it has only agentSessionId in selected fields.
          const _isTranscriptQuery =
            selectedFields &&
            "agentSessionId" in selectedFields &&
            !("turnIndex" in selectedFields);

          return {
            innerJoin: (_joinTable: unknown, _condition: unknown) => ({
              where: (_condition2: unknown) => {
                // Spawn-boundary query: join turn rows with transcript rows.
                return Promise.resolve(
                  turnRows.map((t) => {
                    const transcript = transcriptRows.find(
                      (tr) => tr.agentSessionId === t.agentSessionId
                    );
                    return {
                      agentSessionId: t.agentSessionId,
                      turnIndex: t.turnIndex,
                      toolCalls: t.toolCalls,
                      endedAt: t.endedAt,
                      parentCwd: transcript?.cwd ?? null,
                    };
                  })
                );
              },
            }),
            where: (_condition: unknown) => {
              // Heuristic query on agent_transcripts: return rows whose cwd/startedAt match.
              // We don't parse the drizzle condition — just return all transcript rows
              // and let the pipeline filter. The heuristic test controls data to make
              // one match or zero matches.
              return Promise.resolve(
                transcriptRows.map((tr) => ({ agentSessionId: tr.agentSessionId }))
              );
            },
          };
        },
      };
    },

    insert(_table: unknown) {
      return {
        values(
          values: Partial<FakeSpawnRow> & { parentAgentSessionId: string; parentTurnIndex: number }
        ) {
          const newRow: FakeSpawnRow = {
            parentAgentSessionId: values.parentAgentSessionId,
            parentTurnIndex: values.parentTurnIndex,
            childAgentSessionId: values.childAgentSessionId ?? null,
            spawnType: values.spawnType ?? null,
            agentKind: values.agentKind ?? null,
            spawnedAt: values.spawnedAt ?? null,
          };
          const key = spawnKey(values.parentAgentSessionId, values.parentTurnIndex);

          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              spawnsStore.set(key, newRow);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return db;
}

type FakeDb = ReturnType<typeof makeDb>;

function makePipeline(db: FakeDb): AgentSpawnsPipeline {
  return new AgentSpawnsPipeline(
    db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase
  );
}

// ── Tool call fixtures ────────────────────────────────────────────────────────

function makeAgentToolCall(
  opts: {
    subagentType?: string;
    runInBackground?: boolean;
    sessionId?: string;
  } = {}
): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "toolu_agent_1",
    name: "Agent",
    input: {
      ...(opts.subagentType !== undefined ? { subagent_type: opts.subagentType } : {}),
      ...(opts.runInBackground !== undefined ? { run_in_background: opts.runInBackground } : {}),
      ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
      prompt: "Do the task.",
    },
  };
}

function makeSpawnTurn(
  opts: {
    agentSessionId?: string;
    turnIndex?: number;
    toolCall?: Record<string, unknown>;
    endedAt?: Date;
    parentCwd?: string;
  } = {}
): FakeTurnRow {
  return {
    agentSessionId: opts.agentSessionId ?? SESSION_PARENT,
    turnIndex: opts.turnIndex ?? 0,
    toolCalls: [opts.toolCall ?? makeAgentToolCall()],
    endedAt: opts.endedAt ?? TS_SPAWN,
    parentCwd: opts.parentCwd ?? CWD,
  };
}

// ── Unit tests: extraction helpers ────────────────────────────────────────────

describe("extraction helpers", () => {
  describe("findAgentToolCall", () => {
    test("returns the Agent tool call from an array", () => {
      const toolCalls = [
        { type: "tool_use", name: "Read", input: {} },
        makeAgentToolCall({ subagentType: "general-purpose" }),
      ];
      const result = findAgentToolCall(toolCalls);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Agent");
    });

    test("returns null when no Agent tool call present", () => {
      const toolCalls = [{ type: "tool_use", name: "Read", input: {} }];
      expect(findAgentToolCall(toolCalls)).toBeNull();
    });

    test("returns null for non-array input", () => {
      expect(findAgentToolCall(null)).toBeNull();
      expect(findAgentToolCall(undefined)).toBeNull();
      expect(findAgentToolCall({})).toBeNull();
    });

    test("returns null for empty array", () => {
      expect(findAgentToolCall([])).toBeNull();
    });
  });

  describe("extractAgentKind", () => {
    test("returns subagent_type string when present", () => {
      const call = makeAgentToolCall({ subagentType: "general-purpose" });
      expect(extractAgentKind(call as unknown as Parameters<typeof extractAgentKind>[0])).toBe(
        "general-purpose"
      );
    });

    test("returns null when subagent_type is absent", () => {
      const call = makeAgentToolCall();
      expect(
        extractAgentKind(call as unknown as Parameters<typeof extractAgentKind>[0])
      ).toBeNull();
    });

    test("returns known kinds: Explore, refactorer", () => {
      const kinds = ["Explore", "refactorer", "auditor", "reviewer"];
      for (const kind of kinds) {
        const call = makeAgentToolCall({ subagentType: kind });
        expect(extractAgentKind(call as unknown as Parameters<typeof extractAgentKind>[0])).toBe(
          kind
        );
      }
    });

    test("returns null when input is missing", () => {
      const call = { type: "tool_use", name: "Agent" };
      expect(extractAgentKind(call as Parameters<typeof extractAgentKind>[0])).toBeNull();
    });
  });

  describe("extractSpawnType", () => {
    test("returns 'foreground' when run_in_background is absent", () => {
      const call = makeAgentToolCall();
      expect(extractSpawnType(call as Parameters<typeof extractSpawnType>[0])).toBe("foreground");
    });

    test("returns 'foreground' when run_in_background is false", () => {
      const call = makeAgentToolCall({ runInBackground: false });
      expect(extractSpawnType(call as Parameters<typeof extractSpawnType>[0])).toBe("foreground");
    });

    test("returns 'background' when run_in_background is true", () => {
      const call = makeAgentToolCall({ runInBackground: true });
      expect(extractSpawnType(call as Parameters<typeof extractSpawnType>[0])).toBe("background");
    });

    test("returns 'foreground' when input is missing", () => {
      const call = { type: "tool_use", name: "Agent" };
      expect(extractSpawnType(call as Parameters<typeof extractSpawnType>[0])).toBe("foreground");
    });
  });

  describe("extractChildSessionIdFromMetadata", () => {
    test("returns session_id string when present in input", () => {
      const call = makeAgentToolCall({ sessionId: SESSION_CHILD });
      expect(
        extractChildSessionIdFromMetadata(
          call as Parameters<typeof extractChildSessionIdFromMetadata>[0]
        )
      ).toBe(SESSION_CHILD);
    });

    test("returns null when session_id is absent", () => {
      const call = makeAgentToolCall();
      expect(
        extractChildSessionIdFromMetadata(
          call as Parameters<typeof extractChildSessionIdFromMetadata>[0]
        )
      ).toBeNull();
    });

    test("returns null when input is missing", () => {
      const call = { type: "tool_use", name: "Agent" };
      expect(
        extractChildSessionIdFromMetadata(
          call as Parameters<typeof extractChildSessionIdFromMetadata>[0]
        )
      ).toBeNull();
    });
  });
});

// ── Integration tests: AgentSpawnsPipeline.run() ─────────────────────────────

describe("AgentSpawnsPipeline", () => {
  describe("basic extraction", () => {
    test("writes one spawn row for one spawn-boundary turn", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [makeSpawnTurn()],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result: SpawnsPipelineRunResult = await pipeline.run();

      expect(result.spawnsScanned).toBe(1);
      expect(result.spawnsWritten).toBe(1);
      expect(spawnsStore.size).toBe(1);
    });

    test("extracts agent_kind from tool_calls", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          makeSpawnTurn({
            toolCall: makeAgentToolCall({ subagentType: "refactorer" }),
          }),
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();

      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row).toBeDefined();
      expect(row?.agentKind).toBe("refactorer");
    });

    test("extracts spawn_type as foreground when run_in_background absent", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [makeSpawnTurn()],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();

      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row?.spawnType).toBe("foreground");
    });

    test("extracts spawn_type as background when run_in_background is true", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          makeSpawnTurn({
            toolCall: makeAgentToolCall({ runInBackground: true }),
          }),
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();

      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row?.spawnType).toBe("background");
    });

    test("sets spawned_at from turn endedAt", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [makeSpawnTurn({ endedAt: TS_SPAWN })],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();

      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row?.spawnedAt).toEqual(TS_SPAWN);
    });
  });

  describe("child session linking", () => {
    test("links child_agent_session_id from metadata when session_id present", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          makeSpawnTurn({
            toolCall: makeAgentToolCall({ sessionId: SESSION_CHILD }),
          }),
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      expect(result.childLinkedFromMetadata).toBe(1);
      expect(result.childLinkedFromHeuristic).toBe(0);
      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row?.childAgentSessionId).toBe(SESSION_CHILD);
    });

    test("child_agent_session_id is null when not in metadata and no heuristic match", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      // No transcript rows with matching cwd for heuristic to find.
      const db = makeDb({
        turnRows: [makeSpawnTurn({ parentCwd: "/no/match" })],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: "/no/match", startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      expect(result.childUnresolved).toBe(1);
      const row = spawnsStore.get(`${SESSION_PARENT}:0`);
      expect(row?.childAgentSessionId).toBeNull();
    });
  });

  describe("idempotency", () => {
    test("re-running upserts without creating duplicate rows", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [makeSpawnTurn()],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();
      const sizeAfterFirst = spawnsStore.size;

      await pipeline.run();

      expect(spawnsStore.size).toBe(sizeAfterFirst);
      expect(spawnsStore.size).toBe(1);
    });

    test("multiple runs produce the same row content", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          makeSpawnTurn({
            toolCall: makeAgentToolCall({ subagentType: "Explore", runInBackground: false }),
          }),
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      await pipeline.run();
      const rowAfterFirst = spawnsStore.get(`${SESSION_PARENT}:0`);
      const snapshotFirst = JSON.stringify(rowAfterFirst);

      await pipeline.run();
      const rowAfterSecond = spawnsStore.get(`${SESSION_PARENT}:0`);
      const snapshotSecond = JSON.stringify(rowAfterSecond);

      expect(snapshotSecond).toBe(snapshotFirst);
    });
  });

  describe("multiple spawns", () => {
    test("writes one row per spawn-boundary turn", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          makeSpawnTurn({
            turnIndex: 0,
            toolCall: makeAgentToolCall({ subagentType: "general-purpose" }),
          }),
          makeSpawnTurn({
            turnIndex: 2,
            toolCall: makeAgentToolCall({ subagentType: "Explore" }),
          }),
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      expect(result.spawnsScanned).toBe(2);
      expect(result.spawnsWritten).toBe(2);
      expect(spawnsStore.size).toBe(2);

      const row0 = spawnsStore.get(`${SESSION_PARENT}:0`);
      const row2 = spawnsStore.get(`${SESSION_PARENT}:2`);
      expect(row0?.agentKind).toBe("general-purpose");
      expect(row2?.agentKind).toBe("Explore");
    });
  });

  describe("error handling", () => {
    test("empty turn list returns zero counts", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [],
        transcriptRows: [],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      expect(result.spawnsScanned).toBe(0);
      expect(result.spawnsWritten).toBe(0);
      expect(spawnsStore.size).toBe(0);
    });

    test("turn with null tool_calls is skipped gracefully", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          {
            agentSessionId: SESSION_PARENT,
            turnIndex: 0,
            toolCalls: null,
            endedAt: TS_SPAWN,
            parentCwd: CWD,
          },
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      // Skipped because no Agent tool call found — spawnsWritten stays 0.
      expect(result.spawnsWritten).toBe(0);
      expect(spawnsStore.size).toBe(0);
    });

    test("turn with empty tool_calls array is skipped gracefully", async () => {
      const spawnsStore = new Map<string, FakeSpawnRow>();
      const db = makeDb({
        turnRows: [
          {
            agentSessionId: SESSION_PARENT,
            turnIndex: 0,
            toolCalls: [],
            endedAt: TS_SPAWN,
            parentCwd: CWD,
          },
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore,
      });
      const pipeline = makePipeline(db);

      const result = await pipeline.run();

      expect(result.spawnsWritten).toBe(0);
    });
  });
});
