/**
 * PrWatch entity TypeScript types — PR-state watcher for the operator surface.
 *
 * A PrWatch is a subscription record: the operator registers interest in a
 * specific PR event, the reconciler polls GitHub and fires when the predicate
 * matches, and the watch is either discarded (keep=false) or retained for
 * future firings (keep=true).
 *
 * Reference: parent mt#1234 (operator PR-state watcher); mt#1294 (this task).
 */

/**
 * The three observable PR events this watcher supports.
 *
 * | Event                  | Fires when                                         |
 * |------------------------|----------------------------------------------------|
 * | merged                 | PR merge commit lands                              |
 * | review-posted          | A new review is posted (any state)                 |
 * | check-status-changed   | A required status check flips to a new conclusion  |
 */
export type PrWatchEvent = "merged" | "review-posted" | "check-status-changed";

/**
 * A PR watch subscription record.
 *
 * Identifies a specific PR + event combination. The reconciler polls GitHub,
 * detects the event, writes `triggered_at`, and (if `keep=false`) the record
 * is effectively consumed. With `keep=true` the watch persists and fires again
 * on subsequent matching events.
 */
export interface PrWatch {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** UUID uniquely identifying this watch. */
  id: string;

  // -------------------------------------------------------------------------
  // Target PR
  // -------------------------------------------------------------------------

  /** GitHub repository owner (user or org). */
  prOwner: string;

  /** GitHub repository name. */
  prRepo: string;

  /** Pull request number within the repository. */
  prNumber: number;

  // -------------------------------------------------------------------------
  // Watch specification
  // -------------------------------------------------------------------------

  /** Which PR event to watch for. */
  event: PrWatchEvent;

  /**
   * If false (one-shot), the watch is considered consumed once triggered.
   * If true (persistent), the watch remains active and can fire again.
   */
  keep: boolean;

  /**
   * Operator identity in `{kind}:{scope}:{id}` format.
   *
   * Identifies who registered this watch. Used for notification routing
   * and audit — the reconciler does not interpret this value.
   */
  watcherId: string;

  // -------------------------------------------------------------------------
  // Cursor / state
  // -------------------------------------------------------------------------

  /**
   * Event-specific cursor for deduplication.
   *
   * Shape is event-dependent:
   *   - merged: unused (null)
   *   - review-posted: `{ lastReviewId: number | null }`
   *   - check-status-changed: `{ lastConclusion: "success" | "failure" | "timed_out" | "skipped" | null }`
   *
   * Absent until the first reconciler pass on this watch.
   */
  lastSeen?: Record<string, unknown>;

  // -------------------------------------------------------------------------
  // Timestamps
  // -------------------------------------------------------------------------

  /** ISO-8601 timestamp when this watch was registered. */
  createdAt: string;

  /**
   * ISO-8601 timestamp when the predicate last matched.
   *
   * Absent on active (not-yet-triggered) watches. When `keep=false`,
   * presence of this field means the watch is consumed and should not
   * be processed again.
   */
  triggeredAt?: string;

  // -------------------------------------------------------------------------
  // Extensibility
  // -------------------------------------------------------------------------

  /** Arbitrary metadata for transport adapters and future extensions. */
  metadata: Record<string, unknown>;
}
