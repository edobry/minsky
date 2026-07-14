/**
 * Unit tests for the driven-session streaming-delta accumulation layer
 * (mt#2751, Rung 2B) — the pure reducer `foldDrivenSessionEvent`.
 *
 * Fixture event shapes mirror the real stream-json protocol as confirmed by
 * the mt#2751 spec and mt#2750's own `driven-session-host.test.ts` /
 * `driven-session-ws.test.ts` FakeClaudeProcess frames: `system`/`init`,
 * `stream_event` (Anthropic Messages-API streaming sub-events), complete
 * `assistant`/`user` messages, `result`, and the host's synthetic
 * `minsky_exit`/`minsky_error` terminal frames.
 *
 * Run via:
 *   bun run test:components
 */
import { describe, test, expect } from "bun:test";
import {
  createInitialDrivenAccumulatorState,
  foldDrivenSessionEvent,
  type DrivenAccumulatorState,
} from "./driven-session-accumulator";

function fold(
  state: DrivenAccumulatorState,
  ...events: Record<string, unknown>[]
): DrivenAccumulatorState {
  return events.reduce((s, e) => foldDrivenSessionEvent(s, e), state);
}

/** Extract the plain-text content of the assistant turn block at `blockIndex`. */
function turnText(state: DrivenAccumulatorState, blockIndex: number): string {
  const block = state.blocks[blockIndex];
  const content =
    (block?.content as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return content.find((c) => c.type === "text")?.text ?? "";
}

function messageStart() {
  return { type: "stream_event", event: { type: "message_start" } };
}
function contentBlockStart(
  index: number,
  blockType: "text" | "thinking" | "tool_use",
  extra: Record<string, unknown> = {}
) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: blockType, ...extra } },
  };
}
/**
 * Shared `content_block_delta` wrapper (mt#2751) — the specific per-block-kind
 * delta helpers below all route through this ONE literal occurrence to avoid
 * `custom/no-magic-string-duplication` (test-file-only rule) flagging repeated
 * `"content_block_delta"` string literals across the module.
 */
function contentBlockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "stream_event", event: { type: "content_block_delta", index, delta } };
}
function textDelta(index: number, text: string) {
  return contentBlockDelta(index, { type: "text_delta", text });
}
function inputJsonDelta(index: number, partialJson: string) {
  return contentBlockDelta(index, { type: "input_json_delta", partial_json: partialJson });
}
function thinkingDelta(index: number, thinking: string) {
  return contentBlockDelta(index, { type: "thinking_delta", thinking });
}
function contentBlockStop(index: number) {
  return { type: "stream_event", event: { type: "content_block_stop", index } };
}
function messageStop() {
  return { type: "stream_event", event: { type: "message_stop" } };
}
function messageDelta() {
  // Carries top-level message changes (final stop_reason + cumulative usage);
  // arrives BEFORE message_stop while the turn is still open.
  return {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    },
  };
}

