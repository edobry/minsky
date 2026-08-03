/**
 * Guard-threshold tuning — pure logic module (mt#3577, ADR-032).
 *
 * Decides whether a guard's threshold should move, given a corpus of
 * observations about that guard's fires. ALL functions here are pure (no fs,
 * no DB, no network, no clock beyond an injected `now`) — mirroring the split
 * `calibration-sweep.ts` and `rationalization-review.ts` already established
 * (pure logic module + separate I/O adapter). This module is the DECIDER; it
 * has no actuator and writes nothing.
 *
 * The ownership classes it enforces are defined in `.minsky/hooks/registry.ts`
 * (`GuardRegistration.tuningOwnership`, mt#3518, mem#802). `.minsky/hooks/` is
 * dependency-free by `SPEC.md` invariant and `src/` does not cross-import it in
 * either direction, so {@link TuningOwnership} and
 * {@link PREFERENCE_OVERRIDE_MAX_MULTIPLE} below are structural duplicates of
 * the registry/`types.ts` originals — the same duplication-over-cross-import
 * precedent `rationalization-review.ts`'s `RawFireRecord` follows.
 *
 * Nothing currently DETECTS divergence between a duplicate and its original,
 * here or in any of the three older instances (PR #2554 R1). That gap is
 * general rather than specific to this module, so it is tracked repo-wide at
 * **mt#3586** rather than patched locally: the obvious local fix — a test
 * reading the hooks source as text — violates `custom/no-real-fs-in-tests` and
 * would still leave every future duplicate uncovered.
 *
 * @see docs/architecture/adr-032-guard-threshold-tuning-loop.md — the decision this implements
 * @see .minsky/hooks/registry.ts — `tuningOwnership`, the class definitions
 * @see .minsky/hooks/types.ts — `readPositiveIntEnv`, the consumption side of a tuned value
 * @see src/domain/calibration/rationalization-review.ts — sibling pure module; `OVERRIDE_RATE_BUDGET`
 */

import { OVERRIDE_RATE_BUDGET } from "./rationalization-review";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** Structural duplicate of `GuardRegistration.tuningOwnership` (see module doc). */
export type TuningOwnership = "invariant" | "preference" | "advisory";

/**
 * What the operator did after a guard fired.
 *
 * `"unknown"` is the HONEST default and, as of ADR-032, the ONLY value any
 * shipped emitter produces: nothing in the corpus records whether a warning
 * changed behavior. It is a distinct value rather than an absence so that a
 * corpus of entirely-unlabeled observations is representable, and so
 * {@link proposeThresholdAdjustment} returns `no-change` over it for a stated
 * reason instead of silently treating unlabeled fires as dismissals. The
 * emitter that produces `heeded`/`dismissed` is the first child task ADR-032
 * files; until it ships, this module is correct and inert.
 */
export type ObservationResponse = "heeded" | "dismissed" | "unknown";

/** One fire of one guard, carrying the value its threshold was compared against. */
export interface ThresholdObservation {
  /** ISO-8601. Used for epoch filtering only — this module never reads a clock. */
  timestamp: string;
  /**
   * The decision INPUT the guard measured — the turn's word count, the gap in
   * minutes, the tool-call count. NOT the guard's decision. A calibration log
   * that retains only a hash of the text (the mt#3576 defect) cannot supply
   * this, which is why that task gates the wall-of-text half of the loop.
   */
  observedValue: number;
  response: ObservationResponse;
}

/**
 * Which way a threshold moves to make a guard fire LESS.
 *
 * A ceiling guard (`wall-of-text`: fire when words > budget) is silenced by
 * RAISING its threshold; a floor guard (a hypothetical "fire when coverage <
 * N") by LOWERING it. Declared per threshold rather than inferred, because
 * inferring it from the observations is exactly the kind of cleverness that
 * inverts silently when a corpus is unrepresentative.
 */
export type TuningDirection = "raise-to-silence" | "lower-to-silence";

