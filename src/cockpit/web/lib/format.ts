/**
 * Display-formatting helpers for the cockpit web UI.
 */

/**
 * Surrogate-safe head truncation for entity ids (session UUIDs, etc.):
 * returns the first `max` code points followed by an ellipsis, or the id
 * unchanged when it is short enough. Code-point slicing (Array.from) never
 * splits a UTF-16 surrogate pair, per the `no-unsafe-string-truncation`
 * lint discipline (mt#1615).
 */
export function shortenId(id: string, max = 8): string {
  const points = Array.from(id);
  if (points.length <= max) return id;
  return `${points.slice(0, max).join("")}…`;
}
