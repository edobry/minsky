#!/usr/bin/env bun
// Shared markdown / quotation elision helpers for the UserPromptSubmit
// detector family (mt#2672).
//
// A detector that regex-matches natural-language trigger phrases must not
// fire on text the assistant is DESCRIBING rather than asserting — quoted
// rule text, pasted tool output, calibration-log excerpts. These helpers
// blank such contexts with same-length whitespace so character offsets are
// preserved for downstream excerpt slicing.
//
// History: `elideQuotedContexts` moved here verbatim from
// `ask-routing-deferral-detector.ts` (mt#2471), which re-exports it for API
// stability. `pre-narration-detector.ts` still carries its own sibling
// implementation (`elideMarkdownContexts`); consolidating it onto this
// module belongs to the scanner-family unification thread (mt#2263 /
// ADR-024 ladder), not mt#2672.

/**
 * Best-effort removal of code-span / fenced-code / blockquote contexts so a
 * match inside a phrase the assistant is DESCRIBING (e.g. documenting a
 * detector, or quoting a rule) does not fire. Mirrors the markdown-elision
 * posture of block-out-of-band-merge.ts: replace with same-length whitespace
 * so character offsets are preserved for the excerpt.
 */
export function elideQuotedContexts(text: string): string {
  let out = text;
  // Fenced code blocks (``` or ~~~).
  out = out.replace(/(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\3[^\n]*/g, (m) =>
    " ".repeat(m.length)
  );
  // Inline code spans (single/multi backtick).
  out = out.replace(/`+[^`\n]+`+/g, (m) => " ".repeat(m.length));
  // Blockquote lines.
  out = out.replace(/(^|\n)[ \t]{0,3}>+[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Blank double-quoted prose spans (straight `"..."` and curly “...”),
 * single-line and length-bounded so a stray unpaired quote cannot swallow a
 * paragraph. This is the elision class `elideQuotedContexts` misses: all 5
 * false positives in the 2026-07-08 calibration review window were trigger
 * phrases quoted in double quotes in ordinary prose ("I should have caught",
 * "I made a mistake") while discussing the detector or its calibration data.
 *
 * Deliberately NOT covering single quotes: apostrophes ("I'll", "detector's")
 * make single-quote pairing unreliable.
 */
export function elideDoubleQuotedSpans(text: string): string {
  let out = text;
  // Straight double quotes.
  out = out.replace(/"[^"\n]{1,200}"/g, (m) => " ".repeat(m.length));
  // Curly double quotes.
  out = out.replace(/“[^”\n]{1,200}”/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Composed elision: code/fence/blockquote contexts first (so quotes inside
 * code don't confuse quote pairing), then double-quoted prose spans.
 */
export function elideQuotedAndCodeContexts(text: string): string {
  return elideDoubleQuotedSpans(elideQuotedContexts(text));
}
