/**
 * Rationalization review — pure logic module (mt#2901, evaluation-loop
 * RFC Part 3, Notion 392937f0-3cb4-8188-aad6-d7d041de814b).
 *
 * Builds the per-guard, judgment-free panel the RFC specifies from a
 * corpus of already-parsed fire records, and classifies each guard as
 * "auto-affirm" or "outlier" against the RFC's threat-section-constrained
 * threshold. ALL functions here are pure (no fs, no DB, no network) —
 * mirrors `calibration-sweep.ts`'s split (pure logic module + I/O adapter),
 * which is the established precedent this task follows rather than
 * inventing a new shape.
 *
 * `.minsky/hooks/fire-log.ts` (`FireLogEntry`) is NOT imported here. Per
 * `calibration-sweep.ts`'s documented precedent (see its "Fire-log schema
 * adapter" section), `.minsky/hooks/` and `src/`/`packages/domain` do not
 * cross-import in EITHER direction beyond structurally duplicating the
 * shape — `.minsky/hooks/` stays dependency-free (SPEC.md invariant) and
 * `src/` stays free of a coupling to a tree that intentionally skips the
 * root tsconfig. `RawFireRecord` below is that structural duplicate.
 *
 * @see mt#2901 — this task
 * @see mt#2597 / mt#2889 — Phase 1 (fire-log instrumentation, canaries, calibration adapter)
 * @see docs/architecture/evaluation-loop-phase2.md — design writeup (panel columns, auto-affirm
 *      threshold, cadence methodology) this module implements
 * @see .minsky/hooks/fire-log.ts, src/domain/calibration/calibration-sweep.ts — data sources
 * @see decision-defaults.mdc §Thresholds — "ground in observed cadence, not round numbers"
 */

// ---------------------------------------------------------------------------
// Input shapes (structural duplicates of the fire-log / canary / registry shapes)
// ---------------------------------------------------------------------------

export type FireDecision = "allow" | "warn" | "deny";
export type OverrideClassification = "authorized_exception" | "unclassified" | "contested";

/** One fire record, from EITHER the real fire-log or the mt#2889 legacy-calibration adapter. */
export interface RawFireRecord {
  timestamp: string; // ISO-8601
  guardName: string;
  decision: FireDecision;
  /** Real fire-log records carry per-fire cost; adapted legacy-calibration records are always 0. */
  durationMs: number;
  overrideClassification?: OverrideClassification;
  /** Which corpus this record came from — informational, kept for panel transparency. */
  source: "fire-log" | "calibration";
}

export type CanaryStatus = "PASS" | "FAIL" | "MISSING";

export interface CanaryStatusInput {
  guardName: string;
  status: CanaryStatus;
}

export interface AttentionCostInput {
  guardName: string;
  denialMessageSizeChars: number;
  optionCount: number;
}

/**
 * Family-recurrence signal for one guard, sourced from the task-metadata
 * family convention (docs/architecture/evaluation-loop-phase2.md): a
 * structural-fix task tagged `family:<slug>` whose status is DONE, plus a
 * count of fires for this guard AFTER that task's DONE transition.
 * Absent for every guard with no family tag on file yet — "n/a" in the
 * panel per this task's spec, not a zero.
 */
export interface FamilyRecurrenceInput {
  guardName: string;
  familySlug: string;
  fixTaskId: string;
  fixTaskStatus: string;
  /** ISO-8601 timestamp of the fix task's DONE transition (its `updatedAt`), when known. */
  fixTaskDoneAt?: string;
  recurrencesSinceDone: number;
}

// ---------------------------------------------------------------------------
// Thresholds (grounded, not round numbers — CLAUDE.md §Thresholds)
// ---------------------------------------------------------------------------

/**
 * Override-rate budget for auto-affirm eligibility: 20%. Reuses the exact
 * threshold the `/calibration-review` skill's Step 3 already applies
 * ("FP rate is low (rule of thumb: < ~20%): recommend flip") — the two
 * mechanisms (per-log FP-rate review, per-guard override-rate review) are
 * siblings in the same corpus, and a guard whose overrides exceed this
 * budget is, per the RFC's Threats section, explicitly barred from
 * affirm-by-default ("the override-budget rule... affirm-by-default not
 * among the allowed responses").
 */
export const OVERRIDE_RATE_BUDGET = 0.2;

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a sorted-ascending numeric array. Empty input -> null. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] ?? null;
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Compute p50/p95/p99 over a set of per-fire durations. Legacy-calibration
 * records never carried per-fire timing (always `durationMs: 0` — see
 * `calibration-sweep.ts`'s `CalibrationAsFireLogEntry` doc comment), so
 * callers should pass only `source: "fire-log"` durations here to avoid
 * skewing every guard's latency toward zero; a guard with ONLY calibration
 * records (no real fire-log fires yet) legitimately has no latency signal
 * and this returns `null`.
 */
export function computeLatencyPercentiles(durationsMs: number[]): LatencyPercentiles | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  if (p50 === null || p95 === null || p99 === null) return null;
  return { p50, p95, p99 };
}

