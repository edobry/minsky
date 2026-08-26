import { describe, test, expect } from "bun:test";
import {
  determineTrustMode,
  formatTrustModeLine,
  compareMetrics,
  anyRegressed,
  DEFAULT_KAPPA_THRESHOLD,
  MIN_TRUSTED_N,
  DEFAULT_REGRESSION_THRESHOLDS,
  TRUST_MODE_CALIBRATED,
  TRUST_MODE_DISTRIBUTION_ONLY,
  type GraduatedMetrics,
  type KappaCalibrationSnapshot,
} from "./reviewer-benchmark-gate";

// ---------------------------------------------------------------------------
// Trust gate — the mt#2991 AT2 "mode flips on the threshold" acceptance
// test, verified entirely with synthetic data (no human labels needed).
// ---------------------------------------------------------------------------

describe("determineTrustMode", () => {
  test("no snapshot at all -> distribution-only (fail-closed, not fail-open)", () => {
    const mode = determineTrustMode(null);
    expect(mode.mode).toBe(TRUST_MODE_DISTRIBUTION_ONLY);
  });

  test("a synthetic gold slice engineered BELOW threshold -> distribution-only", () => {
    const snapshot: KappaCalibrationSnapshot = {
      computedAt: "2026-08-26T00:00:00.000Z",
      kappa: 0.45,
      n: 76,
    };
    const mode = determineTrustMode(snapshot, 0.6);
    expect(mode.mode).toBe(TRUST_MODE_DISTRIBUTION_ONLY);
    if (mode.mode === TRUST_MODE_DISTRIBUTION_ONLY) {
      expect(mode.reason).toContain("0.45");
    }
  });

  test("a synthetic gold slice engineered AT OR ABOVE threshold -> calibrated", () => {
    const snapshot: KappaCalibrationSnapshot = {
      computedAt: "2026-08-26T00:00:00.000Z",
      kappa: 0.72,
      n: 76,
    };
    const mode = determineTrustMode(snapshot, 0.6);
    expect(mode.mode).toBe(TRUST_MODE_CALIBRATED);
    if (mode.mode === TRUST_MODE_CALIBRATED) {
      expect(mode.kappa).toBe(0.72);
    }
  });

  test("mode FLIPS as kappa crosses the threshold, all else equal", () => {
    const below = determineTrustMode({ computedAt: "x", kappa: 0.59, n: 100 }, 0.6);
    const atThreshold = determineTrustMode({ computedAt: "x", kappa: 0.6, n: 100 }, 0.6);
    const above = determineTrustMode({ computedAt: "x", kappa: 0.61, n: 100 }, 0.6);
    expect(below.mode).toBe(TRUST_MODE_DISTRIBUTION_ONLY);
    expect(atThreshold.mode).toBe(TRUST_MODE_CALIBRATED);
    expect(above.mode).toBe(TRUST_MODE_CALIBRATED);
  });

  test("a degenerate (undefined) kappa is never trusted, regardless of threshold", () => {
    const snapshot: KappaCalibrationSnapshot = {
      computedAt: "x",
      kappa: null,
      degenerate: "single-category",
      n: 100,
    };
    const mode = determineTrustMode(snapshot, 0.0);
    expect(mode.mode).toBe(TRUST_MODE_DISTRIBUTION_ONLY);
  });

  test("a high kappa at too-small n is NOT trusted (mt#2991 amendment item 2)", () => {
    const snapshot: KappaCalibrationSnapshot = { computedAt: "x", kappa: 0.95, n: 5 };
    const mode = determineTrustMode(snapshot, 0.6, MIN_TRUSTED_N);
    expect(mode.mode).toBe(TRUST_MODE_DISTRIBUTION_ONLY);
    if (mode.mode === TRUST_MODE_DISTRIBUTION_ONLY) {
      expect(mode.reason).toContain("below the minimum trusted n");
    }
  });

  test("default threshold is 0.6 (Landis-Koch substantial agreement, the spec's proposed default)", () => {
    expect(DEFAULT_KAPPA_THRESHOLD).toBe(0.6);
  });
});

