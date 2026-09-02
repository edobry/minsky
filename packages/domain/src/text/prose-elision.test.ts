/**
 * Tests for ADR-024 Rung 1's shared elision primitives (mt#4454).
 *
 * The behavioural coverage of each half already lives with its consumers — this file asserts
 * the properties every consumer DEPENDS ON and that no consumer test would notice breaking:
 * same-length blanking, newline preservation, and the composition order.
 */

import { describe, expect, test } from "bun:test";
import {
  elideMarkdownNonProse,
  elideProseQuotedSpans,
  elideQuotedAndMarkdown,
} from "./prose-elision";

/**
 * The filler `blankSameLength` uses, mirrored here so the assertions below pin the SHAPE of the
 * elision (which characters, how many) without pinning the CHARACTER. Before mt#4792 eight
 * assertions in this file spelled out literal space-runs, which meant a filler change looked
 * like eight behavioural regressions; now it is this one line.
 */
const FILL = "·";
const blank = (n: number): string => FILL.repeat(n);

describe("elideMarkdownNonProse", () => {
  test("blanks fenced blocks, inline code spans, and blockquote lines", () => {
    expect(elideMarkdownNonProse("a `code` b")).toBe(`a ${blank(6)} b`);
    expect(elideMarkdownNonProse("x\n```\nsecret\n```\ny")).toBe(
      `x\n${blank(3)}\n${blank(6)}\n${blank(3)}\ny`
    );
    expect(elideMarkdownNonProse("> quoted line")).toBe(blank(13));
  });

  test("tilde fences and nested blockquotes are covered", () => {
    expect(elideMarkdownNonProse("~~~\nbody\n~~~")).toBe(`${blank(3)}\n${blank(4)}\n${blank(3)}`);
    expect(elideMarkdownNonProse(">> deep")).toBe(blank(7));
  });

  test("leaves ordinary prose untouched", () => {
    const prose = "Budget: retire when mt#1700 ships.";
    expect(elideMarkdownNonProse(prose)).toBe(prose);
  });
});

describe("elideProseQuotedSpans", () => {
  test("blanks straight and curly double-quoted spans", () => {
    expect(elideProseQuotedSpans('a "quoted" b')).toBe(`a ${blank(8)} b`);
    expect(elideProseQuotedSpans("a “quoted” b")).toBe(`a ${blank(8)} b`);
  });

  test("leaves apostrophes alone — a single quote never opens a span", () => {
    // The reason single quotes are excluded: `doesn't` would open a span that never closes
    // and blank the rest of the line, which is a far worse failure than missing a quotation.
    const prose = "It doesn't retire when mt#1700 ships.";
    expect(elideProseQuotedSpans(prose)).toBe(prose);
  });

  test("an unterminated quote does not swallow the rest of the text", () => {
    const prose = 'He said "and then stopped';
    expect(elideProseQuotedSpans(prose)).toBe(prose);
  });

  test("a span does not cross a newline", () => {
    const input = 'a "open\nclose" b';
    expect(elideProseQuotedSpans(input)).toBe(input);
  });
});

