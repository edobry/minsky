/**
 * Severity-downgrade logic — calibration for frequent false positives.
 *
 * When the dismissal rate for a (detectorId, version, evidencePattern) tuple
 * exceeds a threshold (default: 70%), the effective severity is downgraded to
 * "low". The router can then choose to log rather than escalate.
 *
 * Per mt#1035 §Calibration and dismissal §2 Severity downgrade on dismissal rate.
 * Threshold default: 70% per mt#1035 calibration data.
 *
 * Downgrade is scoped to the detector's versioned ruleset: bumping `detectorVersion`
 * resets the baseline so rule revisions don't inherit stale dismissal rates.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Calibration and dismissal
 */

/** Severity levels shared with `DetectionSignal`. */
export type Severity = "low" | "medium" | "high";

/**
 * Pre-computed dismissal statistics for a (detectorId, version, evidencePattern)
 * tuple. Callers may either provide stats directly (preferred for batching) or
 * pass a `AnyDismissalStore` and let `computeEffectiveSeverity` query it.
 */
export interface DismissalStats {
  /** Total number of times this rule has fired. */
  totalFirings: number;
  /** Number of times the operator dismissed the resulting Ask. */
  dismissalCount: number;
}

/**
 * Options for `computeEffectiveSeverity`.
 */
export interface SeverityOptions {
  /**
   * Dismissal rate threshold above which severity is downgraded to "low".
   *
   * Expressed as a fraction in [0, 1]. Default: 0.70 (70%).
   * Per mt#1035 calibration: 70% was the observed false-positive rate for
   * the policy-coverage detector at v0.1.
   */
  threshold?: number;
}

/**
 * Compute the effective severity for a detector firing, after applying the
 * dismissal-rate calibration rule.
 *
 * Rules:
 *   - If `baseSeverity === "low"`, it stays "low" regardless of dismissal rate.
 *   - If `dismissalStats.totalFirings === 0`, base severity is returned as-is
 *     (no data yet; can't downgrade on zero firings).
 *   - If `dismissalCount / totalFirings >= threshold`, downgrade to "low".
 *   - Otherwise, return `baseSeverity` unchanged.
 *
 * The `detectorVersion` parameter is accepted but not used for computation —
 * it is the caller's responsibility to pass stats scoped to the correct version
 * (see `DismissalStatsByVersion` below). Version boundary enforcement is
 * structural: only pass stats for the current version.
 *
 * @param detectorId      — stable detector identifier (e.g. "policy-coverage")
 * @param detectorVersion — ruleset version (e.g. "v1"); stats must be scoped to this
 * @param evidencePattern — normalised evidence pattern key (detector-specific)
 * @param baseSeverity    — severity the detector assigned before calibration
 * @param dismissalStats  — dismissal counts for this (id, version, pattern) tuple
 * @param options         — optional overrides (threshold)
 */
export function computeEffectiveSeverity(
  _detectorId: string,
  _detectorVersion: string,
  _evidencePattern: string,
  baseSeverity: Severity,
  dismissalStats: DismissalStats,
  options: SeverityOptions = {}
): Severity {
  if (baseSeverity === "low") {
    return "low";
  }

  const { totalFirings, dismissalCount } = dismissalStats;

  if (totalFirings === 0) {
    return baseSeverity;
  }

  const threshold = options.threshold ?? DEFAULT_DOWNGRADE_THRESHOLD;
  const dismissalRate = dismissalCount / totalFirings;

  if (dismissalRate >= threshold) {
    return "low";
  }

  return baseSeverity;
}

/**
 * Default dismissal-rate threshold for severity downgrade.
 *
 * 70% per mt#1035 §Calibration and dismissal:
 * "If a detector rule fires with a dismissal rate above a threshold
 *  (proposal: 70%), its severity is automatically downgraded."
 */
export const DEFAULT_DOWNGRADE_THRESHOLD = 0.7;
