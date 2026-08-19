/**
 * Tests for transcript content resolution (mt#4196).
 *
 * The fixtures here matter as much as the assertions. The analyzer's existing tests build
 * messages as `{ type, role, content }` — the flat legacy shape — and every one of them
 * passed while 496 of 496 production runs rendered nothing but the non-text marker. A
 * fixture written by the same author as the reader encodes the author's assumption about
 * the data, so it cannot disagree with the reader about the shape.
 *
 * `makeStoredMessage` below is therefore built to match what prod actually holds, sampled
 * 2026-08-17 over the 40 most-recently-ingested `agent_transcripts` rows: top-level
 * `content` absent in all 40, `message.content` a string in 39 and a block array in 1.
 */

import { describe, it, expect } from "bun:test";
import type { TranscriptMessage } from "./transcript-service";
import {
  NON_TEXT_MARKER,
  BLINDNESS_RATIO_THRESHOLD,
  resolveTranscriptMessageContent,
  extractTextFromContent,
  resolveMessageText,
  nonTextRatio,
  detectBlindRendering,
} from "./transcript-content";

/** The live stored shape: raw harness JSONL, text nested under `message`. */
function makeStoredMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content: undefined, message: { role: type, content } };
}

/** The legacy pre-extracted shape: text flattened onto the message. */
function makeLegacyMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content };
}

describe("resolveTranscriptMessageContent", () => {
  it("reads the nested message.content on a stored-shape record", () => {
    const msg = makeStoredMessage("user", "add a queue");
    expect(resolveTranscriptMessageContent(msg)).toBe("add a queue");
  });

  it("falls back to the flat content field on a legacy record", () => {
    const msg = makeLegacyMessage("assistant", "picked Redis");
    expect(resolveTranscriptMessageContent(msg)).toBe("picked Redis");
  });

  it("prefers the nested payload when a record somehow carries both", () => {
    // Order is not arbitrary: a row carrying both should be read as the harness wrote it.
    const msg: TranscriptMessage = {
      type: "user",
      role: "user",
      content: "stale flat value",
      message: { content: "live nested value" },
    };
    expect(resolveTranscriptMessageContent(msg)).toBe("live nested value");
  });

  it("returns undefined when neither shape carries content", () => {
    const msg: TranscriptMessage = { type: "user", role: "user", content: undefined };
    expect(resolveTranscriptMessageContent(msg)).toBeUndefined();
  });

  /** The flat value each fallback case must recover — shared so the three cases cannot drift. */
  const FLAT_TEXT = "flat text that must not be lost";

  // PR #3085 R1 (BLOCKING). The guard was `"content" in nested`, which is TRUE for
  // `{ content: undefined }` — so a present-but-empty nested key suppressed the flat
  // fallback in the one function whose job is to try both shapes. Gating on the VALUE
  // fixes it. Both cases below FAIL against the key-existence guard.
  it("falls back to the flat field when nested content is undefined", () => {
    const msg: TranscriptMessage = {
      type: "user",
      role: "user",
      content: FLAT_TEXT,
      message: { content: undefined },
    };
    expect(resolveTranscriptMessageContent(msg)).toBe(FLAT_TEXT);
  });

  it("falls back to the flat field when nested content is null", () => {
    // JSON has no `undefined`, so `null` is the shape this actually takes on a parsed row.
    const msg: TranscriptMessage = {
      type: "user",
      role: "user",
      content: FLAT_TEXT,
      message: { content: null },
    };
    expect(resolveTranscriptMessageContent(msg)).toBe(FLAT_TEXT);
  });

  it("still resolves an empty-string nested payload rather than falling back", () => {
    // `""` CARRIES a value — the harness wrote an empty message. Falling back here would
    // substitute a stale flat value for what the harness actually recorded.
    const msg: TranscriptMessage = {
      type: "user",
      role: "user",
      content: "stale flat value",
      message: { content: "" },
    };
    expect(resolveTranscriptMessageContent(msg)).toBe("");
  });
});

