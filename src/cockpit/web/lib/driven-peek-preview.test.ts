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
    // maxLen bounds the KEPT text; the returned string is maxLen + 1 (the
    // trailing ellipsis) — see the function's docblock for this contract.
    expect(preview?.length).toBe(241); // 240 chars + ellipsis
    expect(preview?.endsWith("…")).toBe(true);
  });

  test("truncation never splits a surrogate pair — a boundary landing mid-emoji drops the whole pair instead of emitting an unpaired surrogate", () => {
    // 10 ASCII chars, then a surrogate-pair emoji (2 UTF-16 code units) whose
    // FIRST unit sits exactly at index 10 — a naive `.slice(0, 11)` would cut
    // between the emoji's high and low surrogate.
    const prefix = "x".repeat(10);
    const emoji = "\u{1F600}"; // 😀 — U+1F600, encoded as a surrogate pair
    const long = `${prefix}${emoji}${"y".repeat(50)}`;
    const preview = lastMessagePreview([assistantTextBlock("a", long)], 11);
    if (preview === null) throw new Error("expected a non-null preview");
    // safeTruncate backs the cut off to 10 (dropping the whole emoji) rather
    // than keeping a lone high surrogate at position 10.
    const kept = preview.slice(0, -1); // strip the trailing ellipsis
    expect(kept).toBe(prefix);
    // No unpaired surrogate survives: JSON round-trips cleanly (an unpaired
    // surrogate is exactly the failure class safeTruncate exists to prevent —
    // see packages/shared/src/safe-truncate.ts's docblock, mt#1598/mt#1615).
    expect(() => JSON.parse(JSON.stringify(preview))).not.toThrow();
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
