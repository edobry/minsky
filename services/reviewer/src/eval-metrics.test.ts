/**
 * Unit tests for the pure metric functions in eval-metrics.ts.
 *
 * Every assertion below is a known-input -> known-output check with the
 * expected value computed by hand (via the documented formula), not by
 * calling the function under test to generate its own expectation.
 */

import { describe, expect, test } from "bun:test";
import {
  f1,
  falsePositiveRate,
  passAtK,
  passCaretK,
  precision,
  recall,
  severityStratifiedRecall,
  verdictMcc,
  type FindingVerdict,
} from "./eval-metrics";

describe("precision", () => {
  test("computes tp / (tp + fp)", () => {
    // 8 / (8 + 2) = 0.8
    expect(precision(8, 2)).toBe(0.8);
  });

  test("returns 1 when there are no false positives", () => {
    expect(precision(5, 0)).toBe(1);
  });

  test("returns 0 for a zero denominator (no predictions at all)", () => {
    expect(precision(0, 0)).toBe(0);
  });

  test("returns 0 when tp is 0 but fp is nonzero", () => {
    expect(precision(0, 5)).toBe(0);
  });
});

describe("recall", () => {
  test("computes tp / (tp + fn)", () => {
    // 8 / (8 + 2) = 0.8
    expect(recall(8, 2)).toBe(0.8);
  });

  test("returns 1 when there are no false negatives", () => {
    expect(recall(5, 0)).toBe(1);
  });

  test("returns 0 for a zero denominator (no actual positives at all)", () => {
    expect(recall(0, 0)).toBe(0);
  });

  test("returns 0 when tp is 0 but fn is nonzero", () => {
    expect(recall(0, 5)).toBe(0);
  });
});

describe("f1", () => {
  test("computes the harmonic mean of precision and recall", () => {
    // tp=6 fp=2 fn=2 -> precision = 6/8 = 0.75, recall = 6/8 = 0.75
    // f1 = 2 * 0.75 * 0.75 / (0.75 + 0.75) = 1.125 / 1.5 = 0.75
    expect(f1(6, 2, 2)).toBeCloseTo(0.75, 10);
  });

  test("computes an asymmetric precision/recall case", () => {
    // tp=1 fp=0 fn=3 -> precision = 1/1 = 1, recall = 1/4 = 0.25
    // f1 = 2 * 1 * 0.25 / (1 + 0.25) = 0.5 / 1.25 = 0.4
    expect(f1(1, 0, 3)).toBeCloseTo(0.4, 10);
  });

  test("returns 0 when both precision and recall are 0 (all-zero counts)", () => {
    expect(f1(0, 0, 0)).toBe(0);
  });

  test("returns 0 when tp is 0 but fp/fn are nonzero", () => {
    // precision = 0/5 = 0, recall = 0/5 = 0 -> denominator 0
    expect(f1(0, 5, 5)).toBe(0);
  });
});

describe("severityStratifiedRecall", () => {
  test("computes recall independently per severity bucket", () => {
    const result = severityStratifiedRecall({
      BLOCKING: { tp: 8, fn: 2 }, // 8/10 = 0.8
      "NON-BLOCKING": { tp: 3, fn: 7 }, // 3/10 = 0.3
    });
    expect(result).toEqual({
      BLOCKING: 0.8,
      "NON-BLOCKING": 0.3,
    });
  });

  test("returns 0 for a bucket with a zero denominator", () => {
    const result = severityStratifiedRecall({
      "PRE-EXISTING": { tp: 0, fn: 0 },
    });
    expect(result).toEqual({ "PRE-EXISTING": 0 });
  });

  test("returns an empty record for empty input", () => {
    expect(severityStratifiedRecall({})).toEqual({});
  });
});

describe("falsePositiveRate", () => {
  test("computes noise count / total verdicts", () => {
    const verdicts: FindingVerdict[] = ["BUG_HIT", "BUG_HIT", "VALID", "NOISE"];
    // 1 NOISE out of 4 total = 0.25
    expect(falsePositiveRate(verdicts)).toBe(0.25);
  });

  test("returns 0 when there is no noise", () => {
    const verdicts: FindingVerdict[] = ["BUG_HIT", "VALID"];
    expect(falsePositiveRate(verdicts)).toBe(0);
  });

  test("returns 1 when every verdict is noise", () => {
    const verdicts: FindingVerdict[] = ["NOISE", "NOISE"];
    expect(falsePositiveRate(verdicts)).toBe(1);
  });

  test("returns 0 for an empty verdict list (zero denominator)", () => {
    expect(falsePositiveRate([])).toBe(0);
  });
});

