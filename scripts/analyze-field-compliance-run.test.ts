import { describe, it, expect } from "bun:test";
import {
  agreementCells,
  bootstrapKappaCI,
  cohensKappa,
  fisherExactTwoSided,
  mcnemarExactTwoSided,
  holmAdjust,
  newcombePairedDifferenceCI,
  pairedBootstrapMeanDifferenceCI,
  replicateGroups,
  selectPrimaryRows,
  wilson,
  type Row,
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

// ---------------------------------------------------------------------------
// mt#4370 — the window-trade statistics
// ---------------------------------------------------------------------------

/**
 * Same standard as above: an expected value that comes from OUTSIDE the implementation.
 *
 * For the bootstrap that mostly means checking properties a correct percentile interval must
 * have and an incorrect one plausibly would not — reproducibility under a fixed seed, coverage
 * of a known mean, degeneracy on constant input — because the interval has no closed form to
 * compare against. The Holm cases are checkable directly: the procedure is arithmetic with a
 * published definition.
 */
describe("pairedBootstrapMeanDifferenceCI", () => {
  it("is reproducible: the same differences and seed give the same interval twice", () => {
    // The whole pre-registration claim rests on this. An interval that moved between two runs
    // over one data file would mean the analysis was not fixed in advance after all.
    const diffs = [0, -1, 0, 0, 2, -1, 0, 0, 1, 0];
    expect(pairedBootstrapMeanDifferenceCI(diffs)).toEqual(pairedBootstrapMeanDifferenceCI(diffs));
  });

  it("brackets the sample mean of the differences", () => {
    const diffs = [0, -1, 0, 0, 2, -1, 0, 0, 1, 0];
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const [lo, hi] = pairedBootstrapMeanDifferenceCI(diffs);
    expect(lo).toBeLessThanOrEqual(mean);
    expect(hi).toBeGreaterThanOrEqual(mean);
  });

  it("collapses to a point when every difference is identical", () => {
    // Every resample of a constant vector has the same mean, so a correct percentile interval
    // has zero width. A CI that widened here would be reading noise it invented itself.
    const [lo, hi] = pairedBootstrapMeanDifferenceCI([-1, -1, -1, -1, -1, -1]);
    expect(lo).toBeCloseTo(-1, 10);
    expect(hi).toBeCloseTo(-1, 10);
  });

  it("excludes zero when every pair moves the same direction, and admits it when they do not", () => {
    // Not a constant vector — that case is covered above, and a constant would make this
    // pass for the wrong reason. Most pairs lose a finding, a few are unchanged.
    const mostlyDown = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 0 : -1));
    const [dLo, dHi] = pairedBootstrapMeanDifferenceCI(mostlyDown);
    expect(dHi).toBeLessThan(0);
    expect(dLo).toBeLessThan(dHi);

    const mixed = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const [mLo, mHi] = pairedBootstrapMeanDifferenceCI(mixed);
    expect(mLo).toBeLessThan(0);
    expect(mHi).toBeGreaterThan(0);
  });

  it("narrows as n grows, on differences drawn from the same fixed pattern", () => {
    // Width ~ 1/sqrt(n). This is the property that decides whether a null reads as BOUNDED or
    // as UNDERPOWERED, so it is the one that must not be accidentally inverted.
    const pattern = (n: number): number[] =>
      Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 1 : 0));
    const [sLo, sHi] = pairedBootstrapMeanDifferenceCI(pattern(20));
    const [lLo, lHi] = pairedBootstrapMeanDifferenceCI(pattern(200));
    expect(lHi - lLo).toBeLessThan(sHi - sLo);
  });

  it("returns a degenerate interval for an empty sample rather than NaN", () => {
    expect(pairedBootstrapMeanDifferenceCI([])).toEqual([0, 0]);
  });
});

describe("holmAdjust", () => {
  it("matches the worked Holm example: multipliers step down 3, 2, 1", () => {
    // Sorted the input is 0.01, 0.03, 0.04, so the step-down multipliers give 0.03, 0.06, 0.04.
    // The last is SMALLER than the one before it, and Holm pulls it up to the running maximum —
    // the enforcement plain Bonferroni has no need of, and the step this implementation could
    // most plausibly have omitted. Back in input order: 0.01→0.03, 0.04→0.06, 0.03→0.06.
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });

  it("returns adjusted values in the INPUT's order, not sorted order", () => {
    // The caller indexes these against its comparison list. A silently sorted return would
    // attach each p-value to the wrong dose, which no downstream check could catch.
    const [first, second] = holmAdjust([0.5, 0.001]);
    expect(second).toBeLessThan(first as number);
  });

  it("is monotone non-decreasing in the sorted order", () => {
    const adjusted = holmAdjust([0.001, 0.002, 0.003, 0.9])
      .slice()
      .sort((a, b) => a - b);
    for (let i = 1; i < adjusted.length; i++) {
      expect(adjusted[i] as number).toBeGreaterThanOrEqual(adjusted[i - 1] as number);
    }
  });

  it("caps at 1 rather than reporting a probability above 1", () => {
    expect(holmAdjust([0.6, 0.7]).every((p) => p <= 1)).toBe(true);
  });

  it("leaves a single p-value untouched", () => {
    expect(holmAdjust([0.042])).toEqual([0.042]);
  });

  it("is exactly Bonferroni for the SMALLEST p-value, which is where the correction binds", () => {
    expect(holmAdjust([0.01, 0.9])[0]).toBeCloseTo(0.02, 12);
  });
});

