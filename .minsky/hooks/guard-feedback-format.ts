// Shared feedback-formatting bounds for guard advisory text — mt#3705.
//
// WHY THIS EXISTS. `attentionCost.denialMessageSizeChars` is enforced against
// rendered output (`guard-feedback-shape.test.ts`) and the dispatcher's
// `MERGED_CONTEXT_BUDGET_CHARS` is derived from the sum of those annotations. A
// guard that renders one evidence line per matched item therefore cannot be
// annotated honestly unless the line count is bounded — otherwise the number is
// whatever its canary happened to produce, which is a floor, not a ceiling.
//
// mt#3479 made the annotations match their canaries and recorded this residue
// as a known limitation. It went unsized for a while, and the size turned out to
// matter: `guard-health-escalation-detector` declared 600 and rendered 1649 at
// six failing guards.
//
// Several guards had independently grown the same "list every match" shape, so
// the bound lives here rather than as N copies of a `slice` — one place to reason
// about, and a guard adopting it cannot get the overflow wording subtly different.
//
// @see .minsky/hooks/guard-feedback-shape.test.ts — the classification receipt
//      that requires every growth-shaped guard to be capped or declare a
//      worst-case canary
// @see .minsky/rules/guard-feedback-authoring.mdc — the authoring standard
// @see mt#3705 — this task; mt#3479 — the regime it completes

/**
 * Default evidence lines to render before collapsing the rest to a count.
 *
 * Three is the number `turn-end-unwalked-task-scan` arrived at independently
 * (mt#3536) and the one the family has converged on: enough distinct evidence
 * for the agent to recognize which of its own phrases tripped the guard, without
 * turning an advisory into a transcript. A guard with an unusually wide or
 * narrow line may pass its own `max`.
 */
export const DEFAULT_MAX_EVIDENCE_LINES = 3;

/**
 * Truncate to `max` CODE POINTS, appending an ellipsis when anything was cut.
 *
 * Code points, not UTF-16 units: a plain `.slice(0, n)` can cut an astral
 * character in half and emit a lone surrogate. That is not hypothetical for the
 * values this bounds — a guard's interpolated `Error.message` routinely carries
 * emoji from a subprocess's own output. `custom/no-unsafe-string-truncation`
 * flags the plain form and points at `src/utils/safe-truncate.ts`, which this
 * tree cannot import: `.minsky/hooks/**` is dependency-free by invariant
 * (SPEC.md), so hooks keep working when the main codebase has type errors.
 * Hence a local implementation rather than a disable comment.
 *
 * Returns the input unchanged when it already fits, so the common case allocates
 * nothing.
 */
export function truncateToCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max).join("")}…`;
}

/**
 * Render at most `max` evidence lines, followed by a count of what was elided.
 *
 * The overflow line is NOT optional decoration: without it a capped list is
 * indistinguishable from a complete one, so an agent reading three phrases would
 * reasonably believe it had seen everything the guard matched.
 *
 * @param items  the matched items, in the order they should be shown
 * @param render one item -> one line (including its own indentation)
 * @param max    lines to show before collapsing; defaults to DEFAULT_MAX_EVIDENCE_LINES
 */
export function cappedEvidenceLines<T>(
  items: readonly T[],
  render: (item: T) => string,
  max: number = DEFAULT_MAX_EVIDENCE_LINES
): string[] {
  const shown = items.slice(0, max).map(render);
  if (items.length > max) {
    shown.push(`  - …and ${items.length - max} more`);
  }
  return shown;
}
