/**
 * Tests for `session-context-snapshot` mapper functions (mt#2022).
 *
 * The pure mapping functions (`mapTurnTypeToBlockType`,
 * `mapAttachmentTypeToBlockType`) are exercised here without a DB. The full
 * `assembleSessionContextSnapshot` function is DB-dependent; its end-to-end
 * test will land alongside the inspector consumer (mt#2023+) where a
 * Postgres-mocked test rig already exists.
 */

import { describe, expect, test } from "bun:test";
import {
  assistantContentKind,
  dispatchBriefHeadBlock,
  mapAttachmentTypeToBlockType,
  mapTurnTypeToBlockType,
  turnLineToBlock,
} from "./session-context-snapshot";
import { PROMPT_WATERMARK } from "../session/prompt-generation";

describe("mapTurnTypeToBlockType (mt#2022)", () => {
  test("user line → user-prompt", () => {
    expect(mapTurnTypeToBlockType("user")).toBe("user-prompt");
  });

  test("assistant line (default) → assistant-text", () => {
    expect(mapTurnTypeToBlockType("assistant")).toBe("assistant-text");
  });

  test("assistant line with kind='thinking' → assistant-thinking", () => {
    expect(mapTurnTypeToBlockType("assistant", "thinking")).toBe("assistant-thinking");
  });

  test("assistant line with kind='text' → assistant-text", () => {
    expect(mapTurnTypeToBlockType("assistant", "text")).toBe("assistant-text");
  });

  test("unknown line type → other", () => {
    expect(mapTurnTypeToBlockType("something-else")).toBe("other");
  });
});

describe("mapAttachmentTypeToBlockType (mt#2022)", () => {
  test("attachment + hook_additional_context → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "hook_additional_context")).toBe(
      "hook-injection"
    );
  });

  test("attachment + task_reminder → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "task_reminder")).toBe("hook-injection");
  });

  test("attachment + auto_mode → hook-injection", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "auto_mode")).toBe("hook-injection");
  });

  test("attachment + deferred_tools_delta → deferred-tool-catalog", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "deferred_tools_delta")).toBe(
      "deferred-tool-catalog"
    );
  });

  test("attachment + mcp_instructions_delta → mcp-instructions", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "mcp_instructions_delta")).toBe(
      "mcp-instructions"
    );
  });

  test("attachment + skill_listing → skill-body", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "skill_listing")).toBe("skill-body");
  });

  test("attachment + unrecognized subtype → other (defensive)", () => {
    expect(mapAttachmentTypeToBlockType("attachment", "some_future_subtype")).toBe("other");
  });

  test("system line → metadata", () => {
    expect(mapAttachmentTypeToBlockType("system", "stop_hook_summary")).toBe("metadata");
    expect(mapAttachmentTypeToBlockType("system", "turn_duration")).toBe("metadata");
  });

  test("unrecognized rawJsonlType → other", () => {
    expect(mapAttachmentTypeToBlockType("unknown", "anything")).toBe("other");
  });
});

describe("assistantContentKind — content-array introspection (mt#2022, PR #1229 reviewer fix)", () => {
  test("pure text content → 'text'", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    expect(assistantContentKind(message)).toBe("text");
  });

  test("pure thinking content → 'thinking'", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "deliberating…" }],
    };
    expect(assistantContentKind(message)).toBe("thinking");
  });

  test("mixed thinking + text → 'thinking' (thinking takes precedence)", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deliberating…" },
        { type: "text", text: "hello" },
      ],
    };
    expect(assistantContentKind(message)).toBe("thinking");
  });

  test("tool_use only (no text/thinking) → 'text' (default)", () => {
    const message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }],
    };
    expect(assistantContentKind(message)).toBe("text");
  });

  test("string content (older JSONL shape) → 'text'", () => {
    const message = { role: "assistant", content: "plain string" };
    expect(assistantContentKind(message)).toBe("text");
  });

  test("malformed message → 'text' (defensive)", () => {
    expect(assistantContentKind(null)).toBe("text");
    expect(assistantContentKind(undefined)).toBe("text");
    expect(assistantContentKind({})).toBe("text");
    expect(assistantContentKind("not an object")).toBe("text");
  });
});