/**
 * mt#4409. Same discipline as the block above: every expected value here is worked out from
 * kappa's definition on paper, independently of the implementation, and the arithmetic is
 * written into each test so a reader can check the expectation itself rather than trusting
 * that someone once did.
 *
 * kappa = (po - pe) / (1 - pe), where po is observed agreement and pe is the agreement two
 * raters would reach by chance given their marginal rates.
 */
describe("cohensKappa", () => {
  it("matches a hand-computed table: 20/5/10/15 gives exactly 0.4", () => {
    // n = 50. po = (20+15)/50 = 0.7. First says yes 25/50 = 0.5; second 30/50 = 0.6.
    // pe = 0.5*0.6 + 0.5*0.4 = 0.5.  kappa = (0.7 - 0.5) / (1 - 0.5) = 0.4.
    expect(cohensKappa({ bothYes: 20, onlyFirst: 5, onlySecond: 10, bothNo: 15 })).toBeCloseTo(
      0.4,
      12
    );
  });

  it("matches a second hand-computed table: 45/15/25/15 gives 0.06/0.46", () => {
    // n = 100. po = (45+15)/100 = 0.6. Marginals 0.6 and 0.7.
    // pe = 0.6*0.7 + 0.4*0.3 = 0.54.  kappa = 0.06/0.46 = 0.130434782608...
    expect(cohensKappa({ bothYes: 45, onlyFirst: 15, onlySecond: 25, bothNo: 15 })).toBeCloseTo(
      0.06 / 0.46,
      12
    );
  });

  it("scores mt#4370's disjoint shape slightly BELOW chance, not near-perfect", () => {
    // The shape this whole task exists for: 8 and 22 finding-bearing of 250, zero shared.
    // po = 220/250 = 0.88 — which reads as 88% agreement and means nothing, because at these
    // base rates chance agreement alone is pe = 0.032*0.088 + 0.968*0.912 = 0.885632.
    // kappa = (0.88 - 0.885632) / 0.114368 = -0.0492445...
    const kappa = cohensKappa({ bothYes: 0, onlyFirst: 8, onlySecond: 22, bothNo: 220 });
    expect(kappa).toBeCloseTo(-0.04924, 4);
    expect(kappa as number).toBeLessThan(0);
  });

  it("is 1 on perfect agreement and 0 on independence at a 50% base rate", () => {
    expect(cohensKappa({ bothYes: 10, onlyFirst: 0, onlySecond: 0, bothNo: 10 })).toBeCloseTo(
      1,
      12
    );
    // po = 0.5, marginals 0.5 and 0.5, pe = 0.5 — exactly what two coin flips produce.
    expect(cohensKappa({ bothYes: 25, onlyFirst: 25, onlySecond: 25, bothNo: 25 })).toBeCloseTo(
      0,
      12
    );
  });

  it("returns null when NEITHER call ever says yes, rather than claiming perfect agreement", () => {
    // The realistic degenerate case at a 3% base rate: a sample where nothing was found. po is
    // 1 and pe is 1, so kappa is 0/0. Reporting 1.0 here would claim the detector is perfectly
    // reliable on the strength of a sample containing no findings at all.
    expect(cohensKappa({ bothYes: 0, onlyFirst: 0, onlySecond: 0, bothNo: 50 })).toBeNull();
    expect(cohensKappa({ bothYes: 50, onlyFirst: 0, onlySecond: 0, bothNo: 0 })).toBeNull();
  });

  it("returns null on an empty table instead of dividing by zero", () => {
    expect(cohensKappa({ bothYes: 0, onlyFirst: 0, onlySecond: 0, bothNo: 0 })).toBeNull();
  });
});

