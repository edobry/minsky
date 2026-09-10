#!/usr/bin/env bun
// Shared markdown / quotation elision helpers for the UserPromptSubmit
// detector family (mt#2672).
//
// A detector that regex-matches natural-language trigger phrases must not
// fire on text the assistant is DESCRIBING rather than asserting — quoted
// rule text, pasted tool output, calibration-log excerpts. These helpers
// blank such contexts with a SAME-LENGTH, NON-MATCHING filler: same length so
// character offsets are preserved for downstream excerpt slicing, non-matching
// so a caller's own `\s+` cannot run through the hole and match text that was
// never adjacent.
//
// The filler is imported, not restated (mt#4793). This module is consumed by
// 12 hooks and is the widest-reach elision surface in the tree; when mt#4792
// fixed the filler in `prose-elision.ts` it did not reach here, because this
// module carried its own private copy of the character. One source of truth is
// what stops the next filler fix from missing this module the same way.
//
// The REGEXES stay local deliberately — see `elideDoubleQuotedSpans`'s note on
// the 200-char bound and the curly-quote pass. Which contexts each detector
// elides is per-detector calibration and changing it would move fire rates;
// this module converges on the FILLER only.
//
// History: `elideQuotedContexts` moved here verbatim from
// `ask-routing-deferral-detector.ts` (mt#2471), which re-exports it for API
// stability. `pre-narration-detector.ts` still carries its own sibling
// implementation (`elideMarkdownContexts`); consolidating it onto this
// module belongs to the scanner-family unification thread (mt#2263 /
// ADR-024 ladder), not mt#2672.

