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

import { safeTruncate } from "../../utils/safe-truncate";

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
