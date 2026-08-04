/**
 * Tests for spawn→child navigation plumbing (mt#3692).
 *
 * The defect this covers is not "the link is missing" but "the link resolves to
 * the WRONG place": `agent_spawns` used to be keyed on `parent_turn_index`, an
 * index into the (user, assistant)-paired turn projection, while the blocks
 * rendered here are indexed by raw transcript-array position. Joining across
 * those two spaces silently lands on an unrelated turn instead of failing — so
 * these tests assert the child is matched by the Agent call's OWN `tool_use` id,
 * per call, not by any positional index.
 */

import { describe, expect, test } from "bun:test";
import { snapshotBlockToConversationTurn } from "./conversation-elements";
import { findAgentToolCall, findAgentToolCalls } from "./agent-tool-call-shape";
import { spawnChildrenFromRows } from "./session-context-snapshot";
import type { SessionContextSnapshotBlock } from "../context/types";

function block(
  overrides: Partial<SessionContextSnapshotBlock> &
    Pick<SessionContextSnapshotBlock, "rawJsonlType">
): SessionContextSnapshotBlock {
  return {
    id: "sess:turn:0",
    type: "assistant-text",
    source: "observed",
    content: null,
    timestamp: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

/** An assistant block carrying the given tool_use blocks. */
function assistantWithCalls(calls: unknown[]): SessionContextSnapshotBlock {
  return block({ rawJsonlType: "assistant", content: { role: "assistant", content: calls } });
}

function agentCall(id: string, subagentType?: string) {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: subagentType ? { subagent_type: subagentType, prompt: "go" } : { prompt: "go" },
  };
}

/** The tool-call element shape the assertions below reach into. */
type SpawnCall = { kind: string; id?: string; spawn?: { childAgentSessionId?: string } };

describe("findAgentToolCalls", () => {
  test("returns EVERY Agent call on a turn, in order", () => {
    const calls = findAgentToolCalls([
      agentCall("toolu_1", "Explore"),
      { type: "tool_use", id: "b1", name: "Bash", input: {} },
      agentCall("toolu_2", "Plan"),
      agentCall("toolu_3"),
    ]);
    expect(calls.map((c) => c.id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
  });

  test("returns an empty array for a turn with no Agent call, and for non-array input", () => {
    expect(findAgentToolCalls([{ type: "tool_use", id: "b1", name: "Bash", input: {} }])).toEqual(
      []
    );
    expect(findAgentToolCalls(null)).toEqual([]);
    expect(findAgentToolCalls("not an array")).toEqual([]);
  });

  test("the singular finder still returns the FIRST call, unchanged", () => {
    expect(findAgentToolCall([agentCall("toolu_1"), agentCall("toolu_2")])?.id).toBe("toolu_1");
    expect(findAgentToolCall([])).toBeNull();
  });
});

describe("spawnChildrenFromRows", () => {
  test("admits only rows with BOTH a tool_use id and a resolved child", () => {
    const map = spawnChildrenFromRows([
      { parentToolUseId: "toolu_1", childAgentSessionId: "child-1" },
      // Unresolved spawn — renders as a static badge, not a link.
      { parentToolUseId: "toolu_2", childAgentSessionId: null },
      // Stale pre-mt#3692 row the backfill could not key: it addresses no call
      // in the transcript, so it must never produce a link.
      { parentToolUseId: null, childAgentSessionId: "child-3" },
      { parentToolUseId: null, childAgentSessionId: null },
    ]);
    expect(map).toEqual({ toolu_1: "child-1" });
  });

  test("returns undefined when nothing qualifies, so the field is omitted entirely", () => {
    expect(spawnChildrenFromRows([])).toBeUndefined();
    expect(
      spawnChildrenFromRows([{ parentToolUseId: null, childAgentSessionId: "child-1" }])
    ).toBeUndefined();
  });
});

describe("spawn child threading into conversation turns", () => {
  test("a resolved spawn carries its child id on the tool-call element", () => {
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([agentCall("toolu_1", "Explore")]),
      {
        toolu_1: "child-1",
      }
    );
    const call = t?.elements[0] as SpawnCall;
    expect(call.spawn?.childAgentSessionId).toBe("child-1");
    expect(t?.spawnChildAgentSessionId).toBe("child-1");
  });

  test("an unresolved spawn leaves the child undefined but keeps the spawn marker", () => {
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([agentCall("toolu_1", "Explore")]),
      {
        toolu_other: "child-1",
      }
    );
    const call = t?.elements[0] as SpawnCall;
    expect(call.spawn).toBeDefined();
    expect(call.spawn?.childAgentSessionId).toBeUndefined();
    expect(t?.isSpawnBoundary).toBe(true);
    expect(t?.spawnChildAgentSessionId).toBeUndefined();
  });

  test("each call on a multi-spawn turn resolves INDEPENDENTLY", () => {
    // The case the old turn-granular key could not express at all: one turn,
    // three dispatches, only the middle one resolved.
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([
        agentCall("toolu_1", "Explore"),
        agentCall("toolu_2", "Plan"),
        agentCall("toolu_3", "reviewer"),
      ]),
      { toolu_2: "child-2" }
    );
    const children = (t?.elements as SpawnCall[]).map((e) => e.spawn?.childAgentSessionId);
    expect(children).toEqual([undefined, "child-2", undefined]);
  });

  test("the child is matched by tool_use id, NOT by position", () => {
    // Same two calls, map keyed to the SECOND one. A positional join would put
    // the child on the first call; an id join must not.
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([agentCall("toolu_first"), agentCall("toolu_second")]),
      { toolu_second: "child-2" }
    );
    const [first, second] = t?.elements as SpawnCall[];
    expect(first?.spawn?.childAgentSessionId).toBeUndefined();
    expect(second?.spawn?.childAgentSessionId).toBe("child-2");
  });

  test("with no map supplied at all, spawns stay unresolved rather than throwing", () => {
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([agentCall("toolu_1", "Explore")])
    );
    const call = t?.elements[0] as SpawnCall;
    expect(call.spawn?.agentKind).toBe("Explore");
    expect(call.spawn?.childAgentSessionId).toBeUndefined();
  });

  test("a non-Agent tool call never gets a spawn marker, even if the map has its id", () => {
    const t = snapshotBlockToConversationTurn(
      assistantWithCalls([{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }]),
      { toolu_1: "child-1" }
    );
    const call = t?.elements[0] as SpawnCall;
    expect(call.spawn).toBeUndefined();
    expect(t?.isSpawnBoundary).toBe(false);
  });
});