describe("agreementCells", () => {
  it("tallies each pair into exactly one cell", () => {
    const cells = agreementCells([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(cells).toEqual({ bothYes: 1, onlyFirst: 1, onlySecond: 1, bothNo: 2 });
  });
});

describe("bootstrapKappaCI", () => {
  const pairs: (readonly [boolean, boolean])[] = [
    ...Array.from({ length: 20 }, () => [true, true] as const),
    ...Array.from({ length: 5 }, () => [true, false] as const),
    ...Array.from({ length: 5 }, () => [false, true] as const),
    ...Array.from({ length: 20 }, () => [false, false] as const),
  ];

  it("is deterministic for a given seed", () => {
    expect(bootstrapKappaCI(pairs, 1234, 500)).toEqual(bootstrapKappaCI(pairs, 1234, 500));
  });

  it("brackets the point estimate it is an interval for", () => {
    const point = cohensKappa(agreementCells(pairs)) as number;
    const ci = bootstrapKappaCI(pairs, 20260822, 2000);
    expect(ci).not.toBeNull();
    expect((ci as { lo: number }).lo).toBeLessThanOrEqual(point);
    expect((ci as { hi: number }).hi).toBeGreaterThanOrEqual(point);
  });

  it("returns null when every resample is degenerate, rather than an interval around nothing", () => {
    const allNegative = Array.from({ length: 30 }, () => [false, false] as const);
    expect(bootstrapKappaCI(allNegative, 7, 200)).toBeNull();
  });

  it("counts degenerate resamples rather than dropping them silently", () => {
    // One finding-bearing pair in 30: many resamples will draw none of it, and the interval
    // must arrive with that count attached so a reader can see how thin it is.
    const sparse: (readonly [boolean, boolean])[] = [
      [true, true],
      ...Array.from({ length: 29 }, () => [false, false] as const),
    ];
    const ci = bootstrapKappaCI(sparse, 99, 500);
    expect(ci).not.toBeNull();
    expect((ci as { degenerateResamples: number }).degenerateResamples).toBeGreaterThan(0);
  });
});

const fixtureRow = (over: Partial<Row> & Pick<Row, "conversationId" | "arm">): Row => ({
  totalMessages: 10,
  analyzedMessages: 10,
  fullWindow: true,
  promptChars: 5000,
  outcome: { kind: "ok", findingCount: 0, summaryChars: 20 },
  ...over,
});

describe("selectPrimaryRows", () => {
  it("keeps first calls and rows predating the field, and drops later copies", () => {
    const rows: Row[] = [
      fixtureRow({ conversationId: "a", arm: "old-run" }),
      fixtureRow({
        conversationId: "b",
        arm: "window-400",
        armBase: "window-400",
        replicateIndex: 1,
      }),
      fixtureRow({
        conversationId: "b",
        arm: "window-400~2",
        armBase: "window-400",
        replicateIndex: 2,
      }),
    ];
    expect(selectPrimaryRows(rows).map((r) => r.arm)).toEqual(["old-run", "window-400"]);
  });
});

describe("replicateGroups", () => {
  const pair = (conversationId: string, findings: [number, number]): Row[] => [
    fixtureRow({
      conversationId,
      arm: "window-400",
      armBase: "window-400",
      replicateIndex: 1,
      outcome: { kind: "ok", findingCount: findings[0], summaryChars: 20 },
    }),
    fixtureRow({
      conversationId,
      arm: "window-400~2",
      armBase: "window-400",
      replicateIndex: 2,
      outcome: { kind: "ok", findingCount: findings[1], summaryChars: 20 },
    }),
  ];

  it("pairs the two calls of one arm by conversation", () => {
    const groups = replicateGroups([...pair("a", [1, 0]), ...pair("b", [0, 2])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.base).toBe("window-400");
    expect(groups[0]?.armNames).toEqual(["window-400", "window-400~2"]);
    expect(groups[0]?.pairs.map((p) => p.conversationId).sort()).toEqual(["a", "b"]);
    expect(groups[0]?.incomplete).toBe(0);
  });

  it("drops a transcript only one call answered, and counts it rather than half-scoring it", () => {
    const rows = [
      ...pair("a", [1, 1]),
      fixtureRow({
        conversationId: "lonely",
        arm: "window-400",
        armBase: "window-400",
        replicateIndex: 1,
      }),
      fixtureRow({
        conversationId: "other",
        arm: "window-400~2",
        armBase: "window-400",
        replicateIndex: 2,
      }),
    ];
    const groups = replicateGroups(rows);
    expect(groups[0]?.pairs).toHaveLength(1);
    expect(groups[0]?.incomplete).toBe(2);
  });

  it("produces no group for a dataset with no replicates", () => {
    expect(replicateGroups([fixtureRow({ conversationId: "a", arm: "baseline" })])).toEqual([]);
  });

  it("keeps two different base arms in separate groups", () => {
    const rows = [
      ...pair("a", [1, 1]),
      fixtureRow({
        conversationId: "a",
        arm: "window-150",
        armBase: "window-150",
        replicateIndex: 1,
      }),
      fixtureRow({
        conversationId: "a",
        arm: "window-150~2",
        armBase: "window-150",
        replicateIndex: 2,
      }),
    ];
    expect(
      replicateGroups(rows)
        .map((g) => g.base)
        .sort()
    ).toEqual(["window-150", "window-400"]);
  });

  it("reports copies beyond the second as unscored instead of ignoring them", () => {
    const rows = [
      ...pair("a", [1, 1]),
      fixtureRow({
        conversationId: "a",
        arm: "window-400~3",
        armBase: "window-400",
        replicateIndex: 3,
      }),
    ];
    expect(replicateGroups(rows)[0]?.unscoredCopies).toEqual(["window-400~3"]);
  });
});
