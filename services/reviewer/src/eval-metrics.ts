/**
 * Pure metric functions for the reviewer benchmark (mt#2726 Milestone A).
 *
 * Every function here takes plain numeric/array inputs and returns numbers
 * (or a flat record of numbers) — no I/O, no external deps, no network.
 * This is what makes them independently unit-testable and reusable from
 * both `paired-eval-runner.ts` (Milestone A, not built in this wave) and
 * any future regression gate (Milestone B, mt#2991).
 */

// ---------------------------------------------------------------------------
// Precision / recall / F1
// ---------------------------------------------------------------------------

/**
 * Precision = tp / (tp + fp).
 *
 * Returns 0 when the denominator is 0 (no positive predictions at all),
 * matching the standard convention of treating an undefined ratio as 0
 * rather than NaN for aggregate reporting purposes.
 */
export function precision(tp: number, fp: number): number {
  const denominator = tp + fp;
  if (denominator === 0) return 0;
  return tp / denominator;
}

/**
 * Recall = tp / (tp + fn).
 *
 * Returns 0 when the denominator is 0 (no actual positives at all).
 */
export function recall(tp: number, fn: number): number {
  const denominator = tp + fn;
  if (denominator === 0) return 0;
  return tp / denominator;
}

/**
 * F1 = 2 * precision * recall / (precision + recall), derived from raw
 * tp/fp/fn counts.
 *
 * Returns 0 when precision + recall is 0 (i.e. both are 0, since neither
 * can be negative).
 */
export function f1(tp: number, fp: number, fn: number): number {
  const p = precision(tp, fp);
  const r = recall(tp, fn);
  const denominator = p + r;
  if (denominator === 0) return 0;
  return (2 * p * r) / denominator;
}

// ---------------------------------------------------------------------------
// Severity-stratified recall
// ---------------------------------------------------------------------------

/** Raw tp/fn counts for one severity bucket (e.g. BLOCKING, NON-BLOCKING). */
export interface SeverityRecallCounts {
  tp: number;
  fn: number;
}

/**
 * Recall computed independently per severity bucket (e.g. BLOCKING vs
 * NON-BLOCKING), so a model's performance on high-stakes findings isn't
 * hidden behind an aggregate recall dominated by the more common bucket.
 *
 * Input: a map of bucket name -> { tp, fn }. Output: a map of the same
 * bucket names -> recall (0 when a bucket's denominator is 0).
 */
export function severityStratifiedRecall(
  countsBySeverity: Record<string, SeverityRecallCounts>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [severity, counts] of Object.entries(countsBySeverity)) {
    result[severity] = recall(counts.tp, counts.fn);
  }
  return result;
}

// ---------------------------------------------------------------------------
// False-positive rate (Bug-Hit / Valid / Noise taxonomy)
// ---------------------------------------------------------------------------

/**
 * Per-finding verdict taxonomy for false-positive-rate measurement:
 * - `BUG_HIT` — the finding correctly identifies a real bug.
 * - `VALID` — the finding is a legitimate (non-bug) observation, e.g. a
 *   style/clarity nit that isn't noise but also isn't a bug hit.
 * - `NOISE` — the finding is spurious (false positive).
 */
export type FindingVerdict = "BUG_HIT" | "VALID" | "NOISE";

/**
 * False-positive rate = count(NOISE) / total verdicts.
 *
 * Returns 0 for an empty input (no findings to rate).
 */
export function falsePositiveRate(verdicts: FindingVerdict[]): number {
  if (verdicts.length === 0) return 0;
  const noiseCount = verdicts.filter((verdict) => verdict === "NOISE").length;
  return noiseCount / verdicts.length;
}

// ---------------------------------------------------------------------------
// Matthews correlation coefficient
// ---------------------------------------------------------------------------

/**
 * Matthews correlation coefficient from a 2x2 confusion matrix (tp, tn,
 * fp, fn). Range [-1, 1]; 1 = perfect agreement, -1 = perfect
 * disagreement, 0 = no better than chance.
 *
 * Returns 0 when any of the four denominator factors — (tp+fp), (tp+fn),
 * (tn+fp), (tn+fn) — is 0, per the standard MCC convention (an undefined
 * correlation is reported as 0 rather than NaN).
 */
export function verdictMcc(tp: number, tn: number, fp: number, fn: number): number {
  const d1 = tp + fp;
  const d2 = tp + fn;
  const d3 = tn + fp;
  const d4 = tn + fn;
  if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) return 0;

  const numerator = tp * tn - fp * fn;
  const denominator = Math.sqrt(d1 * d2 * d3 * d4);
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// pass@k / pass^k
// ---------------------------------------------------------------------------

/**
 * n-choose-r, computed via an iterative multiplicative product (not raw
 * factorials) to avoid precision loss for moderately large n. Returns 0
 * for out-of-range r (r < 0 or r > n) per the standard combinatorial
 * convention used by the pass@k / pass^k estimators below.
 */
function nCr(n: number, r: number): number {
  if (r < 0 || r > n) return 0;
  if (r === 0 || r === n) return 1;
  const rr = Math.min(r, n - r);
  let result = 1;
  for (let i = 0; i < rr; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Shared input validation for the pass@k / pass^k estimators below.
 * Returns true when (n, c, k) are all finite non-negative numbers, c does
 * not exceed n (c out-of-range guard), and k does not exceed n (n<k
 * guard) — false otherwise, signaling the caller to return NaN.
 */
function isValidPassKInput(n: number, c: number, k: number): boolean {
  if (!Number.isFinite(n) || !Number.isFinite(c) || !Number.isFinite(k)) return false;
  if (n < 0 || c < 0 || k < 0) return false;
  if (c > n) return false;
  if (k > n) return false;
  return true;
}

/**
 * pass@k: the standard unbiased estimator for "at least one of k randomly
 * sampled attempts (out of n total attempts, c of which succeeded)
 * succeeds":
 *
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 *
 * Guards: returns NaN when n < k (not enough attempts to sample k from)
 * or when c is out of range (c < 0 or c > n). When n-c < k (fewer
 * failures than k), every k-sample necessarily includes a success, so the
 * result is exactly 1 without needing the general formula.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (!isValidPassKInput(n, c, k)) return NaN;
  if (n - c < k) return 1;
  return 1 - nCr(n - c, k) / nCr(n, k);
}

/**
 * pass^k: the standard unbiased estimator for "all k randomly sampled
 * attempts (out of n total attempts, c of which succeeded) succeed":
 *
 *   pass^k = C(c, k) / C(n, k)
 *
 * Guards: returns NaN when n < k or c is out of range (c < 0 or c > n),
 * matching `passAtK`. When c < k (fewer successes than k), it is
 * impossible for all k sampled attempts to succeed, so the result is
 * exactly 0 without needing the general formula.
 */
export function passCaretK(n: number, c: number, k: number): number {
  if (!isValidPassKInput(n, c, k)) return NaN;
  if (c < k) return 0;
  return nCr(c, k) / nCr(n, k);
}