export interface ThresholdTuningInput {
  guardName: string;
  /** The registered `MINSKY_*` env var this threshold is read from. */
  thresholdKey: string;
  tuningOwnership: TuningOwnership;
  /** The vendor default compiled into the guard — the bound is computed from THIS, not from `currentValue`. */
  shippedDefault: number;
  /** The value in force locally; defaults to `shippedDefault`. */
  currentValue?: number;
  direction: TuningDirection;
  observations: ThresholdObservation[];
}

// ---------------------------------------------------------------------------
// Bounds and floors (grounded, not round numbers — CLAUDE.md §Thresholds)
// ---------------------------------------------------------------------------

/**
 * Structural duplicate of `PREFERENCE_OVERRIDE_MAX_MULTIPLE` in
 * `.minsky/hooks/types.ts` (mt#3518, PR #2526 R1). A local override is a TUNE,
 * not an off switch; 10x the SHIPPED default is the ceiling already enforced on
 * the human-set env var, and an auto-proposal must not be able to reach past
 * what a human is allowed to type.
 *
 * Deliberately the same number rather than a stricter one: two different
 * ceilings on the same value would make "why did it stop there" depend on
 * which path set it.
 */
export const PREFERENCE_OVERRIDE_MAX_MULTIPLE = 10;

/**
 * Records written before this instant carry unreliable turn attribution and are
 * discarded from any tuning basis.
 *
 * mt#3280 (DONE 2026-07-29, commit `4b88d928c`) found that
 * `extractLastAssistantTurn` could hand a `UserPromptSubmit` detector the
 * PREVIOUS turn — so a pre-fix calibration record's `observedValue` may have
 * been measured against text that is not the text the guard fired on. Tuning a
 * threshold against mis-attributed measurements moves it to fit the wrong
 * corpus. This is a data-provenance boundary, not a retention policy: older
 * records stay on disk and remain readable by the review panel, which reads
 * counts rather than measured values.
 */
export const ATTRIBUTION_EPOCH_ISO = "2026-07-29T00:00:00.000Z";

/**
 * Minimum labeled observations before a threshold may move.
 *
 * Grounded on the evaluation-loop RFC's own Phase-1 GATE floor — "at least two
 * guards show >= 5 fires" (`docs/architecture/evaluation-loop-fire-log.md`
 * §Phase-1 GATE result) — which is this corpus's existing precedent for "enough
 * fires to say anything about a guard at all." A percentile over fewer than
 * five values is a single observation wearing a statistic's clothes.
 */
export const MIN_LABELED_OBSERVATIONS = 5;

/**
 * Percentile of dismissed observations the proposal targets.
 *
 * Intended to be less than the max: one anomalous fire should not set the
 * threshold for every subsequent turn. p90 silences the bulk of the dismissed
 * corpus while leaving the extreme tail still firing, which is the conservative
 * direction — a guard that still fires occasionally is recoverable; one tuned
 * into permanent silence looks identical to one that is broken (the
 * dead-detector class `coverage-receipt.ts` exists to catch).
 *
 * **Where that separation actually holds (PR #2554 R1).** {@link percentile} is
 * nearest-rank, so for a dismissed corpus of 10 or fewer the p90 IS the maximum
 * — at N=6, `ceil(0.9 * 6) - 1` indexes the last element. Since
 * {@link MIN_LABELED_OBSERVATIONS} is 5, the common early case gets max
 * behavior, and the outlier-resistance above is a property of the mature corpus
 * (N >= 11), not a guarantee at cold start. That is stated rather than fixed:
 * at N=6 no percentile method can meaningfully exclude the extreme without
 * discarding most of the sample, and the other bounds — the 10x ceiling and the
 * heeded clamp — are what actually contain a bad early proposal.
 */
export const DISMISSAL_TARGET_PERCENTILE = 90;

// ---------------------------------------------------------------------------
// Decision shapes
// ---------------------------------------------------------------------------

