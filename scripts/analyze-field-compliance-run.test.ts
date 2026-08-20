import { describe, it, expect } from "bun:test";
import {
  fisherExactTwoSided,
  mcnemarExactTwoSided,
  newcombePairedDifferenceCI,
  wilson,
} from "./analyze-field-compliance-run";

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

describe("mcnemarExactTwoSided", () => {
  it("matches the exact binomial sign test — 11 vs 1 discordant", () => {
    // Two-sided exact binomial at p=0.5, n=12, k<=1: 2*(C(12,0)+C(12,1))/2^12
    //   = 2*(1+12)/4096 = 26/4096 = 0.0063477.
    // This is mt#4317's own field-order result, whose p = 0.0063 appears throughout that
    // task's record — so it doubles as a check that this implementation reproduces the
    // number the cluster has been quoting.
    expect(mcnemarExactTwoSided(11, 1)).toBeCloseTo(0.0063477, 6);
  });

  it("matches the exact binomial for 1 vs 2 discordant (mt#4317 run 2)", () => {
    // 2*(C(3,0)+C(3,1))/2^3 = 2*4/8 = 1.0 — the p = 1.0 that retired the field-order fix.
    expect(mcnemarExactTwoSided(1, 2)).toBeCloseTo(1.0, 9);
  });

  it("returns 1 when the discordant counts are equal", () => {
    expect(mcnemarExactTwoSided(10, 10)).toBeCloseTo(1.0, 9);
  });

  it("returns 1 when there are no discordant pairs, rather than dividing by zero", () => {
    expect(mcnemarExactTwoSided(0, 0)).toBe(1);
  });

  it("is symmetric in its two arguments", () => {
    expect(mcnemarExactTwoSided(3, 14)).toBeCloseTo(mcnemarExactTwoSided(14, 3), 12);
  });

  it("detects a total split", () => {
    // 20 vs 0 is 2*(1/2^20) = 1.9e-6.
    expect(mcnemarExactTwoSided(20, 0)).toBeCloseTo(1.9073e-6, 9);
  });

  it("never exceeds 1 near the equal-split boundary", () => {
    // The 2x-tail construction can exceed 1 for near-equal counts if not clamped.
    for (const [b, c] of [
      [5, 5],
      [5, 6],
      [6, 5],
      [50, 50],
    ] as const) {
      expect(mcnemarExactTwoSided(b, c)).toBeLessThanOrEqual(1);
    }
  });

  it("survives the pre-registered discordant-pair count without overflowing", () => {
    const p = mcnemarExactTwoSided(30, 6);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.001);
  });
});

describe("newcombePairedDifferenceCI", () => {
  it("reproduces the hand-computed interval for mt#4365's actual Run 2 table", () => {
    // Cells: bothFail 30, onlyBaseline 1, onlyTool 3, bothOk 66 (n=100).
    // Hand-computed via Newcombe Method 10 with z = 1.95996:
    //   p1 = 0.31, p2 = 0.33, delta = -0.02
    //   Wilson(31,100) = [0.22780, 0.40627]; Wilson(33,100) = [0.24563, 0.42695]
    //   phi = (30*66 - 1*3)/sqrt(31*69*33*67) = 1977/2174.7 = 0.9091
    //   lower = -0.02 - sqrt(0.0822^2 - 2*0.9091*0.0822*0.096946 + 0.096946^2) = -0.0608
    //   upper = -0.02 + sqrt(0.096266^2 - 2*0.9091*0.096266*0.08437 + 0.08437^2) = +0.0202
    const [lo, hi] = newcombePairedDifferenceCI(30, 1, 3, 66);
    expect(lo).toBeCloseTo(-0.0608, 3);
    expect(hi).toBeCloseTo(0.0202, 3);
  });

  it("brackets the observed difference", () => {
    const [lo, hi] = newcombePairedDifferenceCI(30, 1, 3, 66);
    const delta = (1 - 3) / 100;
    expect(lo).toBeLessThan(delta);
    expect(hi).toBeGreaterThan(delta);
  });

  it("is centred on zero when the discordant counts are equal", () => {
    const [lo, hi] = newcombePairedDifferenceCI(20, 5, 5, 70);
    expect(lo).toBeCloseTo(-hi, 9);
  });

  it("reverses sign when the arms are swapped", () => {
    const [lo1, hi1] = newcombePairedDifferenceCI(30, 1, 3, 66);
    const [lo2, hi2] = newcombePairedDifferenceCI(30, 3, 1, 66);
    expect(lo2).toBeCloseTo(-hi1, 6);
    expect(hi2).toBeCloseTo(-lo1, 6);
  });

  it("stays within [-1, 1] on a fully separated table", () => {
    const [lo, hi] = newcombePairedDifferenceCI(0, 50, 0, 50);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("returns a degenerate interval for an empty table rather than NaN", () => {
    expect(newcombePairedDifferenceCI(0, 0, 0, 0)).toEqual([0, 0]);
  });

  it("does not produce NaN when a margin is empty and phi is undefined", () => {
    // 0 margins make the correlation denominator 0; Newcombe's convention takes phi = 0.
    const [lo, hi] = newcombePairedDifferenceCI(0, 0, 0, 40);
    expect(Number.isNaN(lo)).toBe(false);
    expect(Number.isNaN(hi)).toBe(false);
  });

  it("is WIDER than the Wald interval it replaced, at the small discordant count that motivated the change", () => {
    // Wald for this table: sqrt((1+3) - (1-3)^2/100)/100 = sqrt(3.96)/100 = 0.019900,
    // so +/- 1.95996*0.0199 = +/- 0.039, giving [-0.059, +0.019].
    // Newcombe should not be NARROWER — the whole point is that Wald under-covers here.
    const [lo, hi] = newcombePairedDifferenceCI(30, 1, 3, 66);
    const waldHalfWidth = 1.95996 * (Math.sqrt(4 - 4 / 100) / 100);
    expect(hi - lo).toBeGreaterThanOrEqual(2 * waldHalfWidth - 1e-6);
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