describe("verdictMcc", () => {
  test("returns 1 for perfect agreement (no fp/fn)", () => {
    // d1=d2=d3=d4=5; numerator = 5*5 - 0*0 = 25; denominator = sqrt(5^4) = 25
    expect(verdictMcc(5, 5, 0, 0)).toBeCloseTo(1, 10);
  });

  test("returns -1 for perfect disagreement (no tp/tn)", () => {
    // d1=d2=d3=d4=5; numerator = 0*0 - 5*5 = -25; denominator = sqrt(5^4) = 25
    expect(verdictMcc(0, 0, 5, 5)).toBeCloseTo(-1, 10);
  });

  test("returns 0 when all four counts are 0 (zero denominator)", () => {
    expect(verdictMcc(0, 0, 0, 0)).toBe(0);
  });

  test("returns 0 when one denominator factor is 0 (tn+fp=0)", () => {
    // tp=5 tn=0 fp=0 fn=0 -> d3 = tn+fp = 0
    expect(verdictMcc(5, 0, 0, 0)).toBe(0);
  });

  test("computes a non-trivial confusion matrix", () => {
    // tp=8 tn=7 fp=2 fn=3
    // d1=tp+fp=10, d2=tp+fn=11, d3=tn+fp=9, d4=tn+fn=10
    // numerator = 8*7 - 2*3 = 56 - 6 = 50
    // denominator = sqrt(10*11*9*10) = sqrt(9900) = 5*sqrt(99) ~= 49.749372 * 2 -> 5/sqrt(99)
    // mcc = 50 / sqrt(9900) = 5 / sqrt(99) ~= 0.5025189
    expect(verdictMcc(8, 7, 2, 3)).toBeCloseTo(0.5025189, 6);
  });
});

describe("passAtK", () => {
  test("computes the unbiased pass@k estimator for a mid-range case", () => {
    // n=5, c=2, k=3 -> n-c=3 (not < k=3), so use the general formula:
    // 1 - C(3,3)/C(5,3) = 1 - 1/10 = 0.9
    expect(passAtK(5, 2, 3)).toBeCloseTo(0.9, 10);
  });

  test("computes a second mid-range case with non-trivial fractions", () => {
    // n=10, c=6, k=3 -> n-c=4 (not < k=3):
    // 1 - C(4,3)/C(10,3) = 1 - 4/120 = 1 - 1/30 = 29/30 ~= 0.9666667
    expect(passAtK(10, 6, 3)).toBeCloseTo(29 / 30, 10);
  });

  test("returns 0 when c=0 (no successes at all)", () => {
    // n=4, c=0, k=2 -> n-c=4 (not < k), C(4,2)/C(4,2) = 1 -> 1 - 1 = 0
    expect(passAtK(4, 0, 2)).toBe(0);
  });

  test("returns 1 when c=n (every attempt succeeded)", () => {
    // n=4, c=4, k=2 -> n-c=0 < k=2, short-circuits to 1
    expect(passAtK(4, 4, 2)).toBe(1);
  });

  test("guards n < k by returning NaN", () => {
    // n=3, k=5 -> k > n, invalid sample size
    expect(Number.isNaN(passAtK(3, 2, 5))).toBe(true);
  });

  test("guards c out of range (c > n) by returning NaN", () => {
    expect(Number.isNaN(passAtK(5, 6, 2))).toBe(true);
  });

  test("guards c out of range (c < 0) by returning NaN", () => {
    expect(Number.isNaN(passAtK(5, -1, 2))).toBe(true);
  });
});

describe("passCaretK", () => {
  test("computes the unbiased pass^k (all-k-succeed) estimator", () => {
    // n=5, c=3, k=2 -> c >= k, C(3,2)/C(5,2) = 3/10 = 0.3
    expect(passCaretK(5, 3, 2)).toBeCloseTo(0.3, 10);
  });

  test("computes a second case with non-trivial fractions", () => {
    // n=10, c=6, k=3 -> c >= k, C(6,3)/C(10,3) = 20/120 = 1/6 ~= 0.1666667
    expect(passCaretK(10, 6, 3)).toBeCloseTo(1 / 6, 10);
  });

  test("returns 0 when c=0 (no successes at all, and c < k)", () => {
    expect(passCaretK(4, 0, 2)).toBe(0);
  });

  test("returns 1 when c=n (every attempt succeeded)", () => {
    // n=4, c=4, k=2 -> c >= k, C(4,2)/C(4,2) = 6/6 = 1
    expect(passCaretK(4, 4, 2)).toBe(1);
  });

  test("guards n < k by returning NaN", () => {
    expect(Number.isNaN(passCaretK(3, 2, 5))).toBe(true);
  });

  test("guards c out of range (c > n) by returning NaN", () => {
    expect(Number.isNaN(passCaretK(5, 6, 2))).toBe(true);
  });

  test("guards c out of range (c < 0) by returning NaN", () => {
    expect(Number.isNaN(passCaretK(5, -1, 2))).toBe(true);
  });
});
