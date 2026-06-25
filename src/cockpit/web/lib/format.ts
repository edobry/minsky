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

/** Minimal recency-bearing shape — the fields the changeset recency proxy reads. */
export interface ChangesetRecencyInput {
  lastActivityAt: string | null;
  createdAt: string | null;
}

/**
 * Recency proxy ISO string for changeset ordering + age display (mt#1920 R1/R2).
 *
 * CLIENT mirror of the server's `compareChangesetsByRecency` selection
 * (src/cockpit/session-detail.ts): `lastActivityAt ?? createdAt`. PR-specific
 * timestamps (opened / last-pushed) are not on the session-record path yet
 * (mt#2076 / mt#2435), so `lastActivityAt` is the recency proxy. The page's
 * client-side default sort, its "attention" tie-breaker, and the row "Age"
 * column all derive from this single selection so they match each other AND the
 * server order — keep it in sync with the server comparator.
 */
export function changesetRecencyIso(s: ChangesetRecencyInput): string | null {
  return s.lastActivityAt ?? s.createdAt;
}

/** Epoch ms for {@link changesetRecencyIso}; 0 when absent/unparseable (sorts last). */
export function changesetRecencyTime(s: ChangesetRecencyInput): number {
  const raw = changesetRecencyIso(s);
  if (!raw) return 0;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
