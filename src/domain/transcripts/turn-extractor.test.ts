/**
 * Tests for TurnExtractor.
 *
 * All tests use in-memory fixture transcripts — no real Postgres or file
 * system access. Tests cover:
 *  - Basic ordering (turn_index stable and sequential)
 *  - Spawn-boundary detection (Agent tool_use marks is_spawn_boundary)
 *  - tool_result exclusion for spawn-boundary turns
 *  - Edge cases: empty transcript, back-to-back user lines, assistant-only lines
 *
 * @see mt#1352 — turn-extractor.ts + per-turn-embedding-pipeline.ts
 */

import { describe, test, expect } from "bun:test";

import type { RawTurnLine } from "./transcript-source";
import { extractTurns } from "./turn-extractor";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TS1 = "2026-01-01T10:00:00.000Z";
const TS2 = "2026-01-01T11:00:00.000Z";
const TS3 = "2026-01-01T12:00:00.000Z";
const TS4 = "2026-01-01T13:00:00.000Z";

function userLine(text: string, ts = TS1): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

function assistantLine(
  text: string,
  toolCalls: Record<string, unknown>[] = [],
  ts = TS2
): RawTurnLine {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...toolCalls);
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content },
  };
}

function agentToolCall(id = "toolu_agent_1"): Record<string, unknown> {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: {
      description: "Fix mt#999",
      prompt: "You are in session at /some/path. Do the work.",
    },
  };
}

function regularToolCall(name = "Bash", id = "toolu_bash_1"): Record<string, unknown> {
  return {
    type: "tool_use",
    id,
    name,
    input: { command: "ls /tmp" },
  };
}

function toolResultLine(toolUseId = "toolu_agent_1", ts = TS3): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [
            {
              type: "text",
              text: "subagent transcript content goes here...",
            },
          ],
        },
      ],
    },
  };
}

// ── Helper: assert turn exists and return it (avoids repeated narrowing boilerplate) ──