// ---------------------------------------------------------------------------
// Panel row
// ---------------------------------------------------------------------------

export type Disposition = "auto-affirm" | "outlier";

export interface GuardPanelRow {
  guardName: string;
  fireCount: number;
  overrideCount: number;
  /** 0..1. 0 when fireCount is 0 (no fires to compute a rate over). */
  overrideRate: number;
  overridesByClassification: Record<OverrideClassification, number>;
  /** null when no `source: "fire-log"` records exist for this guard (see computeLatencyPercentiles). */
  latency: LatencyPercentiles | null;
  attentionCost?: { denialMessageSizeChars: number; optionCount: number };
  canaryStatus: CanaryStatus;
  lastFireTimestamp: string | null;
  daysSinceLastFire: number | null;
  /** "n/a" when no family-tagged structural-fix task is on file for this guard yet. */
  recurrencesSinceDone: number | "n/a";
  familySlug?: string;
  disposition: Disposition;
  /** Empty for auto-affirm rows. Named per the trigger that forced "outlier". */
  outlierReasons: string[];
}

// ---------------------------------------------------------------------------
// Per-guard aggregation
// ---------------------------------------------------------------------------

function emptyOverrideBuckets(): Record<OverrideClassification, number> {
  return { authorized_exception: 0, unclassified: 0, contested: 0 };
}

/**
 * Classify one guard's disposition against the RFC's auto-affirm threshold:
 * "low override rate, canary passing, no zero-fire anomaly" — AND (this
 * task's mt#2901 extension) no recorded recurrence-since-done. Any ONE
 * failing condition routes the guard to "outlier"; all conditions named
 * for transparency (a guard is never silently outliered for an
 * unstated reason — the panel is decision-support, not a black box,
 * per the RFC's Goodhart threat: "no composite per-guard score is
 * computed, ever" — this function returns NAMED reasons, never a score).
 */
function classifyDisposition(row: {
  fireCount: number;
  overrideRate: number;
  canaryStatus: CanaryStatus;
  recurrencesSinceDone: number | "n/a";
}): { disposition: Disposition; outlierReasons: string[] } {
  const reasons: string[] = [];
  if (row.fireCount === 0) reasons.push("zero-fire-anomaly");
  if (row.canaryStatus !== "PASS") reasons.push(`canary-${row.canaryStatus.toLowerCase()}`);
  if (row.overrideRate > OVERRIDE_RATE_BUDGET) reasons.push("override-budget-exceeded");
  if (typeof row.recurrencesSinceDone === "number" && row.recurrencesSinceDone > 0) {
    reasons.push("recurrence-since-done");
  }
  return reasons.length === 0
    ? { disposition: "auto-affirm", outlierReasons: [] }
    : { disposition: "outlier", outlierReasons: reasons };
}

export interface BuildPanelOptions {
  records: RawFireRecord[];
  canaryStatuses: CanaryStatusInput[];
  attentionCosts: AttentionCostInput[];
  familyRecurrences: FamilyRecurrenceInput[];
  now?: Date;
}

export interface RationalizationPanel {
  rows: GuardPanelRow[];
  autoAffirmed: GuardPanelRow[];
  outliers: GuardPanelRow[];
  /** ONE summary line for every auto-affirmed guard, per the RFC's "listed in one summary line". */
  autoAffirmSummaryLine: string;
}

/**
 * Build the full per-guard panel from already-parsed inputs. Pure — no I/O.
 * The `scripts/rationalization-review.ts` CLI adapter is the sole caller
 * that supplies real data (fire-log reads, canary-runner results, registry
 * lookups, task-service family queries).
 */
