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

describe("elideMarkdownNonProse", () => {
  test("blanks fenced blocks, inline code spans, and blockquote lines", () => {
    expect(elideMarkdownNonProse("a `code` b")).toBe("a        b");
    expect(elideMarkdownNonProse("x\n```\nsecret\n```\ny")).toBe("x\n   \n      \n   \ny");
    expect(elideMarkdownNonProse("> quoted line")).toBe("             ");
  });

  test("tilde fences and nested blockquotes are covered", () => {
    expect(elideMarkdownNonProse("~~~\nbody\n~~~")).toBe("   \n    \n   ");
    expect(elideMarkdownNonProse(">> deep")).toBe("       ");
  });

  test("leaves ordinary prose untouched", () => {
    const prose = "Budget: retire when mt#1700 ships.";
    expect(elideMarkdownNonProse(prose)).toBe(prose);
  });
});

describe("elideProseQuotedSpans", () => {
  test("blanks straight and curly double-quoted spans", () => {
    expect(elideProseQuotedSpans('a "quoted" b')).toBe("a          b");
    expect(elideProseQuotedSpans("a “quoted” b")).toBe("a          b");
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
    //  `code`  -> 6 spaces;  " and "  survives;  "quote"  -> 7 spaces.
    expect(elideQuotedAndMarkdown('`code` and "quote"')).toBe("       and        ");
  });

  test("markdown runs FIRST, so a quote inside a code span cannot open a span", () => {
    // If the order were reversed, the `"` inside the code span would pair with the `"` in the
    // prose after it and blank the text between them — including a real clause.
    const input = '`const q = "x"` then retire when mt#1700 ships and he said "done"';
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