function assertTurn(turns: ReturnType<typeof extractTurns>, index: number) {
  const turn = turns[index];
  if (!turn) {
    throw new Error(
      `Expected turn at index ${index} but got undefined. turns.length=${turns.length}`
    );
  }
  return turn;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractTurns", () => {
  describe("basic ordering", () => {
    test("empty transcript returns empty array", () => {
      const turns = extractTurns([]);
      expect(turns).toHaveLength(0);
    });

    test("single user+assistant pair produces one turn with index 0", () => {
      const transcript: RawTurnLine[] = [
        userLine("hello", TS1),
        assistantLine("hello back", [], TS2),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(1);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.turnIndex).toBe(0);
      expect(turn0.userText).toBe("hello");
      expect(turn0.assistantText).toBe("hello back");
    });

    test("two user+assistant pairs produce two turns with stable sequential indices", () => {
      const transcript: RawTurnLine[] = [
        userLine("turn 1", TS1),
        assistantLine("response 1", [], TS2),
        userLine("turn 2", TS3),
        assistantLine("response 2", [], TS4),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(2);
      const turn0 = assertTurn(turns, 0);
      const turn1 = assertTurn(turns, 1);
      expect(turn0.turnIndex).toBe(0);
      expect(turn1.turnIndex).toBe(1);
      expect(turn0.userText).toBe("turn 1");
      expect(turn1.userText).toBe("turn 2");
    });

    test("timestamps are extracted from user line (startedAt) and assistant line (endedAt)", () => {
      const transcript: RawTurnLine[] = [userLine("hi", TS1), assistantLine("hi back", [], TS2)];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.startedAt).toEqual(new Date(TS1));
      expect(turn0.endedAt).toEqual(new Date(TS2));
    });

    test("trailing user line with no following assistant emits a partial turn", () => {
      const transcript: RawTurnLine[] = [
        userLine("hello", TS1),
        assistantLine("response", [], TS2),
        userLine("trailing user", TS3),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(2);
      const turn1 = assertTurn(turns, 1);
      expect(turn1.userText).toBe("trailing user");
      expect(turn1.assistantText).toBeNull();
    });

    test("back-to-back user lines: last user line wins when no assistant between them", () => {
      const transcript: RawTurnLine[] = [
        userLine("first user", TS1),
        userLine("second user", TS2),
        assistantLine("response", [], TS3),
      ];
      const turns = extractTurns(transcript);

      // Only one turn emitted; the second user line replaces the first.
      expect(turns).toHaveLength(1);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.userText).toBe("second user");
    });

    test("assistant-only line (no preceding user) emits a partial turn", () => {
      const transcript: RawTurnLine[] = [
        assistantLine("bare assistant", [], TS1),
        userLine("next user", TS2),
        assistantLine("next response", [], TS3),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(2);
      const turn0 = assertTurn(turns, 0);
      const turn1 = assertTurn(turns, 1);
      expect(turn0.userText).toBeNull();
      expect(turn0.assistantText).toBe("bare assistant");
      expect(turn1.userText).toBe("next user");
    });
  });

  describe("spawn-boundary detection", () => {
    test("a turn without Agent tool call has is_spawn_boundary = false", () => {
      const transcript: RawTurnLine[] = [
        userLine("hello", TS1),
        assistantLine("response with bash", [regularToolCall()], TS2),
      ];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.isSpawnBoundary).toBe(false);
    });

    test("a turn with Agent tool call has is_spawn_boundary = true", () => {
      const transcript: RawTurnLine[] = [
        userLine("run subagent", TS1),
        assistantLine("dispatching agent", [agentToolCall()], TS2),
      ];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.isSpawnBoundary).toBe(true);
    });

    test("N Agent tool calls produce N turns with is_spawn_boundary = true", () => {
      const transcript: RawTurnLine[] = [
        userLine("first task", TS1),
        assistantLine("first agent call", [agentToolCall("toolu_a1")], TS2),
        userLine("result", TS3),
        userLine("second task", TS3),
        assistantLine("second agent call", [agentToolCall("toolu_a2")], TS4),
      ];
      const turns = extractTurns(transcript);

      const spawnBoundaries = turns.filter((t) => t.isSpawnBoundary);
      expect(spawnBoundaries).toHaveLength(2);
    });

    test("mixed turns: some spawn-boundary, some not", () => {
      const transcript: RawTurnLine[] = [
        userLine("regular request", TS1),
        assistantLine("regular response", [regularToolCall()], TS2),
        userLine("spawn request", TS3),
        assistantLine("spawning", [agentToolCall()], TS4),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(2);
      const turn0 = assertTurn(turns, 0);
      const turn1 = assertTurn(turns, 1);
      expect(turn0.isSpawnBoundary).toBe(false);
      expect(turn1.isSpawnBoundary).toBe(true);
    });

    test("turn with both Agent and regular tool calls is a spawn boundary", () => {
      const transcript: RawTurnLine[] = [
        userLine("do both", TS1),
        assistantLine("mixed calls", [regularToolCall(), agentToolCall()], TS2),
      ];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.isSpawnBoundary).toBe(true);
    });
  });

  describe("tool_result exclusion for spawn-boundary turns", () => {
    test("spawn-boundary turn: assistant_text contains only text, not tool_result content", () => {
      const agentCall = agentToolCall("toolu_agent_1");
      const transcript: RawTurnLine[] = [
        userLine("run subagent", TS1),
        assistantLine("I am running the subagent now.", [agentCall], TS2),
        // The next user turn carries the tool_result (subagent transcript).
        // The extractor should NOT include this content in the spawn turn's assistantText.
        toolResultLine("toolu_agent_1", TS3),
        assistantLine("agent is done", [], TS4),
      ];
      const turns = extractTurns(transcript);

      // Turn 0: spawn boundary — assistantText should only have the text block.
      const spawnTurn = turns.find((t) => t.isSpawnBoundary);
      expect(spawnTurn).toBeDefined();
      expect(spawnTurn?.assistantText).toBe("I am running the subagent now.");
      expect(spawnTurn?.assistantText).not.toContain("subagent transcript content");
    });

    test("spawn-boundary turn: tool_calls captured in toolCalls field, not assistant_text", () => {
      const agentCall = agentToolCall("toolu_agent_1");
      const transcript: RawTurnLine[] = [
        userLine("run subagent", TS1),
        assistantLine("dispatching", [agentCall], TS2),
      ];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.toolCalls).not.toBeNull();
      expect(turn0.toolCalls).toHaveLength(1);
      const firstToolCall = turn0.toolCalls?.[0];
      expect(firstToolCall).toBeDefined();
      if (!firstToolCall) return;
      expect(firstToolCall.name).toBe("Agent");
      // Agent call input (the subagent prompt) is captured in toolCalls, NOT assistantText.
      expect(turn0.assistantText).toBe("dispatching");
    });

    test("tool_result user lines do not appear in userText", () => {
      const agentCall = agentToolCall("toolu_agent_1");
      const transcript: RawTurnLine[] = [
        userLine("run subagent", TS1),
        assistantLine("dispatching", [agentCall], TS2),
        toolResultLine("toolu_agent_1", TS3),
        assistantLine("done", [], TS4),
      ];
      const turns = extractTurns(transcript);

      // The tool_result user line becomes a user turn; its content is a tool_result block.
      // extractUserText should exclude tool_result blocks — userText is null.
      const toolResultTurn = turns.find((t) => t.startedAt?.toISOString() === TS3);
      expect(toolResultTurn?.userText).toBeNull();
    });

    test("non-spawn-boundary turns retain full assistant text including all tool calls", () => {
      const transcript: RawTurnLine[] = [
        userLine("bash please", TS1),
        assistantLine("running bash", [regularToolCall("Bash", "toolu_bash_1")], TS2),
      ];
      const turns = extractTurns(transcript);

      const turn0 = assertTurn(turns, 0);
      expect(turn0.isSpawnBoundary).toBe(false);
      expect(turn0.assistantText).toBe("running bash");
      expect(turn0.toolCalls).toHaveLength(1);
      const firstToolCall = turn0.toolCalls?.[0];
      expect(firstToolCall).toBeDefined();
      if (!firstToolCall) return;
      expect(firstToolCall.name).toBe("Bash");
    });
  });

  describe("content handling", () => {
    test("user message with string content extracted correctly", () => {
      const transcript: RawTurnLine[] = [
        { type: "user", timestamp: TS1, message: { role: "user", content: "plain text" } },
        assistantLine("ok", [], TS2),
      ];
      const turns = extractTurns(transcript);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.userText).toBe("plain text");
    });

    test("assistant message with only thinking blocks produces null assistantText", () => {
      const transcript: RawTurnLine[] = [
        userLine("think first", TS1),
        {
          type: "assistant",
          timestamp: TS2,
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "internal thoughts..." }],
          },
        },
      ];
      const turns = extractTurns(transcript);
      // thinking blocks are excluded from assistantText.
      const turn0 = assertTurn(turns, 0);
      expect(turn0.assistantText).toBeNull();
    });

    test("non-null toolCalls only when tool_use blocks present", () => {
      const transcript: RawTurnLine[] = [
        userLine("no tools", TS1),
        assistantLine("just text", [], TS2),
      ];
      const turns = extractTurns(transcript);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.toolCalls).toBeNull();
    });

    test("lines with no message field produce null userText", () => {
      const transcript: RawTurnLine[] = [
        { type: "user", timestamp: TS1 },
        assistantLine("ok", [], TS2),
      ];
      const turns = extractTurns(transcript);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.userText).toBeNull();
    });
  });
});
