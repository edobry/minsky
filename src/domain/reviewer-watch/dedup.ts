/**
 * Local reviewer-bot watcher — alert dedup.
 *
 * Persistent missed-review conditions can show up across many cycles; without
 * dedup the watcher would fire `OperatorNotify` every poll while the same
 * PRs remain unreviewed. Dedup-state is keyed by `${prNumber}@${headSha}` so
 * a new push on the same PR re-fires the alert (the headSha changes), but a
 * static unreviewed PR fires only once per condition-onset.
 *
 * State is in-memory: persists across cycles within one daemon process,
 * resets on restart. That is acceptable for a "best-effort safety net" —
 * a restart-induced re-fire is harmless; the structural problem is silent
 * suppression, not duplicate alerts.
 */

import type { MissingReviewPR } from "./types";

/** A stable key identifying a single missed-review condition. */
export type MissedReviewKey = string;

/** Internal helper: derive a dedup key from a `MissingReviewPR`. */
export function missedReviewKey(pr: MissingReviewPR): MissedReviewKey {
  return `${pr.number}@${pr.headSha}`;
}

/**
 * Tracks which `MissingReviewKey`s have already been alerted. Construct one
 * instance per daemon lifetime; the watcher loop calls `decide()` each cycle.
 */
export class MissedReviewDedupState {
  /** The set of keys alerted on the last firing cycle. */
  private alertedKeys: Set<MissedReviewKey> = new Set();

  /** Snapshot for tests / log output. */
  getAlertedKeys(): MissedReviewKey[] {
    return [...this.alertedKeys];
  }

  /**
   * Decide whether the current cycle's misses should fire an alert.
   *
   * Rules:
   *   1. If `current.length < threshold` → suppress (`"below-threshold"` /
   *      `"none-missing"` if zero).
   *   2. If the set of keys is identical to the last alerted set → suppress
   *      (`"unchanged"`).
   *   3. Otherwise → fire (`"new-condition"`); update internal state to the
   *      new set.
   *
   * Disappearance of a key (review posted, PR closed) is also a state change
   * but does NOT fire — the operator doesn't need to be paged for "the
   * problem went away." We just shrink the alerted-set so future re-onset
   * fires again.
   */
  decide(
    current: MissingReviewPR[],
    threshold: number
  ): { decision: "new-condition" | "unchanged" | "below-threshold" | "none-missing" } {
    if (current.length === 0) {
      // Reset state — any future re-onset is a fresh condition.
      this.alertedKeys = new Set();
      return { decision: "none-missing" };
    }

    if (current.length < threshold) {
      // Below threshold doesn't reset state because the condition persists;
      // a transition above threshold should fire even if the same keys remain.
      return { decision: "below-threshold" };
    }

    const currentKeys = new Set(current.map(missedReviewKey));

    // Check whether `currentKeys` is the same set as `alertedKeys`. Two sets
    // are equal when they have the same size AND every member of one is in
    // the other; checking both directions is unnecessary because size-equality
    // plus subset-equality implies set-equality.
    const sameSet =
      currentKeys.size === this.alertedKeys.size &&
      [...currentKeys].every((k) => this.alertedKeys.has(k));

    if (sameSet) {
      return { decision: "unchanged" };
    }

    this.alertedKeys = currentKeys;
    return { decision: "new-condition" };
  }
}
