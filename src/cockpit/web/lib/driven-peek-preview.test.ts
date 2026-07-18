/**
 * Tests for driven-peek-preview.ts (mt#2912).
 */
import { describe, test, expect } from "bun:test";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { lastMessagePreview } from "./driven-peek-preview";

function assistantTextBlock(id: string, text: string): SessionContextSnapshotBlock {
  return {
    id,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2026-07-18T00:00:00Z",
    rawJsonlType: "assistant",
  };
}

function userTextBlock(id: string, text: string): SessionContextSnapshotBlock {
  return {
    id,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: [{ type: "text", text }] },
    timestamp: "2026-07-18T00:00:01Z",
    rawJsonlType: "user",
  };
}

describe("lastMessagePreview", () => {
  test("returns null for an empty block list", () => {
    expect(lastMessagePreview([])).toBeNull();
  });

  test("extracts the last block's text", () => {
    const blocks = [assistantTextBlock("a", "first"), assistantTextBlock("b", "second")];
    expect(lastMessagePreview(blocks)).toBe("second");
  });

  test("works for a user-role last block too (blocking prompt may be the operator's own echoed input)", () => {
    const blocks = [assistantTextBlock("a", "question?"), userTextBlock("b", "answer")];
    expect(lastMessagePreview(blocks)).toBe("answer");
  });

  test("truncates long text and appends an ellipsis", () => {
    const long = "x".repeat(300);
    const blocks = [assistantTextBlock("a", long)];
    const preview = lastMessagePreview(blocks, 240);
    expect(preview?.length).toBe(241); // 240 chars + ellipsis
    expect(preview?.endsWith("…")).toBe(true);
  });

  test("concatenates multiple text/thinking parts in order", () => {
    const block: SessionContextSnapshotBlock = {
      id: "a",
      type: "assistant-thinking",
      source: "observed",
      content: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "conclusion" },
        ],
      },
      timestamp: "2026-07-18T00:00:00Z",
      rawJsonlType: "assistant",
    };
    expect(lastMessagePreview([block])).toBe("pondering conclusion");
  });

  test("renders a tool_use-only block as a compact tool marker", () => {
    const block: SessionContextSnapshotBlock = {
      id: "a",
      type: "assistant-text",
      source: "observed",
      content: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "mcp__minsky__tasks_get", input: {} }],
      },
      timestamp: "2026-07-18T00:00:00Z",
      rawJsonlType: "assistant",
    };
    expect(lastMessagePreview([block])).toBe("[used tool: mcp__minsky__tasks_get]");
  });

  test("returns null when the last block has no extractable text", () => {
    const block: SessionContextSnapshotBlock = {
      id: "a",
      type: "assistant-text",
      source: "observed",
      content: {
        role: "assistant",
        content: [{ type: "tool_result", content: "", tool_use_id: "t1" }],
      },
      timestamp: "2026-07-18T00:00:00Z",
      rawJsonlType: "assistant",
    };
    expect(lastMessagePreview([block])).toBeNull();
  });
});