import { blankSameLength } from "../../packages/domain/src/text/prose-elision";

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
    blankSameLength(m)
  );
  // Inline code spans (single/multi backtick).
  out = out.replace(/`+[^`\n]+`+/g, (m) => blankSameLength(m));
  // Blockquote lines.
  out = out.replace(/(^|\n)[ \t]{0,3}>+[^\n]*/g, (m) => blankSameLength(m));
  return out;
}

/**
 * How many line breaks a quoted span may cross and still be elided (mt#5056).
 *
 * Grounded in the corpus, not picked round: repo prose hard-wraps near 100
 * columns, so the 200-character cap below already admits about two breaks in
 * ordinary text, and every wrapped quotation in `operator-deferral`'s live
 * false-positive set crossed exactly ONE. Three leaves headroom over the
 * observed maximum while still refusing to traverse a run of SHORT lines — a
 * bulleted list can fit six or more breaks inside the same 200 characters, and
 * that is the shape a length cap alone does not bound.
 */
const MAX_QUOTED_SPAN_NEWLINES = 3;

/**
 * Every line-break encoding, so the budget counts BREAKS rather than `\n`
 * characters. `\r\n` must come first — alternation is ordered, and putting
 * `\r` first would score a CRLF break as two.
 *
 * PR #3705 R1 flagged this line for CRLF. Measured, CRLF was already correct:
 * `\r\n` CONTAINS a `\n`, so a `/\n/g` count scored it as one break exactly
 * like LF, and the budget bit identically on both (2/4/6 breaks → elided /
 * not / not, for either encoding). The finding named the right line for the
 * wrong reason — and one case over there was a real hole: a LONE `\r`, the
 * classic-Mac ending, contains no `\n` at all, so a span broken six times
 * scored ZERO and sailed past a cap of three. Counting breaks closes that and
 * leaves CRLF and LF untouched.
 */
const LINE_BREAK = /\r\n|\r|\n/g;

/** True when a candidate span is within the line-crossing budget above. */
function withinLineBudget(span: string): boolean {
  return (span.match(LINE_BREAK)?.length ?? 0) <= MAX_QUOTED_SPAN_NEWLINES;
}

/**
 * Blank double-quoted prose spans (straight `"..."` and curly “...”),
 * length-bounded so a stray unpaired quote cannot swallow a paragraph. This is
 * the elision class `elideQuotedContexts` misses: all 5 false positives in the
 * 2026-07-08 calibration review window were trigger phrases quoted in double
 * quotes in ordinary prose ("I should have caught", "I made a mistake") while
 * discussing the detector or its calibration data.
 *
 * **A span may cross a line break (mt#5056).** It could not until then, and the
 * asymmetry that created WAS the defect: every consumer matcher joins its words
 * with `\s+`, which crosses a newline, while this pass required the closing
 * quote on the same line. So a quotation long enough to wrap — which a quoted
 * report excerpt normally is — leaked its contents into the residual and the
 * phrase inside it matched as though the author had asserted it. Measured on
 * `operator-deferral`'s live log: 5 of 48 records carried a newline INSIDE the
 * matched phrase, and both of its confirmed quoted-as-data false positives were
 * wrapped quotations, traced to their source transcripts rather than inferred —
 * `"Proceeding with\n  that unless you redirect."` and `"Say the word\n  and
 * I'll write it up as a task"`. Note both are ~40 characters: they were missed
 * for crossing a line, never for being long.
 *
 * Two independent bounds keep this docblock's original promise, because
 * crossing lines is exactly what makes paragraph-swallowing possible: the
 * 200-character cap, unchanged, and {@link MAX_QUOTED_SPAN_NEWLINES}.
 *
 * **The residual risk is a MIS-PAIR, and it is safe in the one direction that
 * matters.** A stray unpaired quote can now pair with a later one across a line
 * and blank text that was never quoted. Both caps bound how far that reaches,
 * and blanking uses a same-length, non-matching filler — so a mis-pair can only
 * ever REMOVE a match, never manufacture one (ADR-024 Rung 1's invariant, as
 * amended by mt#4792). Its cost is recall; the cost of the old behaviour was a
 * false positive on every wrapped quotation.
 *
 * **Not covered, deliberately: an UNTERMINATED quotation** — an opening quote
 * with no close inside the budget. Closing that would mean blanking to
 * end-of-paragraph, which is precisely the swallow the caps exist to prevent.
 * Nothing in the measured corpus needs it: all four of the records examined
 * closed their quotes, and the two that LOOKED unterminated were the
 * calibration log's own 240-character context window cutting them off — the
 * stored context is a derived view, and the source transcript is what settled
 * it.
 *
 * Deliberately NOT covering single quotes: apostrophes ("I'll", "detector's")
 * make single-quote pairing unreliable.
 */
export function elideDoubleQuotedSpans(text: string): string {
  let out = text;
  // Straight double quotes.
  out = out.replace(/"[^"]{1,200}"/g, (m) => (withinLineBudget(m) ? blankSameLength(m) : m));
  // Curly double quotes.
  out = out.replace(/“[^”]{1,200}”/g, (m) => (withinLineBudget(m) ? blankSameLength(m) : m));
  return out;
}

/**
 * Composed elision: code/fence/blockquote contexts first (so quotes inside
 * code don't confuse quote pairing), then double-quoted prose spans.
 */
export function elideQuotedAndCodeContexts(text: string): string {
  return elideDoubleQuotedSpans(elideQuotedContexts(text));
}

// ---------------------------------------------------------------------------
// Whole-turn meta-discussion suppression (moved here by mt#3983)
// ---------------------------------------------------------------------------

/**
 * ⚠️ NOT PORTABLE AS-IS. Read this before applying it to another detector.
 *
 * This lives in the shared module because ADR-024's Rung 1 has two halves —
 * "prose-quoted spans and explicit discussion-framing" — and keeping one of
 * them private to a single detector is what made the family's missing coverage
 * invisible: nothing else could reach it, so nobody noticed nothing did. Being
 * here makes the gap legible. It does NOT make this function the right
 * instrument for the rest of the family, for two reasons:
 *
 * 1. **It is WHOLE-TURN suppression, not span-level elision.** Its caller
 *    returns NO matches for the entire turn. Everything else in this module
 *    blanks a span and lets the rest of the text be scanned.
 * 2. **Its patterns are tuned to ONE detector's subject matter.** Bare
 *    `calibration` and `false positives` sit beside retro-specific headings.
 *    For `retrospective-trigger-scanner` that reasoning holds and its tradeoff
 *    is deliberate (below). It inverts elsewhere: a calibration-review turn is
 *    exactly when an agent makes many real unread-code-symbol claims, so
 *    applying this to `code-mechanism-assertion` would silence it where it is
 *    most likely to be right.
 *
 * The per-detector mechanism question is **mt#3987**. Do not answer it by
 * importing this.
 *
 * ---
 *
 * Meta-discussion context markers (mt#2672): when the assistant turn's
 * SUBJECT is the retrospective-trigger detector or the calibration system
 * itself, trigger-phrase mentions are overwhelmingly quotations of the
 * detector's own patterns — 5 of 8 fires in the 2026-07-08 review window
 * were exactly this shape (62% FP rate), and 0 real positives occurred in
 * such turns.
 *
 * The narrow marker set (this is the "documented, narrow heuristic" from the
 * approved disposition on ask 0147caa5):
 *   - the detector's own name,
 *   - calibration vocabulary (log/data/review),
 *   - "false positive(s)" — the FP-triage register itself.
 *
 * Documented tradeoff: a live failure admission inside a
 * calibration-discussion turn is suppressed (a false negative). Accepted
 * because every such turn in the review window was an FP, a deliberate
 * `/retrospective` invocation is unaffected, and the FP/FN balance is
 * re-measured at the next calibration review (mt#2483 loop).
 */
export const META_CONTEXT_PATTERNS: RegExp[] = [
  /retrospective[- ]trigger/i,
  /\bcalibration\b/i,
  /\bfalse[- ]positives?\b/i,
  /\/calibration-review\b/,
  // mt#3036: retrospective structured-output shape. The `/retrospective`
  // skill's own output format REQUIRES the R-family taxonomy vocabulary
  // (`### Agent error (cognitive)` → "Assumption Error", "I conflated",
  // "I should have caught"), which the scanner would then match on. When
  // the assistant turn IS that output — recognizable by these headings —
  // trigger phrases in it are describing the analyzed failure, not asserting
  // a fresh one. Whole-turn suppression here mirrors the existing
  // meta-discussion tradeoff (a live admission mixed into a retro-output
  // turn is a documented FN; the widened invocation look-back is the
  // primary defense, this pattern set is defense-in-depth).
  //
  // PR #2169 R1 (narrowed): patterns are limited to headings distinctive
  // to `/retrospective`'s Step 2a output. Generic RCA/design-doc headings
  // (`### Root cause`, `### Failure mode:`) were dropped — they appear in
  // ordinary specs, ADRs, and incident memos, and their broad match risks
  // suppressing R-family scanning on unrelated content. The retained set
  // requires the retro-specific `## Retrospective:` header OR one of the
  // taxonomy sub-headings that is essentially a retro-only phrase.
  /^##\s+Retrospective:/m,
  /^###\s+Agent error\s*\(cognitive\)/m,
  /^###\s+Recurrence check\b/m,
  /^###\s+Recurrence-after-DONE\b/m,
  /^\*\*Correction noted\*\*\s*:/m,
];

/** True when the raw turn text is meta-discussion of the detector/calibration system. */
export function isDetectorMetaDiscussion(text: string): boolean {
  return META_CONTEXT_PATTERNS.some((p) => p.test(text));
}