describe("extractTextFromContent", () => {
  it("returns a string payload unchanged", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
  });

  it("concatenates text blocks and skips non-text blocks", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "image", source: "..." },
      { type: "text", text: "second" },
    ];
    expect(extractTextFromContent(blocks)).toBe("first second");
  });

  it("returns null — not an empty string — for an unextractable payload", () => {
    // The distinction is the whole point: "" would make a blind read indistinguishable
    // from a message whose text is genuinely empty.
    expect(extractTextFromContent(undefined)).toBeNull();
    expect(extractTextFromContent(null)).toBeNull();
    expect(extractTextFromContent(42)).toBeNull();
  });
});

describe("resolveMessageText", () => {
  it("AT1 — resolves a stored-shape string message to its text, not the marker", () => {
    const resolved = resolveMessageText(makeStoredMessage("user", "add a queue"));
    expect(resolved.text).toBe("add a queue");
    expect(resolved.isNonText).toBe(false);
  });

  it("AT2 — resolves a stored-shape block array, concatenating text blocks only", () => {
    const resolved = resolveMessageText(
      makeStoredMessage("assistant", [
        { type: "text", text: "chose" },
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "Redis" },
      ])
    );
    expect(resolved.text).toBe("chose Redis");
    expect(resolved.isNonText).toBe(false);
  });

  it("AT3 — leaves the legacy flat shape rendering exactly as before", () => {
    const resolved = resolveMessageText(makeLegacyMessage("user", "legacy text"));
    expect(resolved.text).toBe("legacy text");
    expect(resolved.isNonText).toBe(false);
  });

  it("falls back to the marker and flags it when nothing is extractable", () => {
    const resolved = resolveMessageText({ type: "user", role: "user", content: undefined });
    expect(resolved.text).toBe(NON_TEXT_MARKER);
    expect(resolved.isNonText).toBe(true);
  });

  it("flags by resolution, not by string-matching the marker", () => {
    // A message whose REAL text is the marker literal is not a blind read. Counting
    // fallbacks by comparing rendered strings would misclassify it.
    const resolved = resolveMessageText(makeStoredMessage("user", NON_TEXT_MARKER));
    expect(resolved.text).toBe(NON_TEXT_MARKER);
    expect(resolved.isNonText).toBe(false);
  });
});

describe("nonTextRatio / detectBlindRendering (AT4 — the blindness guard)", () => {
  const readable = Array.from({ length: 10 }, (_, i) =>
    makeStoredMessage(i % 2 === 0 ? "user" : "assistant", `message ${i}`)
  );
  const blind = Array.from({ length: 10 }, (_, i) =>
    makeLegacyMessage(i % 2 === 0 ? "user" : "assistant", undefined)
  );

  it("AT4 — a stored-shape fixture renders with well under 10% non-text", () => {
    expect(nonTextRatio(readable)).toBe(0);
    expect(detectBlindRendering(readable).blind).toBe(false);
  });

  it("AT4 — the check fails when the ratio inverts (the shipped defect's signature)", () => {
    // This is the exact state that ran 496 times and reported "no findings" each time.
    expect(nonTextRatio(blind)).toBe(1);
    const verdict = detectBlindRendering(blind);
    expect(verdict.blind).toBe(true);
    expect(verdict.messageCount).toBe(10);
  });

  it("does not fire just below the threshold", () => {
    const mostlyBlind = [...blind.slice(0, 9), makeStoredMessage("user", "one real message")];
    expect(nonTextRatio(mostlyBlind)).toBeCloseTo(0.9, 5);
    // 0.9 is not ABOVE the 0.9 threshold — the boundary is exclusive.
    expect(detectBlindRendering(mostlyBlind).blind).toBe(false);
    expect(BLINDNESS_RATIO_THRESHOLD).toBe(0.9);
  });

  it("treats an empty transcript as not blind", () => {
    // Nothing to fail to read. Reporting blindness here would fire on every empty session.
    expect(nonTextRatio([])).toBe(0);
    expect(detectBlindRendering([]).blind).toBe(false);
  });
});
