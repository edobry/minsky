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
 * **The filler is separately load-bearing, and it is NOT whitespace (mt#4792).** Same-length
 * gives alignment; a non-`\s`, non-`\w` filler gives the other half — a pattern cannot match
 * ACROSS an elided hole. Filling with spaces manufactured matches — for however long the
 * original `elideMarkdownNonProse` (mt#1707) carried the same filler, which this hoist
 * inherited unchanged. See {@link ELISION_FILL}.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md — the ladder
 * @see mt#4454 — the memory-staleness consumer that forced the hoist
 * @see mt#4386 — the `bare-prohibition` consumer queued behind it
 */

/**
 * The character elided spans are filled with. Deliberately NOT a space.
 *
 * U+00B7 satisfies all three properties the callers need, and whitespace satisfies only two:
 *
 * 1. **One UTF-16 code unit**, so blanking preserves length and every offset into the residual
 *    stays a valid offset into the raw text.
 * 2. **Not `\s`**, so a pattern's own `\s+` cannot span an elided hole and match text that was
 *    never adjacent. This is the property a space lacks — see {@link blankSameLength}.
 * 3. **Not `\w`**, so `\b` boundaries still form at the seams; a pattern anchored hard against
 *    an elided span behaves exactly as it did when the span was there.
 */
export const ELISION_FILL = "·";

/**
 * Replace every non-newline character with {@link ELISION_FILL}, preserving length and line
 * structure.
 *
 * **Why not a space (mt#4792).** Blanking to whitespace lets the CALLER's own `\s+` run straight
 * through the hole, so a clause that does NOT match the raw text matches the residual — the
 * elision MANUFACTURES the false positive it exists to remove. Measured on the shipped
 * implementation before this fix:
 *
 * ```
 * "Retire when `an aside` mt#7777 ships."   // \s+ cannot cross the code span -> no match
 * "Retire when            mt#7777 ships."   // blanked to spaces -> \bretire\s+when\s+(mt#\d+)\b MATCHES
 * ```
 *
 * That defeats Rung 1's own instruction to "match on the residual": the residual has to be
 * ALIGNED with the raw text, not MATCHABLE ACROSS the parts that were removed. Same-length is
 * what the ADR is reaching for; whitespace was incidental to the pass it named.
 *
 * Note the hazard is intrinsic to same-length blanking rather than to any one author — it was
 * hit independently twice on 2026-08-30, here and in `scripts/rederive-memory-associations.ts`.
 * If you are tempted to "simplify" this back to a space, the property test in the sibling spec
 * file (`a pattern that does not match the raw text must not match the residual`) is the one
 * that will fail.
 */
export const blankSameLength = (match: string): string => match.replace(/[^\n]/g, ELISION_FILL);

/**
 * Replace markdown contexts that carry textual references (not coordination
 * instructions) with a same-length non-matching filler. Preserves character positions so
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
 * Blank PROSE-QUOTED spans with a same-length non-matching filler.
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
