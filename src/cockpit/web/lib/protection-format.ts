/**
 * Figure FORMATTING for the operator rendering (mt#4287).
 *
 * Formatting only — no figure is computed here. Every value this module
 * receives was derived by `deriveProtectionSummary` over the aggregates
 * snapshot; mt#3754 SC6 forbids a second DEFINITION of a rendered number, and
 * choosing a unit is not one.
 *
 * `formatMs` in `../hooks/useInterceptorAggregates` tops out at seconds, which
 * is right for a per-interceptor figure on the maintainer surface and wrong
 * here: the operator total is corpus-wide over a multi-day window and lands in
 * minutes or hours. mt#3754 §Context measured `memory-search` alone at ~2.8
 * hours of wall-clock across 2,732 prompts — `formatMs` would render that as
 * "10080s", which is technically true and unreadable.
 */

/**
 * A duration at the scale the operator actually pays it: seconds under a
 * minute, minutes under an hour, hours above.
 *
 * Deliberately coarse above a minute. A figure the operator uses to answer "is
 * this worth it" does not benefit from a third significant digit, and precision
 * it cannot act on reads as false exactness.
 */
export function formatOperatorDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
}

/**
 * A count with its noun, pluralised.
 *
 * Exists so the copy layer never concatenates a bare number against a word and
 * produces "1 checks" — small, but this surface's whole claim is that it reads
 * as prose written for a person rather than as a table of fields.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