export interface ThresholdProposal {
  kind: "proposal";
  guardName: string;
  thresholdKey: string;
  currentValue: number;
  proposedValue: number;
  /** Sample sizes behind the proposal, so a reader can weigh it without re-deriving. */
  basis: {
    labeledCount: number;
    dismissedCount: number;
    dismissedRate: number;
    /** True when the bound, not the corpus, decided the value. */
    clampedToBound: boolean;
    /** True when a heeded observation held the move back from the corpus-implied value. */
    clampedByHeeded: boolean;
  };
  /**
   * `preference`-class moves are surfaced to the operator as a plain-language
   * consent question before taking effect; `advisory`-class moves apply
   * locally without one (mem#802's per-class decision surfaces).
   */
  requiresConsent: boolean;
}

export interface ThresholdNoChange {
  kind: "no-change";
  guardName: string;
  thresholdKey: string;
  /** Named reasons, never a score — the same transparency posture as `classifyDisposition`. */
  reasons: string[];
}

export type ThresholdTuningDecision = ThresholdProposal | ThresholdNoChange;

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over a sorted-ascending array. Empty input -> null. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] ?? null;
}

/**
 * The bound, already normalized to the positive-integer contract below.
 *
 * The lower bound in particular needs it: `shippedDefault / 10` is fractional
 * for most defaults (a shipped 5 gives 0.5), and both halves of that value —
 * non-integer AND below 1 — are values {@link readPositiveIntEnv}'s consumer
 * silently rejects.
 */
function boundFor(shippedDefault: number, direction: TuningDirection): number {
  return direction === "raise-to-silence"
    ? Math.floor(shippedDefault * PREFERENCE_OVERRIDE_MAX_MULTIPLE)
    : Math.max(1, Math.ceil(shippedDefault / PREFERENCE_OVERRIDE_MAX_MULTIPLE));
}

/**
 * Round a candidate onto the positive-integer contract the consumer enforces
 * (PR #2554 R1).
 *
 * `readPositiveIntEnv` (`.minsky/hooks/types.ts`) returns the SHIPPED DEFAULT
 * for any value that is not an integer or is not positive. A fractional
 * proposal is therefore not a slightly-imprecise tune — it is a silent no-op
 * that looks like a successful one, which is the exact failure shape this whole
 * ADR exists to avoid. Observed values are genuinely fractional in production
 * (`silent-stretch`'s `gapMinutes` records values like `8.43`), so this is
 * reachable, not theoretical.
 *
 * Rounding goes toward LESS silencing in both directions — down for a ceiling
 * guard, up for a floor guard — matching the p90-not-max posture: a guard that
 * still fires occasionally is recoverable, one tuned into permanent silence is
 * indistinguishable from a dead one. That direction also means rounding can
 * never violate the heeded clamp or step outside the bound, so it is safe to
 * apply last.
 */
function toPositiveInt(value: number, direction: TuningDirection): number {
  const rounded = direction === "raise-to-silence" ? Math.floor(value) : Math.ceil(value);
  return Math.max(1, rounded);
}

/**
 * Decide whether one guard's threshold should move, given its observations.
 *
 * The ownership class is checked FIRST and independently of the corpus: an
 * `invariant` guard returns `no-change` no matter what the observations say,
 * which is the property mem#802 requires ("never auto-relaxed by local
 * dismissal behavior") and the one this module's tests pin directly.
 */
