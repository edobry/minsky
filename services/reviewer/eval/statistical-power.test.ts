import { describe, test, expect } from "bun:test";
import {
  requiredSampleSize,
  detectableEffect,
  buildDetectionFloorTable,
  kappaStandardError,
  requiredNForKappaSE,
  buildKappaSizingTable,
} from "./statistical-power";

describe("requiredSampleSize / detectableEffect — inverse of each other", () => {
  test("requiredSampleSize matches the textbook n ~= 16p(1-p)/d^2 formula", () => {
    // p=0.5, d=0.2 -> 16*0.25/0.04 = 100
    expect(requiredSampleSize(0.2, 0.5)).toBe(100);
  });

  test("detectableEffect is the inverse: n=100 at p=0.5 detects ~0.2", () => {
    expect(detectableEffect(100, 0.5)).toBeCloseTo(0.2, 5);
  });

  test("round-trip: requiredSampleSize(detectableEffect(n)) ~= n", () => {
    const n = 82;
    const d = detectableEffect(n);
    const back = requiredSampleSize(d);
    // Ceiling rounding means this is approximate, not exact.
    expect(back).toBeGreaterThanOrEqual(n - 1);
    expect(back).toBeLessThanOrEqual(n + 1);
  });

  test("rejects out-of-range d and p", () => {
    expect(() => requiredSampleSize(0)).toThrow();
    expect(() => requiredSampleSize(1)).toThrow();
    expect(() => requiredSampleSize(0.1, 0)).toThrow();
    expect(() => requiredSampleSize(0.1, 1)).toThrow();
  });
});

describe("buildDetectionFloorTable — the mt#2991 amendment item 1 reconciliation", () => {
  test("at n=82 (this corpus's actual measured positive count), ~25pp is reachable and ~20pp is not", () => {
    const table = buildDetectionFloorTable(82);
    const row25 = table.find((r) => r.effectPoints === 25);
    const row20 = table.find((r) => r.effectPoints === 20);
    expect(row25?.reachable).toBe(true);
    expect(row20?.reachable).toBe(false);
    // This is the reconciliation: the 12-15pp advisor estimate is NOT
    // reachable at this n, but the ~25pp measured floor (mt#4554) is.
    const row15 = table.find((r) => r.effectPoints === 15);
    expect(row15?.reachable).toBe(false);
  });

  test("a larger n reaches a smaller floor", () => {
    const small = buildDetectionFloorTable(50);
    const large = buildDetectionFloorTable(500);
    const smallReachable = small.filter((r) => r.reachable).map((r) => r.effectPoints);
    const largeReachable = large.filter((r) => r.reachable).map((r) => r.effectPoints);
    expect(Math.min(...largeReachable)).toBeLessThan(Math.min(...smallReachable));
  });
});

describe("kappaStandardError / requiredNForKappaSE", () => {
  test("matches the spec's own anchor: at n~=40, po=0.8/pe=0.5 gives SE close to the cited ~0.15", () => {
    // The spec text: "At n~=40 the standard error on kappa is roughly 0.15".
    // po=0.8, pe=0.5 -> kappa=0.6 (the proposed threshold) is the operating
    // point that anchor was made about.
    const se = kappaStandardError(0.8, 0.5, 40);
    expect(se).toBeGreaterThan(0.1);
    expect(se).toBeLessThan(0.2);
  });

  test("requiredNForKappaSE is the inverse of kappaStandardError", () => {
    const po = 0.8;
    const pe = 0.5;
    const targetSE = 0.1;
    const n = requiredNForKappaSE(targetSE, po, pe);
    const achievedSE = kappaStandardError(po, pe, n);
    expect(achievedSE).toBeLessThanOrEqual(targetSE + 1e-6);
  });

  test("tighter precision needs more rows", () => {
    const loose = requiredNForKappaSE(0.2, 0.8, 0.5);
    const tight = requiredNForKappaSE(0.05, 0.8, 0.5);
    expect(tight).toBeGreaterThan(loose);
  });

  test("rejects invalid inputs", () => {
    expect(() => kappaStandardError(0.5, 0.5, 0)).toThrow();
    expect(() => kappaStandardError(-0.1, 0.5, 10)).toThrow();
    expect(() => kappaStandardError(0.5, 1, 10)).toThrow();
    expect(() => requiredNForKappaSE(0, 0.5, 0.5)).toThrow();
  });
});

describe("buildKappaSizingTable", () => {
  test("produces a monotonically increasing n as target SE tightens", () => {
    const table = buildKappaSizingTable();
    for (let i = 1; i < table.length; i++) {
      const current = table[i];
      const previous = table[i - 1];
      expect(current).toBeDefined();
      expect(previous).toBeDefined();
      expect(current?.requiredN ?? 0).toBeGreaterThanOrEqual(previous?.requiredN ?? 0);
    }
  });

  test("~40 rows (the disagreement-subset size the spec warns against inheriting) sits at a loose SE", () => {
    const table = buildKappaSizingTable();
    const n40Equivalent = requiredNForKappaSE(0.15, 0.8, 0.5);
    const tightestRow = table[table.length - 1];
    expect(tightestRow).toBeDefined();
    // The spec's own anchor: n~=40 gives SE~=0.15. Confirm that's in the
    // loose end of the table, not the tight end -- i.e. 40 rows is not
    // enough to reach the tighter targets in the table.
    expect(n40Equivalent).toBeLessThan(tightestRow?.requiredN ?? 0);
  });
});
