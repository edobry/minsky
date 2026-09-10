/**
 * mt#4793 SC2 — elision here may only ever REMOVE matches, never manufacture one.
 *
 * This module is the widest-reach elision surface in the hook tree: 12 hooks import it. When
 * mt#4792 fixed the filler in the shared `prose-elision.ts` primitive, it did not reach here,
 * because this module carried its own private copy of the character — so every one of those 12
 * detectors kept the manufactured-match defect. These tests pin the PROPERTY rather than the
 * filler value, so they survive a future filler change that keeps the guarantee and fail one
 * that does not.
 *
 * The rule: a pattern that does not match the raw text must not match the residual. Filling with
 * spaces broke exactly that — a caller's own `\s+` ran through the blanked hole and joined text
 * that was never adjacent.
 */

import { describe, expect, test } from "bun:test";
import { elideQuotedContexts, elideDoubleQuotedSpans, elideQuotedAndCodeContexts } from "./elision";

/**
 * A detector-shaped clause with an `\s+` between its two halves. This is the shape that
 * detonates: the words are separated in the raw text by something the elision removes, so
 * blanking to whitespace makes them look adjacent.
 */
const CLAUSE = /\bdo not\s+attempt\b/i;

describe("elision only ever removes matches — it never manufactures one", () => {
  test.each([
    ["code span", "do not `frobnicate the widget` attempt"],
    ["multi-backtick span", "do not ``frobnicate`` attempt"],
    ["adjacent spans", "do not `a``b` attempt"],
  ])("elideQuotedContexts: %s", (_label, raw) => {
    // The clause is absent from the RAW text — the halves are not adjacent.
    expect(CLAUSE.test(raw)).toBe(false);
    // ...and eliding must not make it appear.
    expect(CLAUSE.test(elideQuotedContexts(raw))).toBe(false);
  });

  test("elideQuotedContexts: a blockquote line", () => {
    const raw = "do not\n> frobnicate the widget\nattempt";
    expect(CLAUSE.test(raw)).toBe(false);
    expect(CLAUSE.test(elideQuotedContexts(raw))).toBe(false);
  });

  test.each([
    ["straight double quote", 'do not "frobnicate the widget" attempt'],
    ["curly double quote", "do not “frobnicate the widget” attempt"],
  ])("elideDoubleQuotedSpans: %s", (_label, raw) => {
    expect(CLAUSE.test(raw)).toBe(false);
    expect(CLAUSE.test(elideDoubleQuotedSpans(raw))).toBe(false);
  });

  test.each([
    ["code span", "do not `an aside` attempt"],
    ["prose quote", 'do not "an aside" attempt'],
    ["quote nested in code", 'do not `an "aside"` attempt'],
  ])("elideQuotedAndCodeContexts (the composed pass): %s", (_label, raw) => {
    expect(CLAUSE.test(raw)).toBe(false);
    expect(CLAUSE.test(elideQuotedAndCodeContexts(raw))).toBe(false);
  });
});

describe("elision preserves the properties its callers depend on", () => {
  const RAW = 'do not `an aside` attempt, and "another" too';

  test("length and line structure are preserved, so offsets stay valid", () => {
    // Callers slice excerpts out of the RAW text using offsets found in the residual.
    expect(elideQuotedAndCodeContexts(RAW)).toHaveLength(RAW.length);
  });

  test("newlines survive, so line-anchored patterns still see line boundaries", () => {
    const multi = "do not `x` attempt\nsecond `y` line\nthird line";
    const residual = elideQuotedAndCodeContexts(multi);
    expect(residual).toHaveLength(multi.length);
    expect(residual.split("\n")).toHaveLength(3);
  });

  test("a match that IS present in the raw text still survives elision", () => {
    // The guarantee is one-directional: elision removes matches, it must not remove the ones
    // that were genuinely there outside an elided span.
    const present = "do not attempt `an aside`";
    expect(CLAUSE.test(present)).toBe(true);
    expect(CLAUSE.test(elideQuotedAndCodeContexts(present))).toBe(true);
  });

  test("the filler is neither whitespace nor a word character", () => {
    // Stated as the two properties the guarantee rests on rather than as the literal character,
    // so a future filler change is free to pick a different one.
    const residual = elideQuotedAndCodeContexts("keep `xxxxx` keep");
    const fill = residual.slice(5, 12);
    expect(fill).not.toMatch(/\s/);
    expect(fill).not.toMatch(/\w/);
  });
});

/**
 * mt#5056 — a quoted span that WRAPS a line must be elided.
 *
 * Both fixtures are verbatim from the transcripts that produced
 * `operator-deferral`'s false-positive records, located by searching for the
 * recorded phrase rather than reconstructed from the calibration log's stored
 * `context` — that field is a 240-character, already-elided window, so it shows
 * these quotations as if they were unterminated. Sampling the source instead of
 * the derived view is what established the real shape (mem#1020, mem#1125).
 */