describe("turnLineToBlock — compaction + model extraction (mt#3260)", () => {
  const TS = "2026-07-26T12:00:00.000Z";

  test("extracts a top-level isCompactSummary from a user line", () => {
    // Verified real shape (local corpus 2026-07-26): the flag is TOP-LEVEL on
    // the line, NOT inside `message`.
    const block = turnLineToBlock("sess-1", 0, {
      type: "user",
      isCompactSummary: true,
      timestamp: TS,
      message: { role: "user", content: "summary text" },
    });

    expect(block?.isCompactSummary).toBe(true);
  });

  test("extracts model from an assistant line's inner message", () => {
    const block = turnLineToBlock("sess-1", 0, {
      type: "assistant",
      timestamp: TS,
      message: { role: "assistant", content: [], model: "<synthetic>" },
    });

    expect(block?.model).toBe("<synthetic>");
  });

  test("omits both keys entirely when the line carries neither", () => {
    const block = turnLineToBlock("sess-1", 0, {
      type: "user",
      timestamp: TS,
      message: { role: "user", content: "hello" },
    });

    // Absent, not `undefined`-valued — a line without them must produce the
    // same block shape as before mt#3260.
    expect(block).not.toBeNull();
    expect(Object.hasOwn(block as object, "isCompactSummary")).toBe(false);
    expect(Object.hasOwn(block as object, "model")).toBe(false);
  });

  test("a non-boolean isCompactSummary is not coerced to true", () => {
    const block = turnLineToBlock("sess-1", 0, {
      type: "user",
      isCompactSummary: "yes",
      timestamp: TS,
      message: { role: "user", content: "hello" },
    });

    expect(Object.hasOwn(block as object, "isCompactSummary")).toBe(false);
  });

  test("a non-string model is not carried through", () => {
    const block = turnLineToBlock("sess-1", 0, {
      type: "assistant",
      timestamp: TS,
      message: { role: "assistant", content: [], model: 42 },
    });

    expect(Object.hasOwn(block as object, "model")).toBe(false);
  });
});

describe("dispatchBriefHeadBlock — the pinned turn 0 (mt#4909)", () => {
  /**
   * A subagent transcript's opening line, in the shape the real one has.
   *
   * Modeled on `subagents/agent-a335fb8b0e7586511.jsonl` line 1 — the record the
   * defect was found on: `content` is a bare STRING (not a block array), and the
   * line carries `isSidechain` with no `isMeta` / `isCompactSummary` / `origin`.
   * Both conjuncts the classifier requires are present: the watermark, and the
   * structural corroboration that this record IS a dispatch.
   */
  function dispatchLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "user",
      timestamp: "2026-08-19T12:00:00.000Z",
      uuid: "u-0",
      isSidechain: true,
      agentId: "a335fb8b0e7586511",
      message: {
        role: "user",
        content: `Implement mt#4909 in the session workspace.\n\n${PROMPT_WATERMARK}`,
      },
      ...overrides,
    };
  }

  test("a real dispatch line pins, at turn index 0", () => {
    const block = dispatchBriefHeadBlock("agent-x", dispatchLine());

    expect(block).toBeDefined();
    expect(block?.userOrigin).toBe("dispatch_brief");
    // The ORIGINAL transcript index, not a position in the page — block ids
    // embed it and a deep link into this turn has to keep resolving.
    expect(block?.turnIndex).toBe(0);
    expect(block?.id).toBe("agent-x:turn:0");
  });

  test("null in — the slice already reached turn 0, so nothing pins", () => {
    // The common case on a short conversation: the SQL sends no head line
    // because the brief is already in the page, and pinning it would duplicate.
    expect(dispatchBriefHeadBlock("agent-x", null)).toBeUndefined();
    expect(dispatchBriefHeadBlock("agent-x", undefined)).toBeUndefined();
  });

  test("an ordinary operator turn 0 does NOT pin", () => {
    // A root conversation. `classifyUserLineOrigin` fails OPEN to "human" here,
    // so this asserts the guard is on `dispatch_brief` specifically rather than
    // on "the classifier returned something".
    const block = dispatchBriefHeadBlock("agent-x", {
      type: "user",
      timestamp: "2026-08-19T12:00:00.000Z",
      message: { role: "user", content: "hey, can you look at the reviewer service?" },
    });

    expect(block).toBeUndefined();
  });

  test("prose merely QUOTING a watermark does not pin", () => {
    // The mt#3405 false-positive shape: the marker is present and the
    // structural corroboration is not, so this is an operator talking ABOUT a
    // dispatch rather than a dispatch. Pinning it would hoist an arbitrary
    // message to the top of the conversation.
    const block = dispatchBriefHeadBlock("agent-x", {
      type: "user",
      timestamp: "2026-08-19T12:00:00.000Z",
      message: { role: "user", content: `why does the prompt end with ${PROMPT_WATERMARK}?` },
    });

    expect(block).toBeUndefined();
  });

  test("a non-renderable entry 0 pins nothing rather than throwing", () => {
    // `turnLineToBlock` rejects anything that is not a timestamped
    // user/assistant line. Routing through it means those cases are already
    // handled here, and a malformed row degrades to "no pin".
    expect(dispatchBriefHeadBlock("agent-x", { type: "summary" })).toBeUndefined();
    expect(dispatchBriefHeadBlock("agent-x", dispatchLine({ timestamp: 0 }))).toBeUndefined();
    expect(dispatchBriefHeadBlock("agent-x", "not an object")).toBeUndefined();
  });
});
