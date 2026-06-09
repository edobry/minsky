/**
 * Tests for the conversation-element parser (mt#2374).
 *
 * Fixtures mirror the real `agent_transcripts.transcript` line shapes observed
 * during mt#2374 implementation: assistant lines carry `message.content` arrays
 * of `thinking` / `text` / `tool_use` blocks; user lines carry `tool_result`
 * blocks; the Agent tool_use is the spawn-boundary signal.
 */

import { describe, expect, test } from "bun:test";
import {
  snapshotBlockToConversationTurn,
  snapshotBlocksToConversation,
  spawnAgentKindFromInput,
} from "./conversation-elements";
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
    timestamp: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("snapshotBlockToConversationTurn — role detection", () => {
  test("user raw line → role user", () => {
    const t = snapshotBlockToConversationTurn(
      block({ rawJsonlType: "user", content: { role: "user", content: "hi" } })
    );
    expect(t?.role).toBe("user");
  });

  test("assistant raw line → role assistant", () => {
    const t = snapshotBlockToConversationTurn(
      block({ rawJsonlType: "assistant", content: { role: "assistant", content: "hello" } })
    );
    expect(t?.role).toBe("assistant");
  });

  test("non-conversational raw line (attachment) → null", () => {
    expect(snapshotBlockToConversationTurn(block({ rawJsonlType: "attachment" }))).toBeNull();
  });

  test("system raw line → null", () => {
    expect(snapshotBlockToConversationTurn(block({ rawJsonlType: "system" }))).toBeNull();
  });
});

describe("snapshotBlockToConversationTurn — element extraction", () => {
  test("text block → text element", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      })
    );
    expect(t?.elements).toEqual([{ kind: "text", text: "the answer" }]);
  });

  test("thinking block → thinking element", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: { role: "assistant", content: [{ type: "thinking", thinking: "hmm…" }] },
      })
    );
    expect(t?.elements).toEqual([{ kind: "thinking", thinking: "hmm…" }]);
  });

  test("tool_use block → tool-call element with name + input + id", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__minsky__tasks_get",
              input: { taskId: "mt#638" },
            },
          ],
        },
      })
    );
    expect(t?.elements).toEqual([
      {
        kind: "tool-call",
        id: "toolu_1",
        name: "mcp__minsky__tasks_get",
        input: { taskId: "mt#638" },
      },
    ]);
    expect(t?.isSpawnBoundary).toBe(false);
  });

  test("tool_result block (user line) → tool-result element with toolUseId", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "user",
        content: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "result text",
              is_error: false,
            },
          ],
        },
      })
    );
    expect(t?.elements).toEqual([
      { kind: "tool-result", toolUseId: "toolu_1", content: "result text", isError: false },
    ]);
  });

  test("tool_result with is_error: true → isError true", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "user",
        content: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }],
        },
      })
    );
    expect((t?.elements[0] as { isError: boolean }).isError).toBe(true);
  });

  test("mixed thinking + text + tool_use preserve order", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "doing it" },
            { type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } },
          ],
        },
      })
    );
    expect(t?.elements.map((e) => e.kind)).toEqual(["thinking", "text", "tool-call"]);
  });

  test("unknown block type → unknown element (defensive)", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: { role: "assistant", content: [{ type: "image", source: {} }] },
      })
    );
    expect(t?.elements[0]?.kind).toBe("unknown");
  });
});

describe("snapshotBlockToConversationTurn — content shape tolerance", () => {
  test("string message content → single text element", () => {
    const t = snapshotBlockToConversationTurn(
      block({ rawJsonlType: "assistant", content: { role: "assistant", content: "plain" } })
    );
    expect(t?.elements).toEqual([{ kind: "text", text: "plain" }]);
  });

  test("bare array content (no message wrapper) → parsed", () => {
    const t = snapshotBlockToConversationTurn(
      block({ rawJsonlType: "assistant", content: [{ type: "text", text: "bare" }] })
    );
    expect(t?.elements).toEqual([{ kind: "text", text: "bare" }]);
  });

  test("bare string content → single text element", () => {
    const t = snapshotBlockToConversationTurn(
      block({ rawJsonlType: "user", content: "just a string" })
    );
    expect(t?.elements).toEqual([{ kind: "text", text: "just a string" }]);
  });

  test("null content → empty elements (no crash)", () => {
    const t = snapshotBlockToConversationTurn(block({ rawJsonlType: "user", content: null }));
    expect(t?.elements).toEqual([]);
  });
});

describe("spawn-boundary detection", () => {
  test("Agent tool_use → spawn boundary with agentKind from subagent_type", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "a1",
              name: "Agent",
              input: { subagent_type: "Explore", prompt: "look around" },
            },
          ],
        },
      })
    );
    expect(t?.isSpawnBoundary).toBe(true);
    expect(t?.spawnAgentKind).toBe("Explore");
    const call = t?.elements[0];
    expect(call?.kind).toBe("tool-call");
    expect((call as { spawn?: { agentKind: string } }).spawn?.agentKind).toBe("Explore");
  });

  test("Agent tool_use without subagent_type → spawn boundary, agentKind undefined", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: {
          role: "assistant",
          content: [{ type: "tool_use", id: "a1", name: "Agent", input: { model: "opus" } }],
        },
      })
    );
    expect(t?.isSpawnBoundary).toBe(true);
    expect(t?.spawnAgentKind).toBeUndefined();
    // The spawn marker is still present (so the renderer shows a bare "→ subagent").
    const call = t?.elements[0] as { spawn?: { agentKind?: string } };
    expect(call.spawn).toBeDefined();
    expect(call.spawn?.agentKind).toBeUndefined();
  });

  test("non-Agent tool_use → not a spawn boundary", () => {
    const t = snapshotBlockToConversationTurn(
      block({
        rawJsonlType: "assistant",
        content: {
          role: "assistant",
          content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }],
        },
      })
    );
    expect(t?.isSpawnBoundary).toBe(false);
    expect(t?.spawnAgentKind).toBeUndefined();
  });
});

describe("spawnAgentKindFromInput", () => {
  test("subagent_type wins", () => {
    expect(spawnAgentKindFromInput({ subagent_type: "Plan", description: "x" })).toBe("Plan");
  });
  test("agentType fallback", () => {
    expect(spawnAgentKindFromInput({ agentType: "reviewer" })).toBe("reviewer");
  });
  test("description is NOT a kind fallback (it is a free-text task summary)", () => {
    expect(spawnAgentKindFromInput({ description: "Search the codebase" })).toBeUndefined();
  });
  test("none present → undefined", () => {
    expect(spawnAgentKindFromInput({ model: "opus" })).toBeUndefined();
    expect(spawnAgentKindFromInput({ description: "x", model: "opus" })).toBeUndefined();
    expect(spawnAgentKindFromInput(null)).toBeUndefined();
    expect(spawnAgentKindFromInput("nope")).toBeUndefined();
  });
});

describe("snapshotBlocksToConversation", () => {
  test("filters non-conversational blocks, preserves conversational order", () => {
    const blocks: SessionContextSnapshotBlock[] = [
      block({ id: "b0", rawJsonlType: "user", content: { role: "user", content: "q" } }),
      block({ id: "b1", rawJsonlType: "attachment", type: "hook-injection" }),
      block({ id: "b2", rawJsonlType: "assistant", content: { role: "assistant", content: "a" } }),
      block({ id: "b3", rawJsonlType: "system", type: "metadata" }),
    ];
    const turns = snapshotBlocksToConversation(blocks);
    expect(turns.map((t) => t.blockId)).toEqual(["b0", "b2"]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });
});
