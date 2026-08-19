/**
 * Process-local cache for assembled conversation snapshots (mt#4258).
 *
 * `GET /api/cockpit/context-inspector/snapshot` costs ~874ms of pure assembly
 * for a 1,593-turn conversation (measured 2026-08-18 via this route's own
 * `Server-Timing` header: `db;dur=0.02, assemble;dur=874.47`). Essentially all
 * of it is pulling the whole `agent_transcripts.transcript` jsonb — 7.5 MB —
 * out of a REMOTE database. Reopening the same conversation paid that again in
 * full: there was no server-side cache and no cache validator, so a repeat
 * request measured exactly as slow as the first.
 *
 * A transcript is append-only and, once a conversation ends, immutable — so the
 * assembled snapshot is cacheable. What it is NOT is cacheable on a TTL guess:
 * a live conversation gains turns continuously, and serving a stale snapshot to
 * the conversation view would silently drop turns. So this cache is keyed on a
 * VERSION TOKEN derived from the row itself (see `readSnapshotVersion` in
 * `routes/context-inspector.ts`), not on elapsed time. A cheap probe reads the
 * token; a token match serves memory, a mismatch re-assembles.
 *
 * ## Why bounded, and why this small
 *
 * A cached snapshot is the ~6 MB object the endpoint would otherwise serialize.
 * An unbounded map of them is a memory leak with a friendly name: a daemon left
 * open while its operator browses the conversation list would retain every
 * conversation visited, forever. The bound is an entry count with LRU eviction
 * rather than a byte budget, because the thing being bounded is well-correlated
 * with block count and a byte budget would need a size estimator that is itself
 * a guess.
 *
 * `DEFAULT_MAX_ENTRIES` is 6 rather than something larger because the value this
 * cache actually delivers is on TAB SWITCHES and re-opens of the handful of
 * conversations in front of the operator right now — the SPA's own TanStack
 * cache already covers repeat reads within one page view. Six covers that
 * working set; a larger number buys progressively less while holding more
 * multi-megabyte objects resident.
 */

import type { SessionContextSnapshot } from "@minsky/domain/context/types";

/** Entries retained before LRU eviction begins. See the module docblock. */
export const DEFAULT_MAX_ENTRIES = 6;

interface CacheEntry {
  /** The version token this snapshot was assembled under. */
  readonly token: string;
  readonly snapshot: SessionContextSnapshot;
}

/**
 * Bounded LRU keyed by conversation id, validated by version token.
 *
 * Recency is tracked by `Map` insertion order — a `Map` iterates in insertion
 * order, so re-inserting on read moves an entry to the back and the eviction
 * victim is always the first key. This avoids a parallel recency structure that
 * could drift out of sync with the entry map.
 */
export class SnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    // A non-positive bound would make `set` evict what it just stored on every
    // call — a cache that is always empty but still pays the probe. Treat it as
    // a programming error rather than degrading silently.
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `SnapshotCache maxEntries must be a positive integer, got ${maxEntries}`
      );
    }
    this.maxEntries = maxEntries;
  }

  /**
   * The cached snapshot for `key`, but ONLY if it was assembled under `token`.
   *
   * A token mismatch is a miss AND a delete: the stored snapshot is known-stale
   * from this moment on, and keeping it would hold megabytes that can never be
   * served again while occupying a slot a live conversation needs.
   */
  get(key: string, token: string): SessionContextSnapshot | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.token !== token) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-set moves this key to the back of the
    // insertion order, so it is no longer the eviction candidate.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.snapshot;
  }

  /** Store `snapshot` under `key`, evicting the least-recently-used entry if full. */
  set(key: string, token: string, snapshot: SessionContextSnapshot): void {
    // Delete first so an overwrite also refreshes recency rather than leaving
    // the key at its original insertion position.
    this.entries.delete(key);
    this.entries.set(key, { token, snapshot });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Current entry count. Exposed so the bound is assertable from a test. */
  size(): number {
    return this.entries.size;
  }

  /** Drop everything. For tests and for a provider recycle. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Render a version token as an HTTP entity tag.
 *
 * Weak (`W/`) because the token identifies the SOURCE ROW's state, not a
 * byte-exact rendering of the response: two responses carrying the same token
 * are semantically the same snapshot, which is precisely what a weak validator
 * asserts. Quoted because an unquoted etag is not a legal `ETag` value and
 * would be discarded by the client, silently disabling revalidation.
 */
export function snapshotEtag(token: string): string {
  return `W/"${token}"`;
}

/** Strip a `W/` weakness prefix, leaving the opaque-tag (quotes included). */
function opaqueTag(raw: string): string {
  return raw.trim().replace(/^W\//, "");
}

/**
 * Whether an `If-None-Match` request header satisfies `etag` (PR #3104 R2).
 *
 * An exact string equality check against the header is NOT sufficient, and the
 * failure is silent in the expensive direction: a client sending a list, or
 * sending `W/"x"` where the server compared against `"x"`, simply does not match
 * — so the route skips its 304 and re-sends the whole multi-megabyte body. The
 * revalidation quietly stops working while everything still looks correct.
 *
 * Implements RFC 9110 §13.1.2 / §8.8.3.2:
 * - `*` matches any current representation.
 * - The header is a COMMA-SEPARATED LIST; any member matching is a match.
 * - Comparison is WEAK: the `W/` prefix is ignored on both sides, and only the
 *   opaque-tags are compared. Weak comparison is what `If-None-Match` specifies,
 *   and it is the right semantics here anyway — this route's validator is a
 *   deliberately weak, encoding-agnostic one.
 */
export function ifNoneMatchSatisfies(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;

  const target = opaqueTag(etag);
  return trimmed.split(",").some((candidate) => opaqueTag(candidate) === target);
}
