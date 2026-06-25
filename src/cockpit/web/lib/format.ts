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

/**
 * Human-friendly relative time string from a Date or ISO string.
 * Returns "—" for unparseable dates.
 */
export function relativeTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  if (isNaN(diffMs)) return "—";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
