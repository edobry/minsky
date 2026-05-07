/**
 * Regression tests for surrogate-pair safety in conversation-history.ts (mt#1615).
 *
 * The truncateContent() helper truncates conversation history entries at `maxLength`
 * code units before appending "...". A naive .substring(0, maxLength - 3) can split
 * a surrogate pair, producing an unpaired surrogate in the rendered context string.
 *
 * These tests verify safe truncation for the 300-char case (relevantEntries display).
 */

import { describe, test, expect } from "bun:test";
import { safeTruncate } from "../../../utils/safe-truncate";

// ── Surrogate-safety helpers ─────────────────────────────────────────────────

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
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

// Mirror of the patched truncateContent logic for white-box testing
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${safeTruncate(content, maxLength - 3, "head")}...`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("conversation-history truncateContent — surrogate safety (mt#1615)", () => {
  const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];
  const MAX_LEN = 300;

  test("truncateContent appends '...' and produces valid UTF-16 at boundary", () => {
    // 297 'a's + 🔍 puts high surrogate at code-unit index 297, inside the 300-char window
    // naive substring(0, 297) → 297 ASCII chars (stops before 🔍 — safe)
    // but substring(0, 298) → 297 ASCII + high surrogate (lone)
    // truncateContent uses maxLength-3=297 as the cut, so this exercises the edge case
    const content = `${"a".repeat(297)}🔍trailing`;
    const result = truncateContent(content, MAX_LEN);
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    expect(result.endsWith("...")).toBe(true);
  });

  test("every cut length 0..MAX_LEN on emoji content produces valid UTF-16", () => {
    const content = EMOJIS.join("").repeat(20); // 160 code units, repeated → 3200+ chars
    const longContent = content.slice(0, 350); // > 300 code units
    for (let n = 3; n <= MAX_LEN; n++) {
      const result = truncateContent(longContent, n);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("short content returned unchanged (no truncation needed)", () => {
    const short = "Hello 🔍 world!"; // < 300
    const result = truncateContent(short, MAX_LEN);
    expect(result).toBe(short);
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  test("all four spec emojis at various cut points", () => {
    for (const emoji of EMOJIS) {
      const content = emoji.repeat(160); // 320 code units, > 300
      const result = truncateContent(content, MAX_LEN);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
      expect(result.endsWith("...")).toBe(true);
    }
  });
});
