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
import {
  CHILD_AGENT_SESSION_ID_KEY,
  extractTurns,
  normalizeChildAgentSessionId,
} from "./turn-extractor";

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

/**
 * A tool-result line carrying the Agent tool's own result payload (mt#3962).
 *
 * Mirrors the real record shape, verified against a stored transcript
 * 2026-08-12: `toolUseResult` is a SIBLING of `message` (not a content block),
 * and the id it belongs to lives in `message.content[].tool_use_id`.
 */
function agentResultLine(toolUseId: string, agentId: string, ts = TS3): RawTurnLine {
  return {
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [] }],
    },
    toolUseResult: {
      status: "async_launched",
      agentId,
      description: "Fix mt#999",
      resolvedModel: "claude-sonnet-5",
    },
  } as unknown as RawTurnLine;
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

  // mt#3131 (D6) — synthetic interrupt markers must not become turn boundaries.
  describe("synthetic interrupt marker exclusion", () => {
    test("an interrupt marker directly followed by an assistant response does not become its own turn", () => {
      const transcript: RawTurnLine[] = [
        userLine("real prompt", TS1),
        assistantLine("working on it", [{ type: "tool_use", id: "t1", name: "Bash" }], TS2),
        userLine("[Request interrupted by user for tool use]", TS3),
        // Without the D6 fix, this assistant line would pair with the
        // sentinel above and inflate turnCount with a synthetic turn.
        assistantLine("Understood, stopping.", [], TS4),
      ];
      const turns = extractTurns(transcript);

      // Exactly one turn: the real (prompt, first-response) pair. The
      // sentinel + its follow-on assistant acknowledgment must NOT produce a
      // second turn.
      expect(turns).toHaveLength(1);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.userText).toBe("real prompt");
    });

    test("an interrupt marker sandwiched between real user lines is discarded, not counted", () => {
      const transcript: RawTurnLine[] = [
        userLine("first attempt", TS1),
        userLine("[Request interrupted by user]", TS2),
        userLine("second attempt", TS3),
        assistantLine("response", [], TS4),
      ];
      const turns = extractTurns(transcript);

      expect(turns).toHaveLength(1);
      const turn0 = assertTurn(turns, 0);
      expect(turn0.userText).toBe("second attempt");
    });

    test("both synthetic marker variants are excluded", () => {
      for (const marker of [
        "[Request interrupted by user]",
        "[Request interrupted by user for tool use]",
      ]) {
        const transcript: RawTurnLine[] = [userLine(marker, TS1), assistantLine("reply", [], TS2)];
        const turns = extractTurns(transcript);
        // The sentinel is skipped entirely; the assistant line has no
        // pending user, so it emits its own partial turn with null userText —
        // NOT a turn whose userText is the marker text.
        expect(turns).toHaveLength(1);
        expect(turns[0]?.userText).toBeNull();
        expect(turns[0]?.assistantText).toBe("reply");
      }
    });

    test("a real user message that merely mentions the marker text is NOT excluded", () => {
      const transcript: RawTurnLine[] = [
        userLine("why did [Request interrupted by user] show up?", TS1),
        assistantLine("reply", [], TS2),
      ];
      const turns = extractTurns(transcript);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.userText).toBe("why did [Request interrupted by user] show up?");
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

  describe("queue-operation lines (mt#3260)", () => {
    /**
     * `queue-operation` became a RETAINED type in mt#3260 so queued-message
     * state is recoverable downstream. It carries no `message` and no `uuid`,
     * so the guarantee that matters here is that it flows through extraction
     * INERTLY — it must not open a turn, close one, or split a pair.
     */
    const queueOpLine = (ts: string): RawTurnLine => ({
      type: "queue-operation",
      timestamp: ts,
      operation: "enqueue",
      sessionId: "abc-123",
    });

    test("a queue-operation between a user and assistant line does not split the turn", () => {
      const withQueueOp = extractTurns([userLine("hello"), queueOpLine(TS2), assistantLine("hi")]);
      const without = extractTurns([userLine("hello"), assistantLine("hi")]);

      expect(withQueueOp).toHaveLength(1);
      expect(withQueueOp).toEqual(without);
    });

    test("a transcript of only queue-operation lines yields no turns", () => {
      expect(extractTurns([queueOpLine(TS1), queueOpLine(TS2)])).toHaveLength(0);
    });

    test("a leading queue-operation does not become a turn boundary", () => {
      const turns = extractTurns([queueOpLine(TS1), userLine("hello"), assistantLine("hi")]);
      expect(turns).toHaveLength(1);
      expect(assertTurn(turns, 0).userText).toBe("hello");
    });
  });

  /**
   * mt#3883 — sibling fusion. One emitted turn must correspond to one model
   * turn. The discriminator is `message.id`: shared across the JSONL records of
   * ONE model turn, different between two.
   */
  describe("sibling fusion (mt#3883)", () => {
    /** An assistant line carrying an explicit Messages-API `message.id`. */
    function assistantLineWithId(
      text: string,
      messageId: string,
      toolCalls: Record<string, unknown>[] = [],
      ts = TS2
    ): RawTurnLine {
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text });
      content.push(...toolCalls);
      return {
        type: "assistant",
        timestamp: ts,
        message: { role: "assistant", id: messageId, content },
      };
    }

    test("two consecutive assistant lines with DIFFERENT message.id produce two turns", () => {
      const turns = extractTurns([
        userLine("do two things", TS1),
        assistantLineWithId("first model turn", "msg_a", [], TS2),
        assistantLineWithId("second model turn", "msg_b", [], TS3),
      ]);

      expect(turns).toHaveLength(2);
      expect(assertTurn(turns, 0).userText).toBe("do two things");
      expect(assertTurn(turns, 0).assistantText).toBe("first model turn");
      expect(assertTurn(turns, 1).userText).toBeNull();
      expect(assertTurn(turns, 1).assistantText).toBe("second model turn");
      expect(assertTurn(turns, 0).turnIndex).toBe(0);
      expect(assertTurn(turns, 1).turnIndex).toBe(1);
    });

    test("consecutive assistant lines SHARING a message.id accumulate into one turn", () => {
      const turns = extractTurns([
        userLine("one thing", TS1),
        assistantLineWithId("first half", "msg_a", [], TS2),
        assistantLineWithId("second half", "msg_a", [], TS3),
      ]);

      expect(turns).toHaveLength(1);
      expect(assertTurn(turns, 0).assistantText).toBe("first half\nsecond half");
    });

    test("a parallel tool batch under ONE message.id stays a single turn", () => {
      // This is the population the earlier 12-of-12 sample looked at: several
      // tool_use blocks belonging to one model turn. Accumulation is CORRECT
      // here — a fusion fix that split these would be a regression, not a fix.
      const turns = extractTurns([
        userLine("search two places", TS1),
        assistantLineWithId("dispatching", "msg_a", [regularToolCall("Grep", "toolu_1")], TS2),
        assistantLineWithId("", "msg_a", [regularToolCall("Glob", "toolu_2")], TS3),
      ]);

      expect(turns).toHaveLength(1);
      expect(assertTurn(turns, 0).toolCalls).toHaveLength(2);
    });

    test("assistant lines with NO message.id accumulate, as they did before mt#3883", () => {
      // Absence carries no boundary signal; treating it as one would manufacture
      // turn splits out of missing data.
      const turns = extractTurns([
        userLine("legacy shape", TS1),
        assistantLine("part one", [], TS2),
        assistantLine("part two", [], TS3),
      ]);

      expect(turns).toHaveLength(1);
      expect(assertTurn(turns, 0).assistantText).toBe("part one\npart two");
    });

    test("a same-id continuation after an assistant-only line is not split", () => {
      // Pre-mt#3883 an assistant line with no pending user flushed eagerly, so
      // the continuation landed in its own turn — the fusion defect running the
      // other way.
      const turns = extractTurns([
        assistantLineWithId("bare start", "msg_a", [], TS1),
        assistantLineWithId("bare continued", "msg_a", [], TS2),
      ]);

      expect(turns).toHaveLength(1);
      expect(assertTurn(turns, 0).userText).toBeNull();
      expect(assertTurn(turns, 0).assistantText).toBe("bare start\nbare continued");
    });

    test("a fusion boundary shifts every later turn index by one", () => {
      // The downstream consequence the consumer audit rests on: correcting a
      // boundary renumbers every turn after it, which is why re-extraction
      // cannot preserve embeddings by index (see turn-writer.ts).
      const turns = extractTurns([
        userLine("first", TS1),
        assistantLineWithId("reply one", "msg_a", [], TS2),
        assistantLineWithId("reply two", "msg_b", [], TS3),
        userLine("second", TS3),
        assistantLineWithId("reply three", "msg_c", [], TS4),
      ]);

      expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
      expect(assertTurn(turns, 2).userText).toBe("second");
    });
  });

  describe("child agent session id projection (mt#3962)", () => {
    /** A real Agent-result id shape: bare `a` + 16 hex, as the harness reports it. */
    const RAW_CHILD_ID = "a2967d2071b06d0fc";
    /** The same id in the form `agent_transcripts.agent_session_id` stores. */
    const PREFIXED_CHILD_ID = `agent-${RAW_CHILD_ID}`;

    function childIdOf(turn: ReturnType<typeof assertTurn>, index = 0): unknown {
      const call = turn.toolCalls?.[index] as Record<string, unknown> | undefined;
      return call?.[CHILD_AGENT_SESSION_ID_KEY];
    }

    test("attaches the child id the Agent call's result reported", () => {
      const turns = extractTurns([
        userLine("dispatch one"),
        assistantLine("dispatching", [agentToolCall("toolu_a")]),
        agentResultLine("toolu_a", RAW_CHILD_ID),
      ]);

      expect(childIdOf(assertTurn(turns, 0))).toBe(PREFIXED_CHILD_ID);
    });

    test("two Agent calls on ONE turn resolve to DISTINCT children", () => {
      // The case that is 0-of-159 in production: the cwd-time heuristic hands
      // both calls the same answer because its inputs do not vary per call.
      const turns = extractTurns([
        userLine("dispatch two"),
        assistantLine("dispatching both", [agentToolCall("toolu_a"), agentToolCall("toolu_b")]),
        agentResultLine("toolu_a", "aaaa111122223333"),
        agentResultLine("toolu_b", "bbbb444455556666"),
      ]);

      const turn = assertTurn(turns, 0);
      expect(turn.toolCalls).toHaveLength(2);
      expect(childIdOf(turn, 0)).toBe("agent-aaaa111122223333");
      expect(childIdOf(turn, 1)).toBe("agent-bbbb444455556666");
      expect(childIdOf(turn, 0)).not.toBe(childIdOf(turn, 1));
    });

    test("a call whose result never arrived carries no child id", () => {
      const turns = extractTurns([
        userLine("dispatch one"),
        assistantLine("dispatching", [agentToolCall("toolu_a")]),
      ]);

      expect(childIdOf(assertTurn(turns, 0))).toBeUndefined();
    });

    test("a result with no agentId (an ordinary tool) attaches nothing", () => {
      const turns = extractTurns([
        userLine("run a command"),
        assistantLine("running", [regularToolCall("Bash", "toolu_bash")]),
        toolResultLine("toolu_bash"),
      ]);

      expect(childIdOf(assertTurn(turns, 0))).toBeUndefined();
    });

    test("does not mutate the caller's transcript blocks", () => {
      const call = agentToolCall("toolu_a");
      extractTurns([
        userLine("dispatch"),
        assistantLine("dispatching", [call]),
        agentResultLine("toolu_a", RAW_CHILD_ID),
      ]);

      expect(call[CHILD_AGENT_SESSION_ID_KEY]).toBeUndefined();
    });

    describe("normalizeChildAgentSessionId", () => {
      test("prefixes a bare result id with the transcript-side form", () => {
        expect(normalizeChildAgentSessionId(RAW_CHILD_ID)).toBe(PREFIXED_CHILD_ID);
      });

      test("leaves an already-prefixed id alone, so a re-parse cannot double-prefix", () => {
        expect(normalizeChildAgentSessionId(PREFIXED_CHILD_ID)).toBe(PREFIXED_CHILD_ID);
      });
    });
  });
});