export function proposeThresholdAdjustment(input: ThresholdTuningInput): ThresholdTuningDecision {
  const { guardName, thresholdKey, tuningOwnership, shippedDefault, direction } = input;
  const currentValue = input.currentValue ?? shippedDefault;
  const noChange = (...reasons: string[]): ThresholdNoChange => ({
    kind: "no-change",
    guardName,
    thresholdKey,
    reasons,
  });

  if (tuningOwnership === "invariant") {
    return noChange("invariant-class-is-vendor-fixed");
  }

  const epoch = Date.parse(ATTRIBUTION_EPOCH_ISO);
  const attributable = input.observations.filter((o) => {
    const t = Date.parse(o.timestamp);
    return Number.isFinite(t) && t >= epoch;
  });
  const discardedForAttribution = input.observations.length - attributable.length;

  const labeled = attributable.filter((o) => o.response !== "unknown");
  if (labeled.length < MIN_LABELED_OBSERVATIONS) {
    const reasons = [
      `insufficient-labeled-observations (${labeled.length} < ${MIN_LABELED_OBSERVATIONS})`,
    ];
    if (discardedForAttribution > 0) {
      reasons.push(`discarded-pre-attribution-epoch (${discardedForAttribution})`);
    }
    return noChange(...reasons);
  }

  const dismissed = labeled.filter((o) => o.response === "dismissed");
  const dismissedRate = dismissed.length / labeled.length;
  if (dismissedRate <= OVERRIDE_RATE_BUDGET) {
    return noChange(
      `dismissal-rate-within-budget (${dismissedRate.toFixed(2)} <= ${OVERRIDE_RATE_BUDGET})`
    );
  }

  const values = dismissed.map((o) => o.observedValue).sort((a, b) => a - b);
  const target =
    direction === "raise-to-silence"
      ? percentile(values, DISMISSAL_TARGET_PERCENTILE)
      : percentile(values, 100 - DISMISSAL_TARGET_PERCENTILE);
  if (target === null) return noChange("no-dismissed-observations");

  const bound = boundFor(shippedDefault, direction);
  const heededValues = labeled.filter((o) => o.response === "heeded").map((o) => o.observedValue);

  let proposed: number;
  let clampedToBound = false;
  let clampedByHeeded = false;

  if (direction === "raise-to-silence") {
    proposed = target;
    if (proposed > bound) {
      proposed = bound;
      clampedToBound = true;
    }
    // Never move past a fire the operator acted on: silencing a heeded fire is
    // a regression in the guard's job, not a tune.
    const lowestHeeded = heededValues.length > 0 ? Math.min(...heededValues) : null;
    if (lowestHeeded !== null && proposed >= lowestHeeded) {
      proposed = lowestHeeded;
      clampedByHeeded = true;
    }
    proposed = toPositiveInt(proposed, direction);
    // Rounding lands ON the heeded value when that value is already an integer;
    // step strictly below it. The `< 1` check below catches the case where there
    // is no room left (a heeded fire at 1).
    if (lowestHeeded !== null && proposed >= lowestHeeded) proposed -= 1;
    // The `< 1` half is redundant in practice — for any `currentValue >= 0` the
    // `<= currentValue` half already catches a zero — and is kept so the
    // positive-integer postcondition is stated where it is established rather
    // than inferred from a fact about the caller's input. It is deliberately
    // NOT covered by an isolating test, because isolating it would require a
    // negative `currentValue`, which no caller can legitimately pass.
    if (proposed < 1 || proposed <= currentValue) {
      return noChange(
        clampedByHeeded ? "heeded-observations-block-the-move" : "corpus-implies-no-move"
      );
    }
  } else {
    proposed = target;
    if (proposed < bound) {
      proposed = bound;
      clampedToBound = true;
    }
    const highestHeeded = heededValues.length > 0 ? Math.max(...heededValues) : null;
    if (highestHeeded !== null && proposed <= highestHeeded) {
      proposed = highestHeeded;
      clampedByHeeded = true;
    }
    proposed = toPositiveInt(proposed, direction);
    if (highestHeeded !== null && proposed <= highestHeeded) proposed += 1;
    if (proposed >= currentValue) {
      return noChange(
        clampedByHeeded ? "heeded-observations-block-the-move" : "corpus-implies-no-move"
      );
    }
  }

  return {
    kind: "proposal",
    guardName,
    thresholdKey,
    currentValue,
    proposedValue: proposed,
    basis: {
      labeledCount: labeled.length,
      dismissedCount: dismissed.length,
      dismissedRate,
      clampedToBound,
      clampedByHeeded,
    },
    requiresConsent: tuningOwnership === "preference",
  };
}
