/**
 * Unit tests for reviewer-benchmark.ts — pure helper functions only.
 *
 * Tests cover: computeMedian, computeMean, computeStats. These do NOT test
 * the Octokit integration paths (those require live credentials and belong to
 * the live verification step).
 *
 * mt#1515 companion to reviewer-benchmark.ts.
 */

import { describe, test, expect } from "bun:test";
import { computeMedian, computeMean, computeStats } from "./reviewer-benchmark";

// ---------------------------------------------------------------------------
// computeMedian
// ---------------------------------------------------------------------------

describe("computeMedian", () => {
  test("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });

  test("returns the single value for a one-element array", () => {
    expect(computeMedian([100])).toBe(100);
  });

  test("returns the middle for odd-length array", () => {
    // [5000, 10000, 15000] sorted → median 10000
    expect(computeMedian([15000, 5000, 10000])).toBe(10000);
  });

  test("returns the average of two middle values for even-length array", () => {
    // [2000, 4000, 6000, 8000] → (4000+6000)/2 = 5000
    expect(computeMedian([6000, 2000, 8000, 4000])).toBe(5000);
  });

  test("does not mutate the input array", () => {
    const input = [9000, 1000, 5000];
    const copy = [...input];
    computeMedian(input);
    expect(input).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// computeMean
// ---------------------------------------------------------------------------

describe("computeMean", () => {
  test("returns 0 for empty array", () => {
    expect(computeMean([])).toBe(0);
  });

  test("returns the single value for a one-element array", () => {
    expect(computeMean([42000])).toBe(42000);
  });

  test("computes arithmetic mean correctly", () => {
    // (10 + 20 + 30) / 3 = 20
    expect(computeMean([10, 20, 30])).toBe(20);
  });

  test("handles non-integer means", () => {
    // (10 + 11) / 2 = 10.5
    expect(computeMean([10, 11])).toBe(10.5);
  });

  test("handles all-same values", () => {
    expect(computeMean([7000, 7000, 7000])).toBe(7000);
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

describe("computeStats", () => {
  test("returns zero stats for empty input", () => {
    const stats = computeStats([]);
    expect(stats.n).toBe(0);
    expect(stats.minMs).toBe(0);
    expect(stats.maxMs).toBe(0);
    expect(stats.medianMs).toBe(0);
    expect(stats.meanMs).toBe(0);
  });

  test("returns correct stats for a single sample", () => {
    const stats = computeStats([30000]);
    expect(stats.n).toBe(1);
    expect(stats.minMs).toBe(30000);
    expect(stats.maxMs).toBe(30000);
    expect(stats.medianMs).toBe(30000);
    expect(stats.meanMs).toBe(30000);
  });

  test("returns correct stats for multiple samples", () => {
    // Simulated wall-time deltas in ms:
    // [60000, 90000, 120000] → min=60000, max=120000, median=90000, mean=90000
    const stats = computeStats([120000, 60000, 90000]);
    expect(stats.n).toBe(3);
    expect(stats.minMs).toBe(60000);
    expect(stats.maxMs).toBe(120000);
    expect(stats.medianMs).toBe(90000);
    expect(stats.meanMs).toBe(90000);
  });

  test("computes correct mean when it is not equal to median", () => {
    // [10000, 20000, 90000] → mean=40000, median=20000
    const stats = computeStats([10000, 20000, 90000]);
    expect(stats.n).toBe(3);
    expect(stats.minMs).toBe(10000);
    expect(stats.maxMs).toBe(90000);
    expect(stats.medianMs).toBe(20000);
    expect(stats.meanMs).toBeCloseTo(40000, 0);
  });

  test("handles even-length arrays for median", () => {
    // [10000, 20000, 30000, 40000] → median=(20000+30000)/2=25000, mean=25000
    const stats = computeStats([40000, 10000, 30000, 20000]);
    expect(stats.n).toBe(4);
    expect(stats.minMs).toBe(10000);
    expect(stats.maxMs).toBe(40000);
    expect(stats.medianMs).toBe(25000);
    expect(stats.meanMs).toBe(25000);
  });
});
