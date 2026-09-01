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
