import { describe, expect, test } from "bun:test";
import { safeTruncate } from "./safe-truncate";

const HIGH_SURROGATE = (cu: number) => cu >= 0xd800 && cu <= 0xdbff;
const LOW_SURROGATE = (cu: number) => cu >= 0xdc00 && cu <= 0xdfff;

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (HIGH_SURROGATE(c)) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (!LOW_SURROGATE(next)) return true;
      i++;
      continue;
    }
    if (LOW_SURROGATE(c)) return true;
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

describe("safeTruncate", () => {
  test("returns input unchanged when length <= maxLen", () => {
    expect(safeTruncate("abc", 3)).toBe("abc");
    expect(safeTruncate("abc", 10)).toBe("abc");
    expect(safeTruncate("", 0)).toBe("");
  });

  test("rejects negative or non-integer maxLen", () => {
    expect(() => safeTruncate("abc", -1)).toThrow(RangeError);
    expect(() => safeTruncate("abc", 1.5)).toThrow(RangeError);
  });

  test("default side is tail (keeps last N code units)", () => {
    expect(safeTruncate("abcdef", 3)).toBe("def");
    expect(safeTruncate("abcdef", 3, "tail")).toBe("def");
  });

  test("head side keeps first N code units", () => {
    expect(safeTruncate("abcdef", 3, "head")).toBe("abc");
  });

  describe("surrogate-pair safety — tail mode", () => {
    test("drops lone low surrogate at truncation boundary (the canonical bug)", () => {
      // 🔍 = U+1F50D = "🔍". Padding before it forces the boundary
      // to land between high and low surrogate when keeping last 6 code units.
      const s = "xxxx🔍 abcd";
      expect(s.length).toBe(11);
      const naive = s.slice(-6);
      expect(naive.charCodeAt(0)).toBe(0xdd0d);
      expect(hasUnpairedSurrogate(naive)).toBe(true);

      const safe = safeTruncate(s, 6, "tail");
      expect(safe).toBe(" abcd");
      expect(hasUnpairedSurrogate(safe)).toBe(false);
      expect(jsonRoundtrips(safe)).toBe(true);
    });

    test("keeps full pair when boundary lands before the high surrogate", () => {
      const s = "xxxx🔍 abcd";
      const safe = safeTruncate(s, 7, "tail");
      expect(safe).toBe("🔍 abcd");
      expect(hasUnpairedSurrogate(safe)).toBe(false);
    });

    test("does not mutate when first kept char is a high surrogate (start of a valid pair)", () => {
      const s = "ab🔍cd";
      const safe = safeTruncate(s, 4, "tail");
      // Last 4 code units: \uD83D \uDD0D c d — first is a paired high surrogate, valid
      expect(safe).toBe("🔍cd");
      expect(hasUnpairedSurrogate(safe)).toBe(false);
    });
  });

  describe("surrogate-pair safety — head mode", () => {
    test("drops lone high surrogate at truncation boundary", () => {
      const s = "abc🔍xyz";
      const naive = s.slice(0, 4);
      expect(naive.charCodeAt(naive.length - 1)).toBe(0xd83d);
      expect(hasUnpairedSurrogate(naive)).toBe(true);

      const safe = safeTruncate(s, 4, "head");
      expect(safe).toBe("abc");
      expect(hasUnpairedSurrogate(safe)).toBe(false);
      expect(jsonRoundtrips(safe)).toBe(true);
    });

    test("keeps full pair when boundary lands after the low surrogate", () => {
      const s = "abc🔍xyz";
      const safe = safeTruncate(s, 5, "head");
      expect(safe).toBe("abc🔍");
      expect(hasUnpairedSurrogate(safe)).toBe(false);
    });
  });

  describe("regression: lone-surrogate bricking session JSONL (mt#1598)", () => {
    test("🔍-prefixed pre-commit output >800 chars truncated tail-side has no lone surrogate", () => {
      const filler = "Running ESLint with strict quality gates... ".repeat(50);
      const hookOutput = `🔍 ${filler}`;
      expect(hookOutput.length).toBeGreaterThan(800);

      // Sweep every truncation length around the 800 region — the bug is that
      // SOME naive slice lands mid-pair. The safe helper must hold for every length.
      for (let n = 700; n <= Math.min(900, hookOutput.length); n++) {
        const safe = safeTruncate(hookOutput, n, "tail");
        expect(hasUnpairedSurrogate(safe)).toBe(false);
        expect(jsonRoundtrips(safe)).toBe(true);
      }
    });

    test("string of mixed surrogate-pair emojis: no truncation length produces a lone surrogate", () => {
      const s = "🔍🚀🎯".repeat(100); // 600 code units, 300 codepoints
      for (let n = 0; n <= s.length; n++) {
        const safeTail = safeTruncate(s, n, "tail");
        const safeHead = safeTruncate(s, n, "head");
        expect(hasUnpairedSurrogate(safeTail)).toBe(false);
        expect(hasUnpairedSurrogate(safeHead)).toBe(false);
      }
    });

    test("CJK and accented Latin pass through unchanged at codepoint boundaries", () => {
      // CJK is BMP (single code unit), accented Latin is single code unit too.
      // No surrogate concern; helper should not corrupt them.
      const cjk = "日本語テキスト".repeat(50);
      const latin = "café résumé naïve".repeat(20);
      for (const s of [cjk, latin]) {
        const safe = safeTruncate(s, Math.floor(s.length / 2), "tail");
        expect(hasUnpairedSurrogate(safe)).toBe(false);
        expect(jsonRoundtrips(safe)).toBe(true);
      }
    });
  });

  test("result length never exceeds maxLen", () => {
    const s = `${"🔍".repeat(50)}abc`;
    for (let n = 0; n <= s.length + 5; n++) {
      expect(safeTruncate(s, n, "tail").length).toBeLessThanOrEqual(n);
      expect(safeTruncate(s, n, "head").length).toBeLessThanOrEqual(n);
    }
  });
});
