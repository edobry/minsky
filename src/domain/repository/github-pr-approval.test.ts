import { describe, test, expect } from "bun:test";
import { pickLatestReviewPerReviewer, type MinimalReview } from "./github-pr-approval";

/**
 * Tests for `pickLatestReviewPerReviewer` — the per-reviewer "latest review
 * wins" reducer that backs the `isApproved` decision in
 * `getPullRequestApprovalStatus`. Originating task: mt#1830.
 *
 * The function itself is unit-testable; `getPullRequestApprovalStatus` wraps
 * it inside an Octokit-dependent fetch path that's covered by integration
 * tests elsewhere. These tests focus on the reduction semantics in
 * isolation: same-reviewer supersede, different-reviewer independence,
 * timestamp ordering, and edge cases (empty, missing fields, ties).
 */

// Constants extracted to satisfy custom/no-magic-string-duplication and to
// keep the test-data shape explicit.
const STATE_APPROVED = "APPROVED";
const STATE_CHANGES_REQUESTED = "CHANGES_REQUESTED";
const STATE_DISMISSED = "DISMISSED";
const STATE_COMMENTED = "COMMENTED";
const REVIEWER_BOT = "minsky-reviewer[bot]";

// Deterministic id counter so test-data has stable identifiers without
// invoking Math.random() (which the no-real-fs-in-tests rule flags as a
// parallel-test race source).
let nextReviewId = 1;

function review(
  login: string,
  state: string,
  submitted_at: string | null = null,
  extra: Record<string, unknown> = {}
): MinimalReview & { id: number } {
  return {
    id: nextReviewId++,
    user: { login },
    state,
    submitted_at,
    ...extra,
  };
}