describe("foldDrivenSessionEvent — delta accumulation", () => {
  test("a delta sequence produces a growing block (text accumulates incrementally)", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(state, messageStart(), contentBlockStart(0, "text"));
    expect(state.blocks).toHaveLength(1);
    expect(turnText(state, 0)).toBe("");

    state = foldDrivenSessionEvent(state, textDelta(0, "Hello"));
    expect(turnText(state, 0)).toBe("Hello");
    expect(state.blocks).toHaveLength(1); // same block, updated in place — not a second block.

    state = foldDrivenSessionEvent(state, textDelta(0, ", world"));
    expect(turnText(state, 0)).toBe("Hello, world");

    state = fold(state, contentBlockStop(0), messageStop());
    expect(turnText(state, 0)).toBe("Hello, world");
    expect(state.blocks).toHaveLength(1);
  });

  test("token-granular growth: feeding deltas one at a time grows the visible text incrementally, not only on turn end", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(state, messageStart(), contentBlockStart(0, "text"));

    const tokens = ["The", " quick", " brown", " fox"];
    const seen: string[] = [];
    for (const tok of tokens) {
      state = foldDrivenSessionEvent(state, textDelta(0, tok));
      seen.push(turnText(state, 0));
    }

    // Each successive fold grew the SAME block's text — visible before the turn completes.
    expect(seen).toEqual(["The", "The quick", "The quick brown", "The quick brown fox"]);
    // Not yet finalized — activeTurn is still open (no message_stop yet).
    expect(state.activeTurn).not.toBeNull();
  });

  test("message_delta does NOT terminate the turn — only message_stop does (mt#2751 R1)", () => {
    // Per the Anthropic Messages streaming protocol, message_delta (final
    // stop_reason + usage) arrives BEFORE message_stop while the turn is open.
    // Treating it as terminating cleared activeTurn one event early and could
    // fragment content streamed between message_delta and message_stop.
    let state = createInitialDrivenAccumulatorState();
    state = fold(state, messageStart(), contentBlockStart(0, "text"), textDelta(0, "before delta"));
    expect(state.activeTurn).not.toBeNull();

    // message_delta must leave the turn OPEN.
    state = foldDrivenSessionEvent(state, messageDelta());
    expect(state.activeTurn).not.toBeNull();

    // Content still streaming after message_delta lands in the SAME block, not a
    // fragment / new block.
    state = foldDrivenSessionEvent(state, textDelta(0, " — after delta"));
    expect(turnText(state, 0)).toBe("before delta — after delta");
    expect(state.blocks).toHaveLength(1);

    // message_stop is the sole terminator — now the turn closes.
    state = fold(state, contentBlockStop(0), messageStop());
    expect(state.activeTurn).toBeNull();
    expect(turnText(state, 0)).toBe("before delta — after delta");
    expect(state.blocks).toHaveLength(1);
  });

  test("interleaved tool-use renders as its own content element, distinct from the text element", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(
      state,
      messageStart(),
      contentBlockStart(0, "text"),
      textDelta(0, "Let me check that."),
      contentBlockStop(0),
      contentBlockStart(1, "tool_use", { id: "toolu_1", name: "mcp__minsky__tasks_get" }),
      inputJsonDelta(1, '{"taskId":'),
      inputJsonDelta(1, '"mt#2751"}'),
      contentBlockStop(1),
      messageStop()
    );

    expect(state.blocks).toHaveLength(1); // one turn, two interleaved content elements.
    const content = (state.blocks[0]?.content as { content: Array<Record<string, unknown>> })
      .content;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "text", text: "Let me check that." });
    expect(content[1]).toMatchObject({
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__minsky__tasks_get",
      input: { taskId: "mt#2751" },
    });
  });

  test("a completed turn finalizes — subsequent complete `assistant` event replaces the streamed block (same id), not a duplicate", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(
      state,
      messageStart(),
      contentBlockStart(0, "text"),
      textDelta(0, "partial"),
      messageStop()
    );
    expect(state.blocks).toHaveLength(1);
    const streamedId = state.blocks[0]?.id;

    state = foldDrivenSessionEvent(state, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final, authoritative text" }],
      },
    });

    expect(state.blocks).toHaveLength(1); // replaced in place, not appended.
    expect(state.blocks[0]?.id).toBe(streamedId);
    expect(turnText(state, 0)).toBe("final, authoritative text");
  });

  test("a complete `assistant` event with no preceding stream_event appends a fresh block (fixture/no-partial-messages path)", () => {
    let state = createInitialDrivenAccumulatorState();
    state = foldDrivenSessionEvent(state, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.rawJsonlType).toBe("assistant");
    expect(turnText(state, 0)).toBe("hi");
  });

  test("thinking content marks the turn assistant-thinking", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(
      state,
      messageStart(),
      contentBlockStart(0, "thinking"),
      thinkingDelta(0, "pondering"),
      contentBlockStop(0),
      messageStop()
    );
    expect(state.blocks[0]?.type).toBe("assistant-thinking");
  });

  test("unknown/future event types are tolerated (defensive parse) — state passes through unchanged", () => {
    let state = createInitialDrivenAccumulatorState();
    const before = state;
    state = foldDrivenSessionEvent(state, {
      type: "some_future_event_type_not_yet_documented",
      weird: true,
    });
    expect(state).toBe(before); // literally unchanged (same reference) — a true no-op.
    expect(state.blocks).toHaveLength(0);
  });

  test("unknown stream_event sub-type is tolerated without throwing", () => {
    let state = createInitialDrivenAccumulatorState();
    expect(() => {
      state = foldDrivenSessionEvent(state, {
        type: "stream_event",
        event: { type: "some_future_stream_subevent" },
      });
    }).not.toThrow();
    expect(state.blocks).toHaveLength(0);
  });

  test("a delta with no matching content_block_start is dropped, not thrown", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(state, messageStart());
    expect(() => {
      state = foldDrivenSessionEvent(state, textDelta(0, "orphaned"));
    }).not.toThrow();
    expect(state.blocks).toHaveLength(0);
  });
});