export function buildPanel(options: BuildPanelOptions): RationalizationPanel {
  const now = options.now ?? new Date();
  const canaryByGuard = new Map(options.canaryStatuses.map((c) => [c.guardName, c.status]));
  const attentionByGuard = new Map(options.attentionCosts.map((a) => [a.guardName, a]));
  const familyByGuard = new Map(options.familyRecurrences.map((f) => [f.guardName, f]));

  // Every guard that appears anywhere (a fire, a canary declaration, or an
  // attention-cost annotation) gets a row — a guard with zero real fires
  // but a declared canary must still surface (the zero-fire-anomaly case).
  const guardNames = new Set<string>([
    ...options.records.map((r) => r.guardName),
    ...options.canaryStatuses.map((c) => c.guardName),
    ...options.attentionCosts.map((a) => a.guardName),
  ]);

  const rows: GuardPanelRow[] = [];
  for (const guardName of [...guardNames].sort()) {
    const guardRecords = options.records.filter((r) => r.guardName === guardName);
    const fireCount = guardRecords.length;

    const overridesByClassification = emptyOverrideBuckets();
    let overrideCount = 0;
    for (const r of guardRecords) {
      if (r.overrideClassification) {
        overrideCount++;
        overridesByClassification[r.overrideClassification]++;
      }
    }
    const overrideRate = fireCount === 0 ? 0 : overrideCount / fireCount;

    const realDurations = guardRecords
      .filter((r) => r.source === "fire-log")
      .map((r) => r.durationMs);
    const latency = computeLatencyPercentiles(realDurations);

    let lastFireTimestamp: string | null = null;
    for (const r of guardRecords) {
      if (!lastFireTimestamp || r.timestamp > lastFireTimestamp) lastFireTimestamp = r.timestamp;
    }
    const daysSinceLastFire = lastFireTimestamp
      ? (now.getTime() - new Date(lastFireTimestamp).getTime()) / (1000 * 60 * 60 * 24)
      : null;

    const canaryStatus = canaryByGuard.get(guardName) ?? "MISSING";
    const attentionCost = attentionByGuard.get(guardName);
    const family = familyByGuard.get(guardName);
    const recurrencesSinceDone = family ? family.recurrencesSinceDone : "n/a";

    const { disposition, outlierReasons } = classifyDisposition({
      fireCount,
      overrideRate,
      canaryStatus,
      recurrencesSinceDone,
    });

    rows.push({
      guardName,
      fireCount,
      overrideCount,
      overrideRate,
      overridesByClassification,
      latency,
      attentionCost: attentionCost
        ? {
            denialMessageSizeChars: attentionCost.denialMessageSizeChars,
            optionCount: attentionCost.optionCount,
          }
        : undefined,
      canaryStatus,
      lastFireTimestamp,
      daysSinceLastFire:
        daysSinceLastFire === null ? null : Math.round(daysSinceLastFire * 10) / 10,
      recurrencesSinceDone,
      familySlug: family?.familySlug,
      disposition,
      outlierReasons,
    });
  }

  const autoAffirmed = rows.filter((r) => r.disposition === "auto-affirm");
  const outliers = rows.filter((r) => r.disposition === "outlier");

  const autoAffirmSummaryLine =
    autoAffirmed.length === 0
      ? "Auto-affirmed: none this pass."
      : `Auto-affirmed (${autoAffirmed.length}): ${autoAffirmed.map((r) => r.guardName).join(", ")} — low override rate (<=${OVERRIDE_RATE_BUDGET * 100}%), canary passing, no zero-fire anomaly, no recorded recurrence-since-done.`;

  return { rows, autoAffirmed, outliers, autoAffirmSummaryLine };
}

// ---------------------------------------------------------------------------
// Cadence recommendation
// ---------------------------------------------------------------------------

export interface CadenceRecommendationInput {
  totalFires: number;
  distinctGuardsWithFires: number;
  /** Days spanned by the corpus (earliest to latest timestamp seen). */
  corpusWindowDays: number;
  /** True when a PRIOR review's panel is available and came back all-quiet (no outliers). */
  priorReviewAllQuiet?: boolean;
  /** The cadence (days) the prior review recommended, when one exists. */
  priorRecommendedDays?: number;
}

export interface CadenceRecommendation {
  recommendedDays: number;
  rationale: string;
}

/** RFC Part 3: "Initial cadence quarterly; an all-quiet review doubles the interval; hard maximum twelve months." */
const RFC_INITIAL_CADENCE_DAYS = 90;
const RFC_MAX_CADENCE_DAYS = 365;

/**
 * Compute the cadence recommendation per the RFC's explicit policy
 * (quarterly default, double on an all-quiet review, 12-month hard cap),
 * grounded with the observed fire volume from THIS panel (per
 * decision-defaults.mdc §Thresholds: cite the actual numbers, not a
 * generic default).
 */
export function computeCadenceRecommendation(
  input: CadenceRecommendationInput
): CadenceRecommendation {
  const firesPerDay =
    input.corpusWindowDays > 0 ? input.totalFires / input.corpusWindowDays : input.totalFires;

  if (input.priorReviewAllQuiet && input.priorRecommendedDays) {
    const doubled = Math.min(RFC_MAX_CADENCE_DAYS, input.priorRecommendedDays * 2);
    return {
      recommendedDays: doubled,
      rationale:
        `Prior review was all-quiet at a ${input.priorRecommendedDays}-day cadence; doubling to ` +
        `${doubled} days per the RFC's "an all-quiet review doubles the interval" rule (hard cap ` +
        `${RFC_MAX_CADENCE_DAYS} days).`,
    };
  }

  return {
    recommendedDays: RFC_INITIAL_CADENCE_DAYS,
    rationale:
      `First review: holding the RFC's quarterly (${RFC_INITIAL_CADENCE_DAYS}-day) initial cadence. ` +
      `Observed volume this pass: ${input.totalFires} fires across ${input.distinctGuardsWithFires} ` +
      `guards over a ${input.corpusWindowDays.toFixed(1)}-day corpus window ` +
      `(~${firesPerDay.toFixed(1)} fires/day) — no prior review exists yet to compare an "all-quiet" ` +
      `signal against, so there is no basis to deviate from the RFC default this pass.`,
  };
}
