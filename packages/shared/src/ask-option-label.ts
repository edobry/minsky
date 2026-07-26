/**
 * Browser-safe rules for an Ask option's LABEL — the text that renders on a
 * decision button (mt#3253).
 *
 * Single source of truth for two surfaces with opposite jobs, which is why this
 * lives in `packages/shared` rather than in the domain (the same shape as
 * `ask-approval.ts`, mt#3203, and `ask-closure.ts`, mt#3239 — shared ask
 * vocabulary living somewhere neither side's constraints veto; a value import
 * of `@minsky/domain/*` from `src/cockpit/web/**` is banned outright by
 * `custom/no-node-import-in-cockpit-web`):
 *
 *   - Node side: `packages/domain/src/ask/form-lint.ts` WARNS a producer whose
 *     label breaks these rules, at `asks_create` time.
 *   - Browser side: the cockpit ask surfaces NORMALIZE what is already
 *     persisted — 6185 asks predate the warning, so display-time repair is the
 *     only thing that helps the labels already in the database.
 *
 * ## Measured basis (2026-07-26, the live corpus)
 *
 * 200 options across the 67 asks that populate `options[]`: label length p50
 * 36, p75 48, p90 62, max 167. 23 labels (11.5%) exceed 60 chars and 14 of
 * those leave `description` — the field that exists for exactly this content —
 * empty. 35 labels (17.5%) carry a redundant leading letter marker.
 */

/**
 * Length budget for an option label, in characters.
 *
 * Grounded in the observed distribution rather than a round number (per
 * `decision-defaults §Thresholds`): 60 sits at the corpus p90 (62), so the
 * check fires on the tail — 23 of 200 observed labels — and leaves the typical
 * label (p50 36, p75 48) alone. The tighter alternative, 45 chars (where the
 * `/asks` inbox's `max-w-[22rem]` cap starts truncating), would fire on 63 of
 * 200: too noisy for a warn-only lint whose entire value is that a firing
 * warning means something.
 *
 * The worst observed label is 167 chars — a full paragraph, semicolon-delimited
 * rationale and all, inside a button.
 */
export const OPTION_LABEL_BUDGET = 60;

/**
 * A leading letter marker that duplicates the option letter the SURFACE already
 * renders from the option's position: `[a] `, `A — `, `A - `, `A: `, `a) `,
 * `B. `.
 *
 * Two accepted forms, because producers use both and they need different
 * shapes: a bracketed letter is self-delimiting (`[a] text`), while a bare
 * letter needs a separator to be distinguishable from an ordinary word
 * (`A — text`). The separator class covers hyphen, en/em dash, period, colon,
 * and the closing paren of `a)`.
 *
 * Two guards keep ordinary prose safe, and both are load-bearing:
 *
 *  1. **The bare-letter form requires a separator.** "Adopt fully — vocabulary +
 *     one-pager reframe" starts with a letter and contains an em dash, but
 *     `Adopt` is multi-character so the pattern cannot reach it.
 *  2. **The bare-letter form requires WHITESPACE after that separator** (`\s+`,
 *     not `\s*`). Without it, `.` in the separator class made `"A.B test both
 *     variants"` match and strip to `"B test both variants"` — silent, destructive
 *     text loss on a label that carried no prefix at all (PR #2341 R1, a real
 *     finding). A genuine marker is always followed by a space; a dotted token
 *     like `A.B` or `A.CLI` never is. Same guard incidentally protects `"A -B"`.
 *
 * The bracketed form keeps `\s*` — `[a]` cannot be part of a word, so it needs no
 * trailing space to be unambiguous.
 *
 * Verified against the corpus at both revisions: 35 of 200 labels match, and the
 * whitespace guard loses NONE of them (every genuine marker has its space) while
 * eliminating the `A.B` class.
 */
export const OPTION_LETTER_PREFIX_PATTERN = /^(?:\[[A-Za-z]\]\s*|[A-Za-z]\s*[-—–.):]\s+)/;

/**
 * True when `label` opens with a letter marker the rendering surface would
 * duplicate — e.g. `"B — boundary fix"` shown next to a position-derived "B."
 * reads as "B. B — boundary fix".
 */
export function hasRedundantOptionLetterPrefix(label: string): boolean {
  return stripOptionLetterPrefix(label) !== label;
}

/**
 * `label` with a redundant leading letter marker removed, for surfaces that
 * render the option letter themselves.
 *
 * Returns the input UNCHANGED when stripping would leave nothing: a label that
 * is only a marker (`"[a]"`, `"A."`) carries no other text, and an empty button
 * is worse than a redundant one. Also unchanged when no marker is present, so
 * this is safe to call on every label.
 */
export function stripOptionLetterPrefix(label: string): string {
  const stripped = label.replace(OPTION_LETTER_PREFIX_PATTERN, "");
  return stripped.trim().length === 0 ? label : stripped;
}

/** True when `label` is longer than `OPTION_LABEL_BUDGET`. */
export function isOverOptionLabelBudget(label: string): boolean {
  return label.length > OPTION_LABEL_BUDGET;
}
