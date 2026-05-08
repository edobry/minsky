/**
 * Regression tests for surrogate-pair safety in file-content.ts (mt#1615).
 *
 * The truncateContent() helper truncates file content at `maxLength` code units
 * before appending "...". Called with maxLength=5000. A naive .substring(0, 4997)
 * can split a surrogate pair when an emoji occupies code units around position 4997.
 *
 * This is the STRONGEST recurrence candidate from the 2026-05-07 incident at column
 * 765918 — large files with user-content emoji hitting the 5KB truncation boundary.
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

describe("file-content truncateContent — surrogate safety (mt#1615)", () => {
  const EMOJIS = ["🔍", "🚀", "🎯", "🤖"];
  const MAX_LEN = 5000;

  test("5KB boundary cut on emoji-rich content produces valid UTF-16", () => {
    // Simulate a file where the 4997th code unit is a high surrogate
    const filler = "a".repeat(4996); // 4996 ASCII chars
    const content = `${filler}🔍` + `rest of file content`; // high surrogate at index 4996
    // Naive substring(0, 4997) → 4996 ASCII + high surrogate (lone)
    const result = truncateContent(content, MAX_LEN);
    expect(hasUnpairedSurrogate(result)).toBe(false);
    expect(jsonRoundtrips(result)).toBe(true);
    expect(result.endsWith("...")).toBe(true);
    // Result should be 4996 + "..." = 4999 chars (stepped back from lone high surrogate)
    expect(result).toBe(`${filler}...`);
  });

  test("sweep of cut lengths 4990..5000 on emoji content: all safe", () => {
    // Build content slightly over 5000 code units with emojis near the boundary
    const base = `${"x".repeat(4980) + EMOJIS.join("").repeat(5)}abc`; // 4980 + 40 + 3 = 5023
    for (let n = 4990; n <= MAX_LEN; n++) {
      const result = truncateContent(base, n);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });

  test("short file content returned unchanged", () => {
    const short = "console.log('Hello 🔍 world!');"; // < 5000
    const result = truncateContent(short, MAX_LEN);
    expect(result).toBe(short);
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  test("all four spec emojis at the 5000-char boundary", () => {
    for (const emoji of EMOJIS) {
      // Place the emoji right at position 4997 (start of last safe+1 slot)
      const prefix = "a".repeat(4997);
      const content = `${prefix + emoji}extra`;
      const result = truncateContent(content, MAX_LEN);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
      expect(result.endsWith("...")).toBe(true);
    }
  });

  test("dense emoji file: every cut from 4980 to 5010 produces no lone surrogates", () => {
    const emojiBlock = EMOJIS.join("").repeat(1300); // 10400 code units, all emojis
    for (let n = 4980; n <= 5010; n++) {
      const result = truncateContent(emojiBlock, n);
      expect(hasUnpairedSurrogate(result)).toBe(false);
      expect(jsonRoundtrips(result)).toBe(true);
    }
  });
});