describe("formatTrustModeLine", () => {
  test("calibrated mode names the kappa and n", () => {
    const line = formatTrustModeLine({
      mode: TRUST_MODE_CALIBRATED,
      kappa: 0.72,
      n: 76,
      threshold: 0.6,
    });
    expect(line).toContain("CALIBRATED");
    expect(line).toContain("0.7200");
    expect(line).toContain("76");
  });

  test("distribution-only mode says NOT ground truth and states the reason", () => {
    const line = formatTrustModeLine({
      mode: TRUST_MODE_DISTRIBUTION_ONLY,
      reason: "no calibration snapshot found",
      threshold: 0.6,
    });
    expect(line).toContain("DISTRIBUTION-ONLY");
    expect(line).toContain("NOT GROUND TRUTH");
    expect(line).toContain("no calibration snapshot found");
  });
});

// ---------------------------------------------------------------------------
// Regression gate — mt#2991 AT3, verified with a hand-built regressed
// metrics object (no live model call needed for the logic itself).
// ---------------------------------------------------------------------------

const HEALTHY_BASELINE: GraduatedMetrics = {
  precision: 0.7,
  recall: 0.65,
  f1: 0.674,
  falsePositiveRate: 0.1,
  verdictMcc: 0.5,
};

describe("compareMetrics / anyRegressed", () => {
  test("identical metrics never regress", () => {
    const comparisons = compareMetrics(HEALTHY_BASELINE, HEALTHY_BASELINE);
    expect(anyRegressed(comparisons)).toBe(false);
    for (const c of comparisons) expect(c.delta).toBe(0);
  });

  test("a small, noise-sized delta does not trip the default (coarse) threshold", () => {
    const current: GraduatedMetrics = {
      ...HEALTHY_BASELINE,
      recall: HEALTHY_BASELINE.recall - 0.05,
    };
    const comparisons = compareMetrics(HEALTHY_BASELINE, current);
    expect(anyRegressed(comparisons)).toBe(false);
  });

  test("a deliberately removed prompt principle (AT3): a large recall collapse trips the gate", () => {
    // Simulates the mt#1471/mt#2722 emission-reliability regression scenario:
    // a prompt principle removed -> the model stops emitting many findings
    // it used to catch -> recall collapses.
    const regressed: GraduatedMetrics = {
      ...HEALTHY_BASELINE,
      recall: 0.2, // 0.65 -> 0.2 is a 45-point collapse, well past the floor
      f1: 0.3,
    };
    const comparisons = compareMetrics(HEALTHY_BASELINE, regressed);
    expect(anyRegressed(comparisons)).toBe(true);
    const recallComparison = comparisons.find((c) => c.metric === "recall");
    expect(recallComparison?.regressed).toBe(true);
    expect(recallComparison?.delta).toBeCloseTo(0.45, 5);
  });

  test("falsePositiveRate regresses in the OPPOSITE direction (higher is worse)", () => {
    const regressed: GraduatedMetrics = { ...HEALTHY_BASELINE, falsePositiveRate: 0.6 };
    const comparisons = compareMetrics(HEALTHY_BASELINE, regressed);
    const fprComparison = comparisons.find((c) => c.metric === "falsePositiveRate");
    expect(fprComparison?.regressed).toBe(true);
    expect(fprComparison?.delta).toBeCloseTo(0.5, 5);
  });

  test("an IMPROVEMENT (recall goes up) is never flagged as a regression", () => {
    const improved: GraduatedMetrics = { ...HEALTHY_BASELINE, recall: 0.95 };
    const comparisons = compareMetrics(HEALTHY_BASELINE, improved);
    const recallComparison = comparisons.find((c) => c.metric === "recall");
    expect(recallComparison?.regressed).toBe(false);
    expect(recallComparison?.delta).toBeLessThan(0);
  });

  test("thresholds are configurable and independently applied per metric", () => {
    const current: GraduatedMetrics = { ...HEALTHY_BASELINE, precision: 0.6 };
    const tightThresholds: GraduatedMetrics = { ...DEFAULT_REGRESSION_THRESHOLDS, precision: 0.05 };
    const comparisons = compareMetrics(HEALTHY_BASELINE, current, tightThresholds);
    const precisionComparison = comparisons.find((c) => c.metric === "precision");
    expect(precisionComparison?.regressed).toBe(true);
  });
});