// ── user_origin: who authored the turn's user_text (mt#4289) ──────────────────

describe("userOrigin (mt#4289)", () => {
  /** The auto-compaction boundary record — real shape, observed 2026-08-19. */
  function compactSummaryLine(ts = TS1): RawTurnLine {
    return {
      type: "user",
      timestamp: ts,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous…" },
    } as unknown as RawTurnLine;
  }

  test("a compact-summary line's turn is marked compact_summary, not operator speech", () => {
    const turns = extractTurns([compactSummaryLine(), assistantLine("continuing")]);

    expect(assertTurn(turns, 0).userOrigin).toBe("compact_summary");
  });

  test("an ordinary operator prompt is human", () => {
    const turns = extractTurns([userLine("do X"), assistantLine("done")]);

    expect(assertTurn(turns, 0).userOrigin).toBe("human");
  });

  test("a skill body (isMeta) is harness_meta", () => {
    const skillBody = {
      type: "user",
      timestamp: TS1,
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: /x" }],
      },
    } as unknown as RawTurnLine;

    expect(assertTurn(extractTurns([skillBody, assistantLine("ok")]), 0).userOrigin).toBe(
      "harness_meta"
    );
  });

  test("userOrigin is null exactly when userText is null", () => {
    // A tool_result-only user line opens a pending turn but contributes no
    // text. Stamping it `human` would put an operator-speech marker on a row
    // carrying no operator speech — inverting the question the column answers.
    const turns = extractTurns([
      assistantLine("calling a tool", [regularToolCall("Bash", "toolu_bash")]),
      toolResultLine("toolu_bash"),
      assistantLine("done", [], TS4),
    ]);

    for (const turn of turns) {
      expect(turn.userOrigin === null).toBe(turn.userText === null);
    }
  });

  test("supersession carries the SURVIVING line's origin, not the last line's", () => {
    // Back-to-back user lines: the last one wins for text (see the pairing
    // notes), so the origin must be the one belonging to THAT line. Recomputing
    // at flush time from a stale line is the bug this guards.
    const turns = extractTurns([
      compactSummaryLine(),
      userLine("actually, do Y", TS2),
      assistantLine("doing Y", [], TS3),
    ]);

    expect(assertTurn(turns, 0).userText).toBe("actually, do Y");
    expect(assertTurn(turns, 0).userOrigin).toBe("human");
  });

  test("an operator prompt whose TEXT opens with a synthetic prefix stays human", () => {
    // Negative control for mt#4289's measurement method: the 43.5% figure was
    // measured with `user_text LIKE` prefixes because the table carried no
    // provenance. This asserts the prefixes did not become the predicate.
    const pasted = {
      type: "user",
      timestamp: TS1,
      origin: { kind: "human" },
      promptSource: "typed",
      message: {
        role: "user",
        content: "Base directory for this skill: /x — why is this its own turn?",
      },
    } as unknown as RawTurnLine;

    expect(assertTurn(extractTurns([pasted, assistantLine("because…")]), 0).userOrigin).toBe(
      "human"
    );
  });
});
