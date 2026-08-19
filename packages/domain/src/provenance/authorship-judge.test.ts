/**
 * Regression tests for surrogate-pair safety in authorship-judge.ts (mt#1615).
 *
 * The summarizeMessage() function truncates transcript message content at 300 code
 * units. A naive .slice(0, 300) can split a surrogate pair when the 300th code unit
 * is a high surrogate — emitting an unpaired surrogate into the AI prompt string.
 *
 * These tests verify that summarizeMessage produces valid UTF-16 output (no lone
 * surrogates) for every content length in a sweep around the truncation boundary.
 */

import { describe, test, expect } from "bun:test";

// ── Surrogate-safety helpers ─────────────────────────────────────────────────

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate — must be followed by a low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // skip the low surrogate
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true; // lone low surrogate
  }
  return false;
}

function jsonRoundtrips(s: string): boolean {
  try {
    const encoded = JSON.stringify({ s });
    const decoded = JSON.parse(encoded) as { s: string };
    return decoded.s === s;
  } catch {
    return false;
  }
}

// ── Inline invocation of the internal truncation path ────────────────────────
// We exercise the truncation logic by importing safeTruncate directly (same code
// path as the patched summarizeMessage uses) and verifying the wrapper's contract.

import { safeTruncate } from "@minsky/shared/safe-truncate";

// Emoji fixtures (all surrogate-pair emojis, 2 code units each)
const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];
const EMOJI_STRING = EMOJIS.join("").repeat(10); // 80 code units, 40 codepoints

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("authorship-judge summarizeMessage truncation — surrogate safety (mt#1615)", () => {
  const MAX_LEN = 300;

  test("every cut length 0..MAX_LEN on emoji content produces valid UTF-16", () => {
    const content = EMOJI_STRING.repeat(5); // 400 code units (exceeds MAX_LEN)
    for (let n = 0; n <= MAX_LEN; n++) {
      const result = safeTruncate(content, n, "head");
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("boundary cut at exactly 300 on mixed text+emoji is surrogate-safe", () => {
    // Build a string where position 300 (0-indexed) lands inside a surrogate pair
    const prefix = "a".repeat(299); // 299 ASCII chars
    const content = `${prefix}🔍` + `trailing text`;
    // Naive slice(0, 300) would give 299 ASCII + high surrogate (lone)
    const result = safeTruncate(content, MAX_LEN, "head");
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    // Should be exactly 299 chars (steps back one to avoid lone high surrogate)
    expect(result).toBe(prefix);
  });

  test("content shorter than 300 is returned unchanged", () => {
    const short = "Hello 🔍 world"; // 14 chars (< 300)
    const result = safeTruncate(short, MAX_LEN, "head");
    expect(result).toBe(short);
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  test("all four spec emojis at every cut produce no lone surrogates", () => {
    for (const emoji of EMOJIS) {
      // Build a string of 150 copies (300 code units) of the emoji
      const s = emoji.repeat(150); // exactly 300 code units
      for (let n = 0; n <= 300; n++) {
        const result = safeTruncate(s, n, "head");
        expect(hasUnpairedSurrogate(result)).toBe(false);
        expect(jsonRoundtrips(result)).toBe(true);
      }
    }
  });
});

// ── What the judge actually reads (mt#4225) ──────────────────────────────────

/**
 * Everything above this line tests `safeTruncate` directly, on the stated basis that it is the
 * "same code path as the patched summarizeMessage uses". It is the same TRUNCATION path, and
 * the judge's own rendering was never exercised at all — so nothing here could notice that every
 * message it was handed rendered as `[non-text content]`.
 *
 * These tests go through the real public entry point instead: `evaluateTranscript` builds the
 * prompt and hands it to the injected completion service, so a stub that captures the prompt
 * observes exactly what the model would have received. No test-only export, no patched import —
 * the seam is the constructor the production caller already uses.
 */

import { AuthorshipJudge } from "./authorship-judge";
import type { TranscriptMessage } from "./transcript-service";
import { NON_TEXT_MARKER, detectBlindRendering } from "./transcript-content";
import type { DefaultAICompletionService } from "../ai/completion-service";
import { AuthorshipTier } from "./types";

/** The live stored shape: raw harness JSONL, text nested under `message`. */
function storedMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content: undefined, message: { role: type, content } };
}

/** The legacy pre-extracted shape: text flattened onto the message. */
function legacyMessage(type: "user" | "assistant", content: unknown): TranscriptMessage {
  return { type, role: type, content };
}

/** Run the judge against a stub service and return the user prompt it built. */
async function capturePrompt(messages: TranscriptMessage[]): Promise<string> {
  let captured = "";
  const stub = {
    generateObject: async (args: { messages: Array<{ role: string; content: string }> }) => {
      captured = args.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        tier: AuthorshipTier.CO_AUTHORED,
        rationale: "stub",
        substantiveHumanInput: "stub",
        trajectoryChanges: [],
      };
    },
  } as unknown as DefaultAICompletionService;

  await new AuthorshipJudge(stub).evaluateTranscript(messages, {
    taskOrigin: "human",
    specAuthorship: "mixed",
  } as Parameters<AuthorshipJudge["evaluateTranscript"]>[1]);

  return captured;
}

describe("AuthorshipJudge reads the stored transcript shape (mt#4225)", () => {
  test("renders the text of a stored-shape string message", async () => {
    const prompt = await capturePrompt([storedMessage("user", "please add caching")]);
    expect(prompt).toContain("please add caching");
    expect(prompt).not.toContain(NON_TEXT_MARKER);
  });

  test("concatenates text blocks from a stored-shape block array", async () => {
    const prompt = await capturePrompt([
      storedMessage("assistant", [
        { type: "text", text: "chose" },
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "Redis" },
      ]),
    ]);
    expect(prompt).toContain("chose Redis");
    expect(prompt).not.toContain(NON_TEXT_MARKER);
  });

  test("still renders the legacy flat shape unchanged", async () => {
    const prompt = await capturePrompt([legacyMessage("user", "legacy text")]);
    expect(prompt).toContain("legacy text");
  });

  test("a whole stored-shape transcript reaches the model as real text", async () => {
    const prompt = await capturePrompt([
      storedMessage("user", "add a queue"),
      storedMessage("assistant", "used BullMQ"),
      storedMessage("user", "why BullMQ?"),
    ]);
    expect(prompt).toContain("add a queue");
    expect(prompt).toContain("used BullMQ");
    expect(prompt).toContain("why BullMQ?");
    expect(prompt).not.toContain(NON_TEXT_MARKER);
  });

  test("the blindness signature is detectable on the judge's own input", async () => {
    // SC6: >90% marker-rendering is the shape of a broken read, not a quiet session.
    const stored = Array.from({ length: 10 }, (_, i) => storedMessage("user", `message ${i}`));
    expect(detectBlindRendering(stored).blind).toBe(false);
    expect(detectBlindRendering(stored).ratio).toBe(0);

    // A transcript carrying neither shape is what the pre-fix reading produced for every row.
    const unreadable = Array.from({ length: 10 }, () => legacyMessage("user", undefined));
    expect(detectBlindRendering(unreadable).blind).toBe(true);

    const prompt = await capturePrompt(unreadable);
    expect(prompt).toContain(NON_TEXT_MARKER);
  });
});
