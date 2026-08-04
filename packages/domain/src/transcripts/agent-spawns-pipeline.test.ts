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
  parentToolUseId: string | null;
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
  /** Collects each `onConflictDoUpdate` argument the pipeline builds. */
  capturedConflictOpts?: unknown[];
}) {
  const { turnRows, transcriptRows, spawnsStore } = opts;
  const capturedConflictOpts = opts.capturedConflictOpts ?? [];

  // Mirrors the REAL unique index — (parent_agent_session_id, parent_tool_use_id),
  // NOT the turn index (mt#3692). Keying this fake on the turn index would silently
  // collapse a multi-spawn turn's rows into one and make a test pass that production
  // would fail, which is the whole defect class this key change exists to fix.
  function spawnKey(parentSessionId: string, parentToolUseId: string | null): string {
    return `${parentSessionId}:${parentToolUseId ?? "<null>"}`;
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
            parentToolUseId: values.parentToolUseId ?? null,
            childAgentSessionId: values.childAgentSessionId ?? null,
            spawnType: values.spawnType ?? null,
            agentKind: values.agentKind ?? null,
            spawnedAt: values.spawnedAt ?? null,
          };
          const key = spawnKey(values.parentAgentSessionId, values.parentToolUseId ?? null);

          return {
            onConflictDoUpdate(_opts: unknown): Promise<void> {
              // Capture what the pipeline actually built, so a test can assert on
              // the REAL conflict clause rather than only on this fake's
              // imitation of it (PR #2634 R1).
              capturedConflictOpts.push(_opts);
              // Mirrors the REAL upsert's COALESCE on child_agent_session_id
              // (PR #2634 R1): a resolved child is never downgraded to NULL by a
              // later sweep whose heuristic came back ambiguous. Modeled here
              // because a fake that plain-overwrites would let the regression
              // test below pass against the fake while production still lost
              // the link.
              const existing = spawnsStore.get(key);
              if (existing && newRow.childAgentSessionId === null) {
                newRow.childAgentSessionId = existing.childAgentSessionId;
              }
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
    /**
     * The harness `tool_use` id — the row's identity since mt#3692. Distinct
     * Agent calls carry distinct ids in reality, so any fixture with two calls
     * in one store must set this, or they collide on the unique key.
     */
    id?: string;
  } = {}
): Record<string, unknown> {
  return {
    type: "tool_use",
    id: opts.id ?? "toolu_agent_1",
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

      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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

      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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

      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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

      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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
      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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
      const row = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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
      const rowAfterFirst = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
      const snapshotFirst = JSON.stringify(rowAfterFirst);

      await pipeline.run();
      const rowAfterSecond = spawnsStore.get(`${SESSION_PARENT}:toolu_agent_1`);
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
            toolCall: makeAgentToolCall({ subagentType: "general-purpose", id: "toolu_turn_0" }),
          }),
          makeSpawnTurn({
            turnIndex: 2,
            toolCall: makeAgentToolCall({ subagentType: "Explore", id: "toolu_turn_2" }),
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

      const row0 = spawnsStore.get(`${SESSION_PARENT}:toolu_turn_0`);
      const row2 = spawnsStore.get(`${SESSION_PARENT}:toolu_turn_2`);
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

// ── One row per Agent call, keyed by tool_use id (mt#3692) ────────────────────

describe("per-Agent-call spawn rows", () => {
  /**
   * Flatten a drizzle `sql` template into its literal text.
   *
   * `JSON.stringify` cannot be used — a drizzle SQL node references Column
   * objects that point back at their Table, which is cyclic. This walks
   * `queryChunks`, collecting the string fragments and column names, which is
   * enough to assert WHICH SQL the pipeline built.
   */
  function sqlText(node: unknown, depth = 0): string {
    if (depth > 6 || node === null || typeof node !== "object") return "";
    const parts: string[] = [];
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) return "";
    for (const chunk of chunks) {
      if (typeof chunk === "string") {
        parts.push(chunk);
        continue;
      }
      if (chunk === null || typeof chunk !== "object") continue;
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) {
        parts.push(...value.filter((v): v is string => typeof v === "string"));
      }
      const name = (chunk as { name?: unknown }).name;
      if (typeof name === "string") parts.push(name);
      parts.push(sqlText(chunk, depth + 1));
    }
    return parts.join(" ");
  }

  /** An Agent tool call with an explicit tool_use id. */
  function agentCallWithId(id: string, subagentType?: string): Record<string, unknown> {
    return {
      type: "tool_use",
      id,
      name: "Agent",
      input: {
        ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
        prompt: "Do the task.",
      },
    };
  }

  function runWithToolCalls(toolCalls: unknown[]): {
    spawnsStore: Map<string, FakeSpawnRow>;
    run: () => Promise<SpawnsPipelineRunResult>;
  } {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: SESSION_PARENT,
          turnIndex: 7,
          toolCalls,
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
      spawnsStore,
    });
    return { spawnsStore, run: () => makePipeline(db).run() };
  }

  test("records the tool_use id as the row's key", async () => {
    const { spawnsStore, run } = runWithToolCalls([agentCallWithId("toolu_solo", "Explore")]);

    const result = await run();

    expect(result.spawnsWritten).toBe(1);
    const row = spawnsStore.get(`${SESSION_PARENT}:toolu_solo`);
    expect(row?.parentToolUseId).toBe("toolu_solo");
    expect(row?.agentKind).toBe("Explore");
    // The turn index is still recorded — it just is not the identity any more.
    expect(row?.parentTurnIndex).toBe(7);
  });

  test("a turn with THREE Agent calls writes THREE rows, not one", async () => {
    // The defect the old (session, turn_index) key had: it could physically hold
    // only one row per turn, so parallel dispatch lost every call but the first.
    const { spawnsStore, run } = runWithToolCalls([
      agentCallWithId("toolu_a", "Explore"),
      agentCallWithId("toolu_b", "Plan"),
      agentCallWithId("toolu_c", "reviewer"),
    ]);

    const result = await run();

    expect(result.spawnsWritten).toBe(3);
    expect(spawnsStore.size).toBe(3);
    expect([...spawnsStore.values()].map((r) => r.parentToolUseId).sort()).toEqual([
      "toolu_a",
      "toolu_b",
      "toolu_c",
    ]);
    expect([...spawnsStore.values()].map((r) => r.agentKind).sort()).toEqual([
      "Explore",
      "Plan",
      "reviewer",
    ]);
  });

  test("non-Agent calls on the same turn are ignored", async () => {
    const { spawnsStore, run } = runWithToolCalls([
      { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
      agentCallWithId("toolu_a", "Explore"),
      { type: "tool_use", id: "toolu_read", name: "Read", input: {} },
    ]);

    await run();

    expect(spawnsStore.size).toBe(1);
    expect(spawnsStore.get(`${SESSION_PARENT}:toolu_a`)).toBeDefined();
  });

  test("re-running is idempotent — the same calls update in place", async () => {
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const db = makeDb({
      turnRows: [
        {
          agentSessionId: SESSION_PARENT,
          turnIndex: 7,
          toolCalls: [agentCallWithId("toolu_a", "Explore"), agentCallWithId("toolu_b", "Plan")],
          endedAt: TS_SPAWN,
          parentCwd: CWD,
        },
      ],
      transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
      spawnsStore,
    });
    const pipeline = makePipeline(db);

    await pipeline.run();
    await pipeline.run();

    expect(spawnsStore.size).toBe(2);
  });

  test("an Agent call with NO tool_use id is skipped and counted, never written", async () => {
    // Writing it would insert a fresh duplicate on every sweep, because NULLs do
    // not collide under the unique index — unbounded growth rather than an upsert.
    const { spawnsStore, run } = runWithToolCalls([
      { type: "tool_use", name: "Agent", input: { prompt: "no id here" } },
      agentCallWithId("toolu_ok", "Explore"),
    ]);

    const result = await run();

    expect(result.spawnsSkippedNoToolUseId).toBe(1);
    expect(result.spawnsWritten).toBe(1);
    expect(spawnsStore.size).toBe(1);
    expect(spawnsStore.get(`${SESSION_PARENT}:toolu_ok`)).toBeDefined();
    expect(spawnsStore.get(`${SESSION_PARENT}:<null>`)).toBeUndefined();
  });

  test("the upsert's own conflict clause coalesces the child rather than overwriting", async () => {
    // Asserts the clause the PIPELINE built, not the fake's imitation of it. The
    // behavioral test below rides on the fake's model of this clause, so without
    // this one, reverting the production COALESCE would leave every test green.
    const capturedConflictOpts: unknown[] = [];
    await makePipeline(
      makeDb({
        turnRows: [
          {
            agentSessionId: SESSION_PARENT,
            turnIndex: 7,
            toolCalls: [makeAgentToolCall({ id: "toolu_a" })],
            endedAt: TS_SPAWN,
            parentCwd: CWD,
          },
        ],
        transcriptRows: [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }],
        spawnsStore: new Map<string, FakeSpawnRow>(),
        capturedConflictOpts,
      })
    ).run();

    expect(capturedConflictOpts.length).toBe(1);
    const set = (capturedConflictOpts[0] as { set: Record<string, unknown> }).set;
    const childClause = sqlText(set.childAgentSessionId);
    expect(childClause).toContain("COALESCE");
    expect(childClause).toContain("child_agent_session_id");
    // The deterministic columns stay plain overwrites — re-deriving them from the
    // same tool call cannot weaken them.
    expect(sqlText(set.agentKind)).not.toContain("COALESCE");
  });

  test("a resolved child survives a later sweep that resolves nothing", async () => {
    // The cwd-time-window fallback is corpus-dependent: a spawn that resolved
    // once can come back ambiguous later, once another transcript lands inside
    // its window. A bare EXCLUDED in the upsert would erase the good link then,
    // and invisibly — an unresolved spawn renders as the ordinary static badge.
    const spawnsStore = new Map<string, FakeSpawnRow>();
    const turnWith = (call: Record<string, unknown>): FakeTurnRow => ({
      agentSessionId: SESSION_PARENT,
      turnIndex: 7,
      toolCalls: [call],
      endedAt: TS_SPAWN,
      parentCwd: CWD,
    });
    const transcriptRows = [{ agentSessionId: SESSION_PARENT, cwd: CWD, startedAt: null }];

    // Sweep 1: the tool call carries the child's session id in its metadata.
    await makePipeline(
      makeDb({
        turnRows: [turnWith(makeAgentToolCall({ id: "toolu_a", sessionId: SESSION_CHILD }))],
        transcriptRows,
        spawnsStore,
      })
    ).run();
    expect(spawnsStore.get(`${SESSION_PARENT}:toolu_a`)?.childAgentSessionId).toBe(SESSION_CHILD);

    // Sweep 2: same call, but nothing resolves this time.
    await makePipeline(
      makeDb({
        turnRows: [turnWith(makeAgentToolCall({ id: "toolu_a" }))],
        transcriptRows: [],
        spawnsStore,
      })
    ).run();

    expect(spawnsStore.get(`${SESSION_PARENT}:toolu_a`)?.childAgentSessionId).toBe(SESSION_CHILD);
    expect(spawnsStore.size).toBe(1);
  });

  test("one failing call does not abort its siblings on the same turn", async () => {
    const { spawnsStore, run } = runWithToolCalls([
      agentCallWithId("toolu_a", "Explore"),
      { type: "tool_use", name: "Agent", input: { prompt: "unkeyable" } },
      agentCallWithId("toolu_c", "reviewer"),
    ]);

    const result = await run();

    expect(result.spawnsWritten).toBe(2);
    expect(result.spawnsSkippedNoToolUseId).toBe(1);
    expect(spawnsStore.size).toBe(2);
  });
});