describe("pickLatestReviewPerReviewer", () => {
  test("empty input returns empty array", () => {
    expect(pickLatestReviewPerReviewer([])).toEqual([]);
  });

  test("single review passes through", () => {
    const r = review("alice", STATE_APPROVED, "2026-05-13T10:00:00Z");
    expect(pickLatestReviewPerReviewer([r])).toEqual([r]);
  });

  test("AT1: later APPROVED supersedes earlier CHANGES_REQUESTED from same reviewer", () => {
    const earlier = review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T18:13:33Z");
    const later = review("bot", STATE_APPROVED, "2026-05-13T18:22:54Z");
    const result = pickLatestReviewPerReviewer([earlier, later]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(later);
  });

  test("AT3: later CHANGES_REQUESTED supersedes earlier APPROVED from same reviewer", () => {
    const earlier = review("bot", STATE_APPROVED, "2026-05-13T10:00:00Z");
    const later = review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([earlier, later]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(later);
  });

  test("AT2: different reviewers do not supersede each other", () => {
    const alice = review("alice", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z");
    const bob = review("bob", STATE_APPROVED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([alice, bob]);
    expect(result).toHaveLength(2);
    const byLogin = new Map(result.map((r) => [r.user?.login ?? "", r]));
    expect(byLogin.get("alice")).toEqual(alice);
    expect(byLogin.get("bob")).toEqual(bob);
  });

  test("AT5: DISMISSED state participates in latest-wins reduction", () => {
    const dismissed = review("bot", STATE_DISMISSED, "2026-05-13T10:00:00Z");
    const approved = review("bot", STATE_APPROVED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([dismissed, approved]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(approved);
  });

  test("DISMISSED that is the latest wins (defensive — no APPROVED follow-up)", () => {
    const approved = review("bot", STATE_APPROVED, "2026-05-13T10:00:00Z");
    const dismissed = review("bot", STATE_DISMISSED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([approved, dismissed]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(dismissed);
  });

  test("COMMENTED state participates in latest-wins reduction", () => {
    const changes = review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z");
    const commented = review("bot", STATE_COMMENTED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([changes, commented]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(commented);
  });

  test("AT6: real-world PR #1110 timeline collapses to single APPROVED", () => {
    // Timeline from mt#1824 / PR #1110 (2026-05-13):
    //   CHANGES_REQUESTED 18:13:33Z, APPROVED 18:22:54Z, APPROVED 18:26:32Z
    //   all from REVIEWER_BOT.
    const reviews = [
      review(REVIEWER_BOT, STATE_CHANGES_REQUESTED, "2026-05-13T18:13:33Z"),
      review(REVIEWER_BOT, STATE_APPROVED, "2026-05-13T18:22:54Z"),
      review(REVIEWER_BOT, STATE_APPROVED, "2026-05-13T18:26:32Z"),
    ];
    const result = pickLatestReviewPerReviewer(reviews);
    expect(result).toHaveLength(1);
    const winner = result[0];
    expect(winner).toBeDefined();
    expect(winner?.state).toBe(STATE_APPROVED);
    expect(winner?.submitted_at).toBe("2026-05-13T18:26:32Z");
  });

  test("reviews with missing user.login are dropped", () => {
    const anon = { user: null, state: STATE_APPROVED, submitted_at: "2026-05-13T10:00:00Z" };
    const named = review("alice", STATE_APPROVED, "2026-05-13T11:00:00Z");
    const result = pickLatestReviewPerReviewer([anon, named]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(named);
  });

  test("reviews with missing submitted_at sort as oldest", () => {
    const undated = review("bot", STATE_APPROVED, null);
    const dated = review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z");
    const result = pickLatestReviewPerReviewer([undated, dated]);
    expect(result).toHaveLength(1);
    // dated > "" → dated wins
    expect(result[0]).toEqual(dated);
  });

  test("identical submitted_at: later array position wins", () => {
    // listReviews returns chronologically; ties on submitted_at are rare but
    // possible if two reviews land within the same second. The later entry
    // in the array (= most-recently-listed by the API) wins.
    const first = review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z");
    const second = review("bot", STATE_APPROVED, "2026-05-13T10:00:00Z");
    const result = pickLatestReviewPerReviewer([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(second);
  });

  test("three-reviewer mix with mixed states", () => {
    const reviews = [
      review("alice", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z"),
      review("alice", STATE_APPROVED, "2026-05-13T11:00:00Z"),
      review("bob", STATE_APPROVED, "2026-05-13T10:30:00Z"),
      review("carol", STATE_CHANGES_REQUESTED, "2026-05-13T10:45:00Z"),
    ];
    const result = pickLatestReviewPerReviewer(reviews);
    expect(result).toHaveLength(3);
    const states = new Map(result.map((r) => [r.user?.login ?? "", r.state]));
    expect(states.get("alice")).toBe(STATE_APPROVED);
    expect(states.get("bob")).toBe(STATE_APPROVED);
    expect(states.get("carol")).toBe(STATE_CHANGES_REQUESTED);
  });
});

/**
 * Integration-shape tests: these compose the reducer with the predicate
 * shape used in `getPullRequestApprovalStatus` to verify the end-to-end
 * `isApproved` outcome matches the spec's acceptance tests AT1–AT6.
 */
describe("isApproved predicate composition (mt#1830 AT1-AT6)", () => {
  function computeIsApproved(reviews: MinimalReview[], requiredApprovals: number): boolean {
    const latestPerReviewer = pickLatestReviewPerReviewer(reviews);
    const effectiveApprovals = latestPerReviewer.filter((r) => r.state === STATE_APPROVED);
    const effectiveRejections = latestPerReviewer.filter(
      (r) => r.state === STATE_CHANGES_REQUESTED
    );
    return (
      (requiredApprovals === 0 && effectiveRejections.length === 0) ||
      (requiredApprovals > 0 &&
        effectiveApprovals.length >= requiredApprovals &&
        effectiveRejections.length === 0)
    );
  }

  test("AT1: supersede happy path - CHANGES_REQUESTED then APPROVED from same reviewer", () => {
    const reviews = [
      review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z"),
      review("bot", STATE_APPROVED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 0)).toBe(true);
  });

  test("AT2: different-reviewer rejection stands", () => {
    const reviews = [
      review("alice", STATE_CHANGES_REQUESTED, "2026-05-13T10:00:00Z"),
      review("bob", STATE_APPROVED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 0)).toBe(false);
  });

  test("AT3: later CHANGES_REQUESTED wins over earlier APPROVE", () => {
    const reviews = [
      review("bot", STATE_APPROVED, "2026-05-13T10:00:00Z"),
      review("bot", STATE_CHANGES_REQUESTED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 0)).toBe(false);
  });

  test("AT4: empty review list with requiredApprovals 0 is approved", () => {
    expect(computeIsApproved([], 0)).toBe(true);
  });

  test("AT5: DISMISSED then APPROVED from same reviewer is approved", () => {
    const reviews = [
      review("bot", STATE_DISMISSED, "2026-05-13T10:00:00Z"),
      review("bot", STATE_APPROVED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 0)).toBe(true);
  });

  test("AT6: real-world PR #1110 shape", () => {
    const reviews = [
      review(REVIEWER_BOT, STATE_CHANGES_REQUESTED, "2026-05-13T18:13:33Z"),
      review(REVIEWER_BOT, STATE_APPROVED, "2026-05-13T18:22:54Z"),
      review(REVIEWER_BOT, STATE_APPROVED, "2026-05-13T18:26:32Z"),
    ];
    expect(computeIsApproved(reviews, 0)).toBe(true);
  });

  test("AT4 variant: empty review list with requiredApprovals > 0 is NOT approved", () => {
    // Backwards-compat: requiredApprovals > 0 still demands approvals.length >= required.
    expect(computeIsApproved([], 1)).toBe(false);
  });

  test("requiredApprovals=2 with two distinct reviewers approves", () => {
    const reviews = [
      review("alice", STATE_APPROVED, "2026-05-13T10:00:00Z"),
      review("bob", STATE_APPROVED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 2)).toBe(true);
  });

  test("requiredApprovals=2 with two reviews from same reviewer counts as 1 effective approval", () => {
    // Per latest-wins reduction: only one reviewer (bot) effectively approves.
    const reviews = [
      review("bot", STATE_APPROVED, "2026-05-13T10:00:00Z"),
      review("bot", STATE_APPROVED, "2026-05-13T11:00:00Z"),
    ];
    expect(computeIsApproved(reviews, 2)).toBe(false);
    expect(computeIsApproved(reviews, 1)).toBe(true);
  });
});