describe("foldDrivenSessionEvent — session lifecycle", () => {
  test("system/init records the harness session id and moves runStatus to running", () => {
    let state = createInitialDrivenAccumulatorState();
    expect(state.runStatus).toBe("connecting");
    state = foldDrivenSessionEvent(state, {
      type: "system",
      subtype: "init",
      session_id: "harness-abc-123",
    });
    expect(state.harnessSessionId).toBe("harness-abc-123");
    expect(state.runStatus).toBe("running");
  });

  test("a `user` tool-result message is its own top-level block, appended (not merged into the assistant turn)", () => {
    let state = createInitialDrivenAccumulatorState();
    state = foldDrivenSessionEvent(state, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "X", input: {} }],
      },
    });
    state = foldDrivenSessionEvent(state, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    });
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]?.rawJsonlType).toBe("user");
  });

  test("`result` sets resultSummary and interactionState back to awaiting-input, without adding a block", () => {
    let state = createInitialDrivenAccumulatorState();
    state = foldDrivenSessionEvent(state, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(state.interactionState).toBe("streaming");

    state = foldDrivenSessionEvent(state, {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      duration_ms: 4200,
      num_turns: 1,
    });
    expect(state.blocks).toHaveLength(1); // result is not a conversation block.
    expect(state.interactionState).toBe("awaiting-input");
    expect(state.resultSummary).toEqual({
      subtype: "success",
      isError: false,
      totalCostUsd: 0.0123,
      durationMs: 4200,
      numTurns: 1,
    });
  });

  test("minsky_exit with status 'exited' sets runStatus exited and interactionState exited", () => {
    let state = createInitialDrivenAccumulatorState();
    state = foldDrivenSessionEvent(state, {
      type: "minsky_exit",
      code: 0,
      signal: null,
      status: "exited",
    });
    expect(state.runStatus).toBe("exited");
    expect(state.interactionState).toBe("exited");
  });

  test("minsky_exit with status 'crashed' (kill mid-stream) surfaces as crashed with the error message — this is the 'view surfaces the exit rather than freezing' acceptance test", () => {
    let state = createInitialDrivenAccumulatorState();
    state = fold(
      state,
      { type: "system", subtype: "init", session_id: "h-1" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working..." }] },
      }
    );
    expect(state.runStatus).toBe("running");

    state = foldDrivenSessionEvent(state, {
      type: "minsky_exit",
      code: null,
      signal: "SIGTERM",
      status: "crashed",
      error: "claude exited with code=null signal=SIGTERM",
    });
    expect(state.runStatus).toBe("crashed");
    expect(state.errorMessage).toContain("SIGTERM");
    expect(state.interactionState).toBe("exited");
  });

  test("minsky_error sets runStatus crashed with a readable message", () => {
    let state = createInitialDrivenAccumulatorState();
    state = foldDrivenSessionEvent(state, {
      type: "minsky_error",
      message: "Failed to start claude: ENOENT",
    });
    expect(state.runStatus).toBe("crashed");
    expect(state.errorMessage).toBe("Failed to start claude: ENOENT");
  });
});