describe("a quoted span may cross a line break (mt#5056)", () => {
  /** The trigger clause that leaked out of the wrapped quotation in R1. */
  const UNLESS = /\bunless\b/i;
  /** The trigger clause that leaked out of the wrapped quotation in R2. */
  const SAY_THE_WORD = /\bsay\s+the\s+word\s+and\s+(I|we)('?ll|\s+will|\s+can)\b/i;

  /**
   * `2026-09-04T17:48:40.712Z`. A calibration report quoting the phrases it is
   * reporting on. Quotation 1 closes on its own line and was already elided;
   * quotations 2 and 3 wrap, and their `unless` is what fired.
   */
  const R1 = [
    '- `offer-shape:unless` — 4 of 4 false: "I\'ll start there unless you redirect."; "Proceeding with',
    '  that unless you redirect."; "**Defaults I\'ll assume unless you say otherwise:** a 4-week alias',
    '  window …"; "I\'d start with (1) unless you\'d rather go straight at the reviewer alerting."',
  ].join("\n");

  /** `2026-09-04T17:48:56.124Z`. Six quotations; three of them wrap. */
  const R2 = [
    '- Gated on an operator token — "Say go and I\'ll plan it" (`ill-action/I\'ll plan it`); "Say the word',
    "  and I'll write it up as a task\"; \"say the word and I'll take it\" (×2); \"Then say 'go' and I'll",
    "  take it through PR and merge\"; \"say 'continue' and I'll take mt#4842\"; \"Say the word and I'll",
    '  draft it".',
  ].join("\n");

  test.each([
    ["R1 — every `unless` sits inside a quotation", R1, UNLESS],
    ["R2 — every trigger phrase sits inside a quotation", R2, SAY_THE_WORD],
  ])("%s", (_label, raw: string, clause: RegExp) => {
    // The clause IS present in the raw text — this is a real quotation of it...
    expect(clause.test(raw)).toBe(true);
    // ...and after elision nothing is left for a matcher to fire on.
    expect(clause.test(elideQuotedAndCodeContexts(raw))).toBe(false);
  });

  test("the single-line case that already worked still works", () => {
    // Guards against a fix that only moved the failure: R1's FIRST quotation
    // never wrapped and was elided before this change too.
    const single = '4 of 4 false: "I\'ll start there unless you redirect."';
    expect(UNLESS.test(single)).toBe(true);
    expect(UNLESS.test(elideQuotedAndCodeContexts(single))).toBe(false);
  });

  test("an UNQUOTED occurrence still fires — elision must not swallow live prose", () => {
    // The branch-B carve-out, stated as a property here and pinned per-record on
    // the detector. Nothing about crossing lines makes unquoted prose quoted.
    const bare = "a DISJUNCTION whose second branch also requires\nan operator token.";
    expect(/\brequires\s+an\s+operator\s+token\b/i.test(elideQuotedAndCodeContexts(bare))).toBe(
      true
    );
  });

  test("the line budget is real, not vacuous — a span crossing too many lines is left alone", () => {
    // Six short lines inside one quotation: within the 200-char cap, past the
    // newline cap. This is the shape a length bound alone would not catch.
    const listy = ['"a', "b", "c", "d", "e", 'f"'].join("\n");
    expect(listy.length).toBeLessThan(200);
    expect(elideDoubleQuotedSpans(listy)).toBe(listy);
  });

  test("a wrapped span is blanked same-length, with its newlines intact", () => {
    // Both ADR-024 Rung 1 invariants, on the newly-reachable multi-line path:
    // offsets into the residual stay valid, and line-anchored callers still see
    // their line boundaries.
    const wrapped = 'before "one\ntwo\nthree" after';
    const residual = elideDoubleQuotedSpans(wrapped);
    expect(residual).toHaveLength(wrapped.length);
    expect(residual.split("\n")).toHaveLength(3);
    expect(residual).not.toMatch(/two/);
  });

  describe("the budget counts BREAKS, in every encoding (PR #3705 R1)", () => {
    /** A quotation broken `joins` times with the given line-break sequence. */
    const quoted = (br: string, joins: number) =>
      `"a${Array(joins + 1)
        .fill("b")
        .join(br)}c"`;

    test.each([
      ["LF", "\n"],
      ["CRLF", "\r\n"],
      ["CR", "\r"],
    ])("%s: within budget is elided, past it is left alone", (_label, br: string) => {
      const ok = quoted(br, 2);
      const tooMany = quoted(br, 6);
      expect(ok.length).toBeLessThan(200);
      expect(tooMany.length).toBeLessThan(200);
      // Within the budget: blanked, and same-length so offsets stay valid.
      expect(elideDoubleQuotedSpans(ok)).not.toBe(ok);
      expect(elideDoubleQuotedSpans(ok)).toHaveLength(ok.length);
      // Past it: untouched, even though the character cap would have allowed it.
      expect(elideDoubleQuotedSpans(tooMany)).toBe(tooMany);
    });

    test("CR is the case a `\\n` count could not see", () => {
      // Regression pin for the actual hole R1's line pointed at. A lone `\r`
      // contains no `\n`, so counting `\n` scored six breaks as zero and elided
      // a span the cap should have refused. CRLF never had this problem — it
      // contains a `\n` — which is why this test names CR specifically.
      const sixCrBreaks = quoted("\r", 6);
      expect((sixCrBreaks.match(/\n/g) ?? []).length).toBe(0);
      expect((sixCrBreaks.match(/\r\n|\r|\n/g) ?? []).length).toBe(6);
      expect(elideDoubleQuotedSpans(sixCrBreaks)).toBe(sixCrBreaks);
    });
  });

  test("the 200-character cap is unchanged", () => {
    const long = `"${"x".repeat(250)}"`;
    expect(elideDoubleQuotedSpans(long)).toBe(long);
  });

  test("curly quotes get the same treatment", () => {
    const raw = "he said “do not\nattempt that” loudly";
    expect(/\bdo not\s+attempt\b/i.test(raw)).toBe(true);
    expect(/\bdo not\s+attempt\b/i.test(elideDoubleQuotedSpans(raw))).toBe(false);
  });

  test("crossing a line cannot MANUFACTURE a match", () => {
    // The invariant mt#4792 added, re-asserted on the multi-line path: a
    // caller's own `\s+` must not run through the blanked hole.
    const raw = 'do not "an\naside" attempt';
    expect(CLAUSE.test(raw)).toBe(false);
    expect(CLAUSE.test(elideDoubleQuotedSpans(raw))).toBe(false);
  });
});
