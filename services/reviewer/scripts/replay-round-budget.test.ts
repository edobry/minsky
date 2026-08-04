/**
 * Unit coverage for the round-budget replay harness's pure helpers (mt#3547).
 *
 * The harness's live path needs credentials, but the arithmetic that turns
 * observations into the A/B table does not — and that arithmetic is what the
 * ship decision reads. A median that silently mishandles even-length input, or
 * a rate that divides by the wrong denominator, produces a confident wrong
 * number rather than an obvious failure.
 */

import { describe, expect, test } from "bun:test";
import {
  median,
  summarize,
  resolveRepoCoordinates,
  type PrRoundBudgetResult,
  type RoundBudgetObservation,
} from "./replay-round-budget";

function observation(overrides: Partial<RoundBudgetObservation> = {}): RoundBudgetObservation {
  return {
    attempt: 1,
    roundsUsed: 10,
    maxRounds: 10,
    exhaustedCap: true,
    concludedInLoop: false,
    concludedAtRound: null,
    forcedConcludeGateBranch: "emitted_no_conclude",
    findings: [],
    findingCount: 3,
    blockingFindingCount: 1,
    readFileCallCount: 5,
    inputTokens: 400_000,
    cachedTokens: 320_000,
    ...overrides,
  };
}

function result(observations: RoundBudgetObservation[]): PrRoundBudgetResult {
  return {
    prNumber: 1,
    title: "t",
    headSha: "abc",
    diffChars: 100,
    observations,
  };
}

describe("median", () => {
  test("returns 0 for an empty list rather than NaN", () => {
    // NaN would propagate into the A/B table and render as "NaN" beside real
    // numbers, which reads as a bug in the run rather than an empty input.
    expect(median([])).toBe(0);
  });

  test("takes the middle value for odd-length input", () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  test("averages the two middle values for even-length input", () => {
    expect(median([10, 6, 4, 10])).toBe(8);
  });

  test("does not mutate the caller's array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("summarize", () => {
  test("computes rates over observations, not over PRs", () => {
    // Two PRs with unequal attempt counts: a per-PR denominator would report
    // 50% here instead of the correct 25%.
    const results = [
      result([observation({ exhaustedCap: true }), observation({ exhaustedCap: true })]),
      result([
        observation({ exhaustedCap: false, roundsUsed: 4 }),
        observation({ exhaustedCap: true }),
      ]),
    ];

    const summary = summarize(results);
    expect(summary.observationCount).toBe(4);
    expect(summary.capExhaustedRate).toBe(0.75);
  });

  test("reports the in-loop conclusion rate — the metric the change targets", () => {
    const results = [
      result([
        observation({ concludedInLoop: true }),
        observation({ concludedInLoop: true }),
        observation({ concludedInLoop: false }),
        observation({ concludedInLoop: false }),
      ]),
    ];

    expect(summarize(results).concludedInLoopRate).toBe(0.5);
  });

  test("carries the blocking-finding total so a round win cannot hide a quality loss", () => {
    const results = [
      result([
        observation({ roundsUsed: 5, blockingFindingCount: 0 }),
        observation({ roundsUsed: 5, blockingFindingCount: 0 }),
      ]),
    ];

    const summary = summarize(results);
    expect(summary.medianRounds).toBe(5);
    expect(summary.totalBlockingFindings).toBe(0);
    expect(summary.medianBlockingFindings).toBe(0);
  });

  test("returns zeroed rates rather than NaN for an empty run", () => {
    const summary = summarize([]);
    expect(summary.observationCount).toBe(0);
    expect(summary.capExhaustedRate).toBe(0);
    expect(summary.concludedInLoopRate).toBe(0);
    expect(summary.meanRounds).toBe(0);
  });
});

describe("resolveRepoCoordinates", () => {
  test("defaults to the corpus repo when nothing is supplied", () => {
    expect(resolveRepoCoordinates([], {})).toEqual({ owner: "edobry", repo: "minsky" });
  });

  test("reads GITHUB_REPOSITORY when CI sets it", () => {
    expect(resolveRepoCoordinates([], { GITHUB_REPOSITORY: "acme/widgets" })).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  test("lets explicit flags override the environment", () => {
    expect(
      resolveRepoCoordinates(["--owner=fork", "--repo=mirror"], {
        GITHUB_REPOSITORY: "acme/widgets",
      })
    ).toEqual({ owner: "fork", repo: "mirror" });
  });
});
