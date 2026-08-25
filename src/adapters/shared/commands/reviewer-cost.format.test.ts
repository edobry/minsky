/**
 * Tests for `formatReviewerCostReport` (mt#4546).
 *
 * The formatter is pure — report in, string out — so these run with no
 * database and no container. The DB-backed query is verified by a live run
 * recorded in the PR body; these cover the presentation, which fails
 * independently of it.
 */
import { describe, test, expect } from "bun:test";
import {
  formatReviewerCostReport,
  type ReviewerCostReport,
  type ReviewerCostBucket,
} from "./reviewer-cost";

function bucket(overrides: Partial<ReviewerCostBucket> = {}): ReviewerCostBucket {
  return {
    calls: 10,
    medianInputTokens: 300_000,
    medianUncachedInputTokens: 50_000,
    meanCostUsd: 0.2,
    medianCostUsd: 0.18,
    totalCostUsd: 2,
    ...overrides,
  };
}

function report(overrides: Partial<ReviewerCostReport> = {}): ReviewerCostReport {
  return {
    window: { since: "2026-08-04T08:07:36Z", until: null },
    totals: {
      calls: 20,
      distinctPrs: 7,
      totalCostUsd: 4,
      activeDays: 2,
      costPerActiveDay: 2,
    },
    excluded: { indexZeroRows: 5, nullTokenRows: 1, nullCachedRows: 0 },
    rounds: { r1: bucket(), rGe2: bucket({ calls: 10 }) },
    cacheHitRatio: 0.821,
    atRoundCap: {
      capValue: 10,
      calls: 8,
      shareOfCalls: 0.4,
      totalCostUsd: 2.5,
      shareOfCost: 0.625,
    },
    perDay: [{ day: "2026-08-04", calls: 12, costUsd: 2.5 }],
    ...overrides,
  };
}

describe("formatReviewerCostReport", () => {
  test("renders the window, totals, and cache-hit ratio", () => {
    const text = formatReviewerCostReport(report());
    expect(text).toContain("2026-08-04T08:07:36Z");
    expect(text).toContain("(no upper bound)");
    expect(text).toContain("20 priced calls across 7 PRs over 2 active day(s)");
    expect(text).toContain("Cache-hit ratio: 82.1%");
  });

  test("flags a contaminated window when null-cached rows are present", () => {
    const text = formatReviewerCostReport(
      report({ excluded: { indexZeroRows: 0, nullTokenRows: 0, nullCachedRows: 4 } })
    );
    expect(text).toContain("null cached_tokens");
    expect(text).toContain("NOT comparable");
  });

  test("still prints the null-cached counter when it is zero", () => {
    // The counter's whole purpose is letting a reader distinguish a clean
    // window from a contaminated one. Omitting it at zero would make "clean"
    // and "never measured" render identically — so an explicit 0 is required,
    // and the warning must NOT appear.
    const text = formatReviewerCostReport(
      report({ excluded: { indexZeroRows: 0, nullTokenRows: 0, nullCachedRows: 0 } })
    );
    expect(text).toContain("null cached_tokens (INCLUDED but mis-priced, mt#3665):  0");
    expect(text).not.toContain("NOT comparable");
  });

  test("renders an em dash rather than a number for undefined statistics", () => {
    const empty: ReviewerCostBucket = {
      calls: 0,
      medianInputTokens: null,
      medianUncachedInputTokens: null,
      meanCostUsd: null,
      medianCostUsd: null,
      totalCostUsd: 0,
    };
    const text = formatReviewerCostReport(
      report({
        totals: {
          calls: 0,
          distinctPrs: 0,
          totalCostUsd: 0,
          activeDays: 0,
          costPerActiveDay: null,
        },
        rounds: { r1: empty, rGe2: empty },
        cacheHitRatio: null,
        atRoundCap: {
          capValue: 10,
          calls: 0,
          shareOfCalls: null,
          totalCostUsd: 0,
          shareOfCost: null,
        },
        perDay: [],
      })
    );
    expect(text).toContain("Per active day: —");
    expect(text).toContain("Cache-hit ratio: —");
    // An empty window must not claim a zero share, which reads as a measured 0%.
    expect(text).toContain("(— of calls)");
  });

  test("names the cap value it bucketed on, so a drifted constant is visible", () => {
    const text = formatReviewerCostReport(report());
    expect(text).toContain("At the 10-round tool-loop cap: 8 calls (40.0% of calls)");
    expect(text).toContain("62.5% of spend");
  });

  test("omits the per-day section entirely when there are no days", () => {
    const text = formatReviewerCostReport(report({ perDay: [] }));
    expect(text).not.toContain("Per day");
  });

  test("renders both round buckets on the same row", () => {
    const text = formatReviewerCostReport(
      report({
        rounds: {
          r1: bucket({ calls: 3, medianInputTokens: 111_000 }),
          rGe2: bucket({ calls: 17, medianInputTokens: 222_000 }),
        },
      })
    );
    const callsLine = text.split("\n").find((l) => l.trim().startsWith("calls"));
    expect(callsLine).toBeDefined();
    expect(callsLine).toContain("3");
    expect(callsLine).toContain("17");
    const medianLine = text.split("\n").find((l) => l.includes("median input tokens"));
    expect(medianLine).toContain("111,000");
    expect(medianLine).toContain("222,000");
  });
});