describe("elideQuotedAndMarkdown", () => {
  test("applies both halves, and leaves the prose between them", () => {
    //  `code`  -> 6 filler;  " and "  survives;  "quote"  -> 7 filler.
    expect(elideQuotedAndMarkdown('`code` and "quote"')).toBe(`${blank(6)} and ${blank(7)}`);
  });

  test("markdown runs FIRST, so a quote inside a code span cannot open a span", () => {
    // The code span carries an ODD number of quote characters, and that is what makes this
    // assertion discriminating. Under the reversed order `elideProseQuotedSpans` runs first,
    // pairs the unbalanced `"` inside the span with the OPENING `"` of `"done"`, and blanks
    // everything between them — including the real clause.
    //
    // A BALANCED pair inside the span does NOT discriminate. This fixture read
    // '`const q = "x"` … he said "done"' until mt#4898 reversed the composition and measured
    // it: all 28 tests in this file still passed, because `"x"` and `"done"` pair correctly
    // under either order. The test named the invariant and could not fail on it.
    const input = '`const q = "` then retire when mt#1700 ships and he said "done"';
    const out = elideQuotedAndMarkdown(input);
    expect(out).toContain("retire when mt#1700 ships");
  });

  test.each([
    ["plain prose", "Budget: retire when mt#1700 ships."],
    ["inline code", "a `b` c"],
    ["fence", "x\n```\ny\n```\nz"],
    ["blockquote", "> q"],
    ["straight quotes", 'a "b" c'],
    ["curly quotes", "a “b” c"],
    ["mixed", '`a` "b"\n> c\n```\nd\n```'],
  ])("preserves length and line structure: %s", (_label, input) => {
    const out = elideQuotedAndMarkdown(input);
    // Same-length blanking is what makes an offset into the result a valid offset into the
    // input — every consumer slices the ORIGINAL using indices found in the elided copy.
    expect(out).toHaveLength(input.length);
    expect(out.split("\n")).toHaveLength(input.split("\n").length);
  });

  test("is idempotent", () => {
    const input = '`a` "b"\n> c';
    expect(elideQuotedAndMarkdown(elideQuotedAndMarkdown(input))).toBe(
      elideQuotedAndMarkdown(input)
    );
  });

  test("empty input is returned unchanged", () => {
    expect(elideQuotedAndMarkdown("")).toBe("");
  });
});

/**
 * The property mt#4792 exists for. These assert what the filler must DO, not what it IS, so they
 * survive any future filler change that keeps the guarantee — and fail any that does not.
 *
 * The rule: eliding may only ever REMOVE matches. A pattern that does not match the raw text must
 * not match the residual. Filling with spaces broke exactly this, because the caller's own `\s+`
 * ran through the hole and joined text that was never adjacent.
 */
describe("elision only ever removes matches — it never manufactures one", () => {
  // The live retirement-clause pattern from `staleness.ts`, which is what detonated.
  const RETIREMENT = /\bretire[sd]?\s+(?:when|once|after)\s+(mt#\d+)\b/i;

  test("a clause broken by a code span does not reappear in the residual", () => {
    const raw = "Retire when `an aside` mt#7777 ships.";
    expect(RETIREMENT.test(raw)).toBe(false);
    expect(RETIREMENT.test(elideQuotedAndMarkdown(raw))).toBe(false);
  });

  test("the same holds for a prose-quoted span and a blockquote", () => {
    const quoted = 'Retire when "an aside" mt#7777 ships.';
    expect(RETIREMENT.test(quoted)).toBe(false);
    expect(RETIREMENT.test(elideQuotedAndMarkdown(quoted))).toBe(false);
  });

  test.each([
    ["code span", "Retire when `x` mt#1 ships."],
    ["multi-backtick span", "Retire when ``x`` mt#1 ships."],
    ["prose quote", 'Retire when "x" mt#1 ships.'],
    ["curly quote", "Retire when “x” mt#1 ships."],
    ["adjacent spans", "Retire when `x``y` mt#1 ships."],
  ])("no match is manufactured: %s", (_label, raw) => {
    expect(RETIREMENT.test(raw)).toBe(false);
    expect(RETIREMENT.test(elideQuotedAndMarkdown(raw))).toBe(false);
  });

  test("a genuine unquoted clause still matches — the fix does not over-correct", () => {
    const raw = "Budget: retire when mt#4321 ships.";
    expect(RETIREMENT.test(raw)).toBe(true);
    expect(RETIREMENT.test(elideQuotedAndMarkdown(raw))).toBe(true);
  });

  test("a clause INSIDE a code span is still removed — the original Rung 1 job", () => {
    const raw = "- `Retire when mt#1541 ships.` -> HIT";
    expect(RETIREMENT.test(raw)).toBe(true);
    expect(RETIREMENT.test(elideQuotedAndMarkdown(raw))).toBe(false);
  });

  test("the filler is neither whitespace nor a word character", () => {
    // The two properties the guarantee rests on, asserted directly so a future filler that
    // silently loses one fails here rather than in a consumer weeks later.
    const out = elideQuotedAndMarkdown("`x`");
    expect(out).toHaveLength(3);
    expect(/\s/.test(out)).toBe(false);
    expect(/\w/.test(out)).toBe(false);
  });
});
