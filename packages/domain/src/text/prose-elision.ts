/**
 * ADR-024 Rung 1's quotation/citation-aware prefilter, in one place (mt#4454).
 *
 * The ladder's Rung 1 is TWO halves — *"elide (a) markdown code spans / fenced blocks /
 * blockquote lines … and (b) prose-quoted spans and explicit discussion-framing. Match on the
 * residual."* Both halves already existed when this module was written; what did not exist was a
 * home a DOMAIN module could import them from:
 *
 * - **(a)** lived in `.minsky/hooks/block-out-of-band-merge.ts`. A domain module importing from
 *   the hooks tree inverts the layering — hooks adapt the domain, not the reverse — so a domain
 *   consumer had no way to reuse it. `spec-criterion-claim.ts` worked around this by taking its
 *   elider as an injected PARAMETER, which is correct for a matcher the hook already wraps and
 *   wrong for {@link ../memory/staleness.ts}'s `extractTrackingTaskRefs`, whose three callers
 *   (read path, `memory.create` write path, backfill script) would each have to remember to pass
 *   it — and a caller who forgets silently gets the un-elided behaviour that is the defect.
 * - **(b)** lived in `packages/domain/src/detectors/spec-criterion-claim.ts` — already domain,
 *   but buried in one detector's module.
 *
 * So both are MOVED here rather than copied, and their previous homes re-export them. There is
 * exactly one implementation of each; nothing below is a second copy. ADR-024's Decision clause
 * asks for precisely this — the ladder "built on the shared `packages/domain/src/detectors/`
 * framework so all guidance hooks consume one mechanism instead of divergent regex copies".
 *
 * **Same-length blanking is load-bearing in both halves.** Callers compute matches against the
 * elided string and slice excerpts out of the ORIGINAL by index; a shorter replacement would
 * shift every subsequent offset. Newlines are preserved so line-anchored passes still align —
 * `staleness.ts`'s `hasRetirementAnchor` bounds its window to the containing LINE, and would
 * silently change meaning if elision collapsed one.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md — the ladder
 * @see mt#4454 — the memory-staleness consumer that forced the hoist
 * @see mt#4386 — the `bare-prohibition` consumer queued behind it
 */

/** Replace every non-newline character with a space, preserving length and line structure. */
const blankSameLength = (match: string): string => match.replace(/[^\n]/g, " ");

/**
 * Replace markdown contexts that carry textual references (not coordination
 * instructions) with same-length whitespace. Preserves character positions so
 * `indexOf` results in the returned text remain valid offsets into the original
 * body — excerpts can still be sliced from the original to show real context.
 *
 * CommonMark coverage (PR #1028 R1 BLOCKING #1 / #2 fix):
 *   1. Fenced code blocks — backtick OR tilde fences (3+ markers); opening
 *      line may be indented up to 3 spaces and carry an info string; closing
 *      fence matches the opening marker exactly (same kind, same count) with
 *      tolerance for trailing whitespace and CR before LF.
 *   2. Inline code spans — variable-length backtick runs per CommonMark
 *      (`foo`, ``foo``, ```foo``` …). Closing run must match the opening run
 *      length and not be followed by another backtick.
 *   3. Blockquote lines — up to 3 leading spaces, one-or-more `>` markers
 *      (covers nesting), CRLF-tolerant.
 *
 * The replacement preserves newlines so line-anchored passes after pass 1
 * still align correctly.
 *
 * Known limitation (NON-BLOCKING per PR #1028 R1): CommonMark "lazy
 * continuation" — a blockquote paragraph wrapped onto subsequent lines
 * without a leading `>` marker. The wrapped lines look like prose and will
 * be scanned. This is rare in PR bodies and the false-positive risk is low;
 * documented here so a future regression can be diagnosed quickly.
 *
 * Catches the mt#1701 PR #1021 false-positive class: docs PRs that legitimately
 * reference trigger phrases as field names in code spans, rather than as
 * coordination instructions in bare prose.
 *
 * Moved here from `.minsky/hooks/block-out-of-band-merge.ts` by mt#4454, which re-exports it;
 * the implementation is unchanged.
 */
export function elideMarkdownNonProse(body: string): string {
  // Pass 1: fenced code blocks.
  //   ^ {0,3}        — up to 3 leading spaces (CommonMark indent rule)
  //   (`{3,}|~{3,})  — capture group 1: 3+ backticks OR 3+ tildes
  //   [^\r\n]*       — optional info string on the opening line
  //   \r?\n          — opening newline (CRLF or LF)
  //   [\s\S]*?       — content (non-greedy, includes newlines)
  //   ^ {0,3}\1      — closing fence: 0-3 spaces + same marker run
  //   [ \t]*\r?$     — optional trailing whitespace, CR before LF tolerance
  let cleaned = body.replace(
    /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[ \t]*\r?$/gm,
    blankSameLength
  );

  // Pass 2: inline code spans with variable-length backtick delimiters.
  //   (`+)              — capture run of N backticks
  //   ([^\n]+?)         — content (non-greedy, no newlines)
  //   \1                — closing run of same N backticks
  //   (?!`)             — not followed by another backtick (so we don't eat
  //                       into a longer run that should have been the opener)
  cleaned = cleaned.replace(/(`+)([^\n]+?)\1(?!`)/g, blankSameLength);

  // Pass 3: blockquote lines.
  //   ^ {0,3}    — up to 3 leading spaces
  //   >+         — one or more `>` (covers nested quotes like `>>`)
  //   [^\n]*     — line content
  //   \r?$       — CRLF-tolerant line end
  cleaned = cleaned.replace(/^ {0,3}>+[^\n]*\r?$/gm, blankSameLength);

  return cleaned;
}

/**
 * Blank PROSE-QUOTED spans with same-length whitespace.
 *
 * ADR-024 Rung 1's half (b), and the one it calls *"the load-bearing, harder part"*.
 * {@link elideMarkdownNonProse} covers code spans, fences and blockquote lines and NOT this one,
 * so the two are complements rather than alternatives — a clause a document QUOTES is example
 * text, not an assertion the document is making.
 *
 * Straight and curly DOUBLE quotes only. Single quotes are excluded because an
 * apostrophe (`doesn't`, `agent's`) opens a span that never closes, which would
 * blank the rest of the line. Spans do not cross a newline for the same reason.
 *
 * **What this does NOT do, deliberately:** ADR-024's half (b) is *"prose-quoted spans **and
 * explicit discussion-framing**"*, and only the first is implemented. Discussion-framing is what
 * separates quoting SOMEONE ELSE'S clause from quoting YOUR OWN — see
 * {@link ../memory/staleness.ts}'s note on the measured false-negative cost of that gap.
 *
 * Moved here from `packages/domain/src/detectors/spec-criterion-claim.ts` by mt#4454, which
 * re-exports it; the implementation is unchanged.
 */
export function elideProseQuotedSpans(text: string): string {
  return text.replace(/"[^"\n]*"|“[^”\n]*”/g, blankSameLength);
}

/**
 * ADR-024 Rung 1 in full: markdown non-prose, then prose-quoted spans.
 *
 * Order is not arbitrary — markdown first, so a quote character that only exists INSIDE a code
 * span (`const q = "…"`) is already blanked and cannot open a prose-quote span that swallows
 * real text after the span closes.
 *
 * Both halves blank same-length, so the composition does too: offsets into the result remain
 * valid offsets into the input.
 */
export function elideQuotedAndMarkdown(text: string): string {
  return elideProseQuotedSpans(elideMarkdownNonProse(text));
}
