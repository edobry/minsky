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
import type { SnapshotStructure } from "@minsky/domain/transcripts/session-context-snapshot";

/** Entries retained before LRU eviction begins. See the module docblock. */
export const DEFAULT_MAX_ENTRIES = 6;

interface CacheEntry<T> {
  /** The version token this value was derived under. */
  readonly token: string;
  readonly value: T;
}

/**
 * Bounded LRU keyed by a string, validated by version token.
 *
 * Recency is tracked by `Map` insertion order — a `Map` iterates in insertion
 * order, so re-inserting on read moves an entry to the back and the eviction
 * victim is always the first key. This avoids a parallel recency structure that
 * could drift out of sync with the entry map.
 *
 * Generic since mt#4263: the windowed path caches a second thing under the same
 * discipline — the DERIVED STRUCTURE of a conversation (its abandoned-branch id
 * set and its tool-name map), which is a pure function of the same version token
 * and is what makes scroll-back cheap. Same validity rule, very different size
 * class, so each gets its own instance and its own bound rather than sharing one.
 */
export class VersionedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
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
   * The cached value for `key`, but ONLY if it was derived under `token`.
   *
   * A token mismatch is a miss AND a delete: the stored value is known-stale
   * from this moment on, and keeping it would hold megabytes that can never be
   * served again while occupying a slot a live conversation needs.
   */
  get(key: string, token: string): T | undefined {
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
    return entry.value;
  }

  /** Store `value` under `key`, evicting the least-recently-used entry if full. */
  set(key: string, token: string, value: T): void {
    // Delete first so an overwrite also refreshes recency rather than leaving
    // the key at its original insertion position.
    this.entries.delete(key);
    this.entries.set(key, { token, value });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Drop `key` if present.
   *
   * Exists for a subclass whose validity has a second condition this class
   * cannot see (`OverviewCache`'s freshness ceiling). `get` above already
   * deletes on a token mismatch, for the reason that applies equally there: an
   * entry that can never be served again must not keep occupying a slot — and,
   * worse, must not keep the recency refresh that `get` just gave it.
   */
  delete(key: string): void {
    this.entries.delete(key);
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

/** Assembled snapshots. Bounded small — each entry is the multi-megabyte response. */
export class SnapshotCache extends VersionedLruCache<SessionContextSnapshot> {}

/**
 * Entries retained by `StructureCache`.
 *
 * An order of magnitude larger than `DEFAULT_MAX_ENTRIES` because the size class
 * is an order of magnitude smaller in the other direction: a structure entry is
 * an id array plus a tool-name map — 714 names and an empty abandoned set on the
 * 2,236-turn conversation measured for mt#4263, against ~8 MB for that same
 * conversation's snapshot. The bound is what makes scroll-back free: paging back
 * through a long conversation must not evict the structure the next page needs.
 */
export const DEFAULT_MAX_STRUCTURE_ENTRIES = 32;

/**
 * Derived conversation structure (mt#4263) — keyed by conversation id, NOT by
 * window, because it describes the whole conversation and is identical for every
 * window over it. That is the whole point: the first page pays for it, every
 * scroll-back page after it does not.
 */
export class StructureCache extends VersionedLruCache<SnapshotStructure> {
  constructor(maxEntries: number = DEFAULT_MAX_STRUCTURE_ENTRIES) {
    super(maxEntries);
  }
}

/** Entries retained by `OverviewCache`. Small payloads, so the working set can be wide. */
export const DEFAULT_MAX_OVERVIEW_ENTRIES = 32;

/**
 * Ceiling on how long an overview entry may be served (mt#4429).
 *
 * Matches `ConversationPage.tsx`'s `staleTime: 30_000` deliberately — see the
 * class docblock for why the ceiling exists at all.
 */
export const OVERVIEW_FRESHNESS_CEILING_MS = 30_000;

interface TimestampedEntry<T> {
  readonly storedAt: number;
  readonly payload: T;
}

/**
 * Cache for `GET /api/conversation/:id/overview` payloads (mt#4429).
 *
 * That route had no server-side cache of any kind and re-ran three round trips
 * against a remote database on every request: measured 2026-08-22 across six
 * calls at 0.588 / 0.813 / 1.598 / 1.876 / 1.969 / 3.557s, phases
 * `transcript;dur=143, turns+workspace;dur=455, enrichment;dur=667`. The SPA's
 * `staleTime: 30_000` is a BROWSER cache, so a fresh page load, a second tab, or
 * a cockpit restart paid full cost every time.
 *
 * ## Why validity is a conjunction, not just a token
 *
 * The siblings above are validated by version token ALONE, and that is correct
 * for them: a snapshot is a pure function of the transcript row, so a matching
 * token means the cached value is exactly what re-assembly would produce.
 *
 * This payload is NOT such a pure function. It carries a `workspace` section
 * built by `buildWorkspaceOverview`, whose commits come from `git log` in a
 * session workdir — that can change with no transcript change at all, so a
 * transcript-derived token would happily serve a commit list that is hours
 * stale. Hence both conditions must hold for a hit:
 *
 * 1. the version token matches (catches everything conversation-derived), AND
 * 2. the entry is younger than `OVERVIEW_FRESHNESS_CEILING_MS` (bounds drift in
 *    the git/PR half, which no transcript token can see).
 *
 * The ceiling is NOT a TTL cache wearing a token: a TTL alone would serve a
 * conversation's stale turn count for up to 30s, which is the failure the token
 * exists to prevent. Each condition covers what the other cannot.
 *
 * `now` is passed in rather than read from the clock so the ceiling is testable
 * without fake timers.
 */
export class OverviewCache<T> {
  private readonly inner: VersionedLruCache<TimestampedEntry<T>>;
  private readonly ceilingMs: number;

  constructor(
    maxEntries: number = DEFAULT_MAX_OVERVIEW_ENTRIES,
    ceilingMs: number = OVERVIEW_FRESHNESS_CEILING_MS
  ) {
    if (!Number.isInteger(ceilingMs) || ceilingMs < 1) {
      throw new RangeError(`OverviewCache ceilingMs must be a positive integer, got ${ceilingMs}`);
    }
    this.inner = new VersionedLruCache<TimestampedEntry<T>>(maxEntries);
    this.ceilingMs = ceilingMs;
  }

  /** The cached payload, but only if BOTH the token matches and it is young enough. */
  get(key: string, token: string, now: number): T | undefined {
    const entry = this.inner.get(key, token);
    if (entry === undefined) return undefined;
    if (now - entry.storedAt >= this.ceilingMs) {
      // DELETE, do not merely withhold (PR #3252 R1 BLOCKING). The lookup above
      // matched the token, and a token match REFRESHES recency — so an expired
      // entry has just been promoted to most-recently-used and is now the LAST
      // thing this cache would evict. Returning `undefined` without deleting
      // therefore does not just leak a slot: it preferentially keeps entries
      // that can never be served over ones that can, and under sustained reads
      // of expired keys the whole cache fills with them. This mirrors what
      // `VersionedLruCache.get` already does on a token mismatch.
      this.inner.delete(key);
      return undefined;
    }
    return entry.payload;
  }

  set(key: string, token: string, value: T, now: number): void {
    this.inner.set(key, token, { storedAt: now, payload: value });
  }

  size(): number {
    return this.inner.size();
  }

  clear(): void {
    this.inner.clear();
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
