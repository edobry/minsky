/**
 * Tests for `computeConversationStats` / `computeDurationMs` (mt#2792 —
 * conversation Overview tab enrichment).
 */
import { describe, test, expect } from "bun:test";
import { computeConversationStats, computeDurationMs } from "./conversation-stats";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

function ts(index: number): string {
  return new Date(Date.UTC(2026, 6, 14, 12, 0, index)).toISOString();
}

function userTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

function assistantTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function assistantToolCallBlock(
  index: number,
  toolUseId: string,
  name: string,
  input: unknown = {}
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function userToolResultBlock(
  index: number,
  toolUseId: string,
  content: unknown,
  isError = false
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

describe("computeConversationStats", () => {
  test("an empty block list yields all-zero/null stats", () => {
    const stats = computeConversationStats([]);
    expect(stats.toolCallCount).toBe(0);
    expect(stats.toolErrorCount).toBe(0);
    expect(stats.toolBreakdown).toEqual([]);
    expect(stats.firstUserPromptSnippet).toBeNull();
    expect(stats.lastAssistantMessageSnippet).toBeNull();
  });

  test("counts tool calls and builds a by-tool breakdown, sorted descending by count", () => {
    const stats = computeConversationStats([
      userTextBlock(0, "please run the tests"),
      assistantToolCallBlock(1, "c1", "Bash", { command: "bun test" }),
      userToolResultBlock(2, "c1", "ok"),
      assistantToolCallBlock(3, "c2", "mcp__minsky__tasks_get", { taskId: "mt#1" }),
      userToolResultBlock(4, "c2", "{}"),
      assistantToolCallBlock(5, "c3", "Bash", { command: "bun run lint" }),
      userToolResultBlock(6, "c3", "ok"),
    ]);

    expect(stats.toolCallCount).toBe(3);
    // Bash x2, minsky · tasks_get x1 — Bash first (higher count).
    expect(stats.toolBreakdown).toEqual([
      { name: "Bash", count: 2 },
      { name: "minsky · tasks_get", count: 1 },
    ]);
  });

  test("caps the breakdown at topN, keeping the highest counts", () => {
    const blocks: SessionContextSnapshotBlock[] = [];
    let i = 0;
    for (const [name, times] of [
      ["Bash", 3],
      ["Read", 2],
      ["Edit", 2],
      ["Grep", 1],
    ] as const) {
      for (let t = 0; t < times; t++) {
        blocks.push(assistantToolCallBlock(i, `c${i}`, name));
        i += 1;
      }
    }
    const stats = computeConversationStats(blocks, { topN: 2 });
    expect(stats.toolBreakdown).toHaveLength(2);
    expect(stats.toolBreakdown[0]).toEqual({ name: "Bash", count: 3 });
    // Read and Edit tie at 2 — alphabetical tiebreak picks Edit.
    expect(stats.toolBreakdown[1]).toEqual({ name: "Edit", count: 2 });
  });

  test("counts only isError:true tool results as errors", () => {
    const stats = computeConversationStats([
      assistantToolCallBlock(0, "c1", "Bash", { command: "ls" }),
      userToolResultBlock(1, "c1", "ok", false),
      assistantToolCallBlock(2, "c2", "Bash", { command: "false" }),
      userToolResultBlock(3, "c2", "command failed", true),
    ]);
    expect(stats.toolCallCount).toBe(2);
    expect(stats.toolErrorCount).toBe(1);
  });

  test("captures the FIRST user-prompt text snippet, ignoring later user turns", () => {
    const stats = computeConversationStats([
      userTextBlock(0, "first message"),
      assistantTextBlock(1, "reply"),
      userTextBlock(2, "second message"),
    ]);
    expect(stats.firstUserPromptSnippet).toBe("first message");
  });

  test("captures the LAST assistant-text snippet, overwriting earlier ones", () => {
    const stats = computeConversationStats([
      userTextBlock(0, "hi"),
      assistantTextBlock(1, "first reply"),
      userTextBlock(2, "more"),
      assistantTextBlock(3, "final reply"),
    ]);
    expect(stats.lastAssistantMessageSnippet).toBe("final reply");
  });

  test("truncates long snippets with an ellipsis", () => {
    const long = "x".repeat(500);
    const stats = computeConversationStats([userTextBlock(0, long)]);
    expect(stats.firstUserPromptSnippet?.endsWith("…")).toBe(true);
    expect(stats.firstUserPromptSnippet?.length).toBeLessThan(long.length);
  });

  test("blank text elements do not produce a snippet", () => {
    const stats = computeConversationStats([userTextBlock(0, "   ")]);
    expect(stats.firstUserPromptSnippet).toBeNull();
  });
});

describe("computeDurationMs", () => {
  test("computes the ms delta between two ISO timestamps", () => {
    const start = "2026-07-14T12:00:00.000Z";
    const end = "2026-07-14T12:05:00.000Z";
    expect(computeDurationMs(start, end)).toBe(5 * 60 * 1000);
  });

  test("returns null when either timestamp is missing", () => {
    expect(computeDurationMs(null, "2026-07-14T12:00:00.000Z")).toBeNull();
    expect(computeDurationMs("2026-07-14T12:00:00.000Z", null)).toBeNull();
    expect(computeDurationMs(null, null)).toBeNull();
  });

  test("returns null for unparseable timestamps", () => {
    expect(computeDurationMs("not-a-date", "2026-07-14T12:00:00.000Z")).toBeNull();
  });

  test("returns null for a negative span (bad data) rather than a negative duration", () => {
    const start = "2026-07-14T12:05:00.000Z";
    const end = "2026-07-14T12:00:00.000Z";
    expect(computeDurationMs(start, end)).toBeNull();
  });
});
