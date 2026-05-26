/**
 * Freshness Classification
 *
 * Pure helper that classifies a chunk's age into a Staleness tier.
 * No I/O — suitable for unit testing without mocks.
 */

import type { Staleness } from "../types";

export interface FreshnessThresholds {
  /** Days after which a chunk is considered "aging" (default 30) */
  agingDays: number;
  /** Days after which a chunk is considered "stale" (default 90) */
  staleDays: number;
}

/** Default staleness thresholds */
export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  agingDays: 30,
  staleDays: 90,
};

/**
 * Classify a chunk's freshness given its last-modified ISO timestamp.
 *
 * @param lastModified - ISO 8601 string (e.g. `"2024-01-15T00:00:00.000Z"`)
 * @param thresholds   - Optional threshold overrides; defaults are applied per field
 * @param now          - Optional reference date for testing; defaults to `new Date()`
 * @returns "fresh" | "aging" | "stale"
 */
export function classifyFreshness(
  lastModified: string,
  thresholds?: Partial<FreshnessThresholds>,
  now?: Date
): Staleness {
  const agingDays = thresholds?.agingDays ?? DEFAULT_FRESHNESS_THRESHOLDS.agingDays;
  const staleDays = thresholds?.staleDays ?? DEFAULT_FRESHNESS_THRESHOLDS.staleDays;

  const referenceDate = now ?? new Date();
  const modifiedDate = new Date(lastModified);
  const ageMs = referenceDate.getTime() - modifiedDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays > staleDays) {
    return "stale";
  }
  if (ageDays > agingDays) {
    return "aging";
  }
  return "fresh";
}
