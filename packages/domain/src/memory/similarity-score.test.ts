/**
 * L2-distance ↔ cosine-similarity conversion (mt#4787).
 *
 * The values in the first describe block are the ones measured live against
 * pgvector on 2026-08-31 (top neighbours of `mem#1344`), so this is a
 * regression test against real data rather than against the formula restated.
 * If the formula is ever "simplified" into something that no longer agrees with
 * pgvector's own `<=>`, these fail.
 */
import { describe, test, expect } from "bun:test";
import {
  l2DistanceToSimilarity,
  similarityToL2Distance,
  COSINE_ZERO_CROSSING_L2,
} from "./similarity-score";

/**
 * Adjacent pairs, so a monotonicity assertion needs no index arithmetic and no
 * non-null assertions (the repo's lint gate is zero-warning).
 */
function consecutivePairs(values: number[]): Array<[number, number]> {
  return values.slice(1).map((next, i) => [values[i] as number, next]);
}

describe("l2DistanceToSimilarity — agrees with pgvector's own cosine", () => {
  // [L2 distance from the `<->` operator, cosine similarity from `1 - (a <=> b)`]
  const MEASURED: Array<[number, number]> = [
    [0.6159, 0.8104],
    [0.6707, 0.7751],
    [0.6724, 0.7739],
    [0.6833, 0.7665],
    [0.6898, 0.762],
    [0.6953, 0.7583],
  ];

  test.each(MEASURED)("d=%p converts to pgvector's cosine %p", (distance, pgvectorCosine) => {
    // 1e-3 absorbs the float32 rounding in the stored vectors and the 4-dp
    // rounding of the recorded measurement. It is far tighter than the defect
    // being fixed, which was off by ~0.19 in the wrong direction.
    expect(l2DistanceToSimilarity(distance)).toBeCloseTo(pgvectorCosine, 3);
  });

  test("the top match converts to the HIGHEST number, which is the whole defect", () => {
    // Before the fix these rendered as 62% and 70% — the closest neighbour
    // showing the smallest figure.
    const nearest = l2DistanceToSimilarity(0.6159);
    const furthest = l2DistanceToSimilarity(0.6953);
    expect(nearest).toBeGreaterThan(furthest);
    expect(Math.round(nearest * 100)).toBe(81);
    expect(Math.round(furthest * 100)).toBe(76);
  });

  test("is monotonically decreasing in distance", () => {
    const distances = [0, 0.1, 0.25, 0.5, 0.75, 1, 1.2, 1.4];
    const sims = distances.map(l2DistanceToSimilarity);
    for (const [prev, next] of consecutivePairs(sims)) {
      expect(next).toBeLessThan(prev);
    }
  });
});

describe("l2DistanceToSimilarity — boundaries", () => {
  test("distance 0 is a perfect match", () => {
    expect(l2DistanceToSimilarity(0)).toBe(1);
  });

  test("distance √2 is the zero crossing", () => {
    expect(l2DistanceToSimilarity(COSINE_ZERO_CROSSING_L2)).toBe(0);
  });

  test("beyond the zero crossing clamps to 0 rather than going negative", () => {
    // The guard, not a normal path: max observed L2 over 1,109 live pairs was
    // 1.2059, well inside √2. A negative percentage is not a meaningful thing
    // to render, so the clamp is what a future corpus violating that
    // assumption would hit.
    expect(l2DistanceToSimilarity(1.8)).toBe(0);
    expect(l2DistanceToSimilarity(2)).toBe(0);
  });

  test.each([
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("a %s distance yields 0 rather than a nonsense percentage", (_label, input) => {
    expect(l2DistanceToSimilarity(input)).toBe(0);
  });

  test("the real corpus range maps into a plausible display band", () => {
    // Observed distances run ~0.6-0.7 for related records; max seen 1.2059.
    expect(Math.round(l2DistanceToSimilarity(0.6) * 100)).toBe(82);
    expect(Math.round(l2DistanceToSimilarity(1.2059) * 100)).toBe(27);
  });
});

describe("similarityToL2Distance — the threshold direction", () => {
  test("round-trips with l2DistanceToSimilarity", () => {
    for (const d of [0, 0.25, 0.6159, 0.9, 1.2, 1.4]) {
      expect(similarityToL2Distance(l2DistanceToSimilarity(d))).toBeCloseTo(d, 6);
    }
  });

  test("is monotonically decreasing — a HIGHER similarity floor is a TIGHTER distance bound", () => {
    // This is the property that makes the threshold conversion correct: the
    // vector store filters `score <= threshold` on a distance, so a stricter
    // similarity requirement must produce a SMALLER number.
    const sims = [0.1, 0.3, 0.5, 0.7, 0.9];
    const dists = sims.map(similarityToL2Distance);
    for (const [prev, next] of consecutivePairs(dists)) {
      expect(next).toBeLessThan(prev);
    }
  });

  test("a similarity floor of 0 admits everything", () => {
    // Two unit vectors can be at most 2 apart.
    expect(similarityToL2Distance(0)).toBe(2);
    expect(similarityToL2Distance(-0.5)).toBe(2);
  });

  test("a similarity floor of 1 admits only exact matches", () => {
    expect(similarityToL2Distance(1)).toBe(0);
    expect(similarityToL2Distance(1.5)).toBe(0);
  });

  test("NaN admits everything rather than silently excluding everything", () => {
    // Failing OPEN matters here: a malformed threshold that mapped to 0 would
    // return an empty result set, which reads as "nothing is similar" rather
    // than as a bad parameter.
    expect(similarityToL2Distance(NaN)).toBe(2);
  });

  test("the documented threshold semantics actually filter the right way", () => {
    // A caller asking for "at least 78% similar" against the measured
    // neighbours should admit the 0.8104 and 0.7751 rows and exclude 0.7620.
    const maxDistance = similarityToL2Distance(0.78);
    expect(0.6159).toBeLessThanOrEqual(maxDistance); // 81% — admitted
    expect(0.6898).toBeGreaterThan(maxDistance); // 76% — excluded
  });
});
