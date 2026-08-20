import { describe, it, expect } from "bun:test";
import { fisherExactTwoSided, wilson } from "./analyze-field-compliance-run";

/**
 * mt#4365. These pin a hand-rolled statistic against values computed independently of this
 * implementation, because the alternative is trusting arithmetic that will decide whether a
 * result gets reported as real.
 *
 * That is not hypothetical here: mt#4317 reported a Fisher p = 0.0285 that was wrong — not
 * because the arithmetic was wrong, but because nothing checked what the arithmetic was being
 * fed. A test that only re-ran the same function against the same reasoning would have agreed
 * with it. So every expected value below comes from OUTSIDE this file: a textbook table with a
 * published answer, or a figure computed in a separate language on data this code never saw.
 */
describe("fisherExactTwoSided", () => {
  it("matches Fisher's own tea-tasting table (published p = 0.4857)", () => {
    // The canonical 2x2 from Fisher's exact-test exposition: 3/1 against 1/3.
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857, 4);
  });

  it("matches the mt#4317 transcript-level table computed independently in Python", () => {
    // 5 of 27 above threshold failed; 0 of 13 below did. Computed during mt#4317's planning
    // as p = 0.1540 by a separate implementation, on data predating this file.
    expect(fisherExactTwoSided(5, 22, 0, 13)).toBeCloseTo(0.154, 3);
  });

  it("returns 1.0 when the two groups have identical rates", () => {
    expect(fisherExactTwoSided(5, 5, 5, 5)).toBeCloseTo(1.0, 6);
  });

  it("is symmetric under swapping the two groups", () => {
    expect(fisherExactTwoSided(5, 22, 0, 13)).toBeCloseTo(fisherExactTwoSided(0, 13, 5, 22), 9);
  });

  it("never exceeds 1 on a table where every cell is a boundary case", () => {
    expect(fisherExactTwoSided(0, 10, 0, 10)).toBeLessThanOrEqual(1);
    expect(fisherExactTwoSided(10, 0, 10, 0)).toBeLessThanOrEqual(1);
  });

  it("detects a large, obvious separation", () => {
    // 20/20 vs 0/20 is as separated as a 2x2 gets; p must be far below any threshold.
    expect(fisherExactTwoSided(20, 0, 0, 20)).toBeLessThan(1e-9);
  });

  it("survives a 200-row table without overflowing a factorial", () => {
    // The pre-registered run is n=200. A naive factorial overflows well before this.
    const p = fisherExactTwoSided(20, 80, 5, 95);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe("wilson", () => {
  it("gives a non-degenerate interval at zero successes, where the normal approximation gives none", () => {
    const [lo, hi] = wilson(0, 13);
    expect(lo).toBe(0);
    // Hand-computed from the Wilson closed form at z=1.95996, n=13, p=0:
    //   denom  = 1 + z²/n            = 1.29551
    //   centre = (z²/2n) / denom     = 0.147754 / 1.29551 = 0.114048
    //   half   = z·√(z²/4n²) / denom = 0.147758 / 1.29551 = 0.114055
    //   upper  = centre + half       = 0.228103
    //
    // NOT 0.2475. That is the CLOPPER-PEARSON upper bound for 0/13
    // (1 − 0.025^(1/13) = 0.24705), a different interval method — and it is what this test
    // asserted on its first draft, which failed. Worth leaving in the file: reaching for a
    // published "95% CI for 0/13" gets you whichever method the table used, and the two
    // disagree by two percentage points at exactly the small-cell case this analysis relies on.
    expect(hi).toBeCloseTo(0.2281, 3);
  });

  it("gives a non-degenerate interval at n successes, mirroring the zero case", () => {
    const [lo, hi] = wilson(13, 13);
    expect(hi).toBe(1);
    // Wilson is symmetric under p → 1−p, so this is 1 − 0.228103.
    expect(lo).toBeCloseTo(0.7719, 3);
  });

  it("is symmetric under successes → failures", () => {
    const [lo0, hi0] = wilson(0, 13);
    const [lo13, hi13] = wilson(13, 13);
    expect(lo13).toBeCloseTo(1 - hi0, 9);
    expect(hi13).toBeCloseTo(1 - lo0, 9);
  });

  it("brackets the point estimate", () => {
    const [lo, hi] = wilson(5, 40);
    expect(lo).toBeLessThan(5 / 40);
    expect(hi).toBeGreaterThan(5 / 40);
  });

  it("returns a degenerate interval for an empty sample rather than NaN", () => {
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});
