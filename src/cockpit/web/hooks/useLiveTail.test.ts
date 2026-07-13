/**
 * Unit tests for the live-tail SSE shape guard (`isRenderableLiveBlock`).
 *
 * Pins the accept/reject contract that the mt#2749 R1 review questioned:
 * emitted live blocks are keyed by `id` (synthesized by the poller), NOT by
 * the raw JSONL line's `uuid`. The guard must ACCEPT a real emitted block and
 * REJECT a raw-JSONL-shaped object that lacks `id`.
 */
import { describe, test, expect } from "bun:test";
import { isRenderableLiveBlock } from "./useLiveTail";

describe("isRenderableLiveBlock", () => {
  test("accepts a real emitted SessionContextSnapshotBlock (keyed by id)", () => {
    // Mirrors what live-tail-poller.ts emits: turnLineToBlock output with the
    // live-id override applied.
    const emitted = {
      id: "abc123:live:0",
      type: "turn",
      source: "observed",
      content: "hello",
      timestamp: "2026-01-01T00:00:01.000Z",
      rawJsonlType: "assistant",
    };
    expect(isRenderableLiveBlock(emitted)).toBe(true);
  });

  test("accepts an emitted block even when timestamp is absent (fail-open ordering)", () => {
    const noTimestamp = {
      id: "abc123:live:1",
      type: "turn",
      source: "observed",
      content: "hi",
      rawJsonlType: "assistant",
    };
    expect(isRenderableLiveBlock(noTimestamp)).toBe(true);
  });

  test("rejects a raw JSONL input line (keyed by uuid, no id)", () => {
    // This is the poller's INPUT shape, not its output — the reviewer's
    // conflation. It must be rejected.
    const rawJsonlLine = {
      uuid: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "assistant",
    };
    expect(isRenderableLiveBlock(rawJsonlLine)).toBe(false);
  });

  test("rejects non-object / null / id-less frames", () => {
    expect(isRenderableLiveBlock(null)).toBe(false);
    expect(isRenderableLiveBlock("not an object")).toBe(false);
    expect(isRenderableLiveBlock(42)).toBe(false);
    expect(isRenderableLiveBlock({ timestamp: "2026-01-01T00:00:01.000Z" })).toBe(false);
    expect(isRenderableLiveBlock({ id: 123 })).toBe(false);
  });
});
