/**
 * Standing-verdict resolution for session_pr_wait_for_review (mt#3555).
 *
 * Before mt#3555, `findMatchingReview` returned the FIRST review in listing
 * order that passed its filters. `listReviews` returns GitHub's chronological
 * (oldest-first) order, so that was the EARLIEST qualifying review: on
 * PR #2525 an APPROVED at 18:59:48Z beat the same reviewer's
 * CHANGES_REQUESTED at 19:07:55Z **on the same commit**, and `/implement-task`
 * §9 reads an APPROVED on current HEAD as authorization to merge.
 *
 * Lives in its own file rather than in `pr-wait-for-review-subcommand.test.ts`
 * because that file is at the 1500-line `max-lines` ceiling.
 */
import { describe, expect, test } from "bun:test";
import { findMatchingReview, trimReview } from "./pr-wait-for-review-subcommand";
import type { ReviewListEntry } from "../../repository/index";

const REVIEWER_BOT = "minsky-reviewer[bot]";
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;
const APPROVED_STATE = "APPROVED" as const;
const COMMENTED_STATE = "COMMENTED" as const;

/** Both incident reviews sat on this one commit — the head filter admits both. */
const HEAD = "05bdb036";
const SINCE = Date.parse("2026-08-01T18:00:00Z");
const BLOCKING_BODY =
  "## Findings\n" +
  "- [BLOCKING] src/a.ts:1 — the guard is set after the value it guards\n" +
  "  details line\n";

function mkReview(overrides: Partial<ReviewListEntry>): ReviewListEntry {
  return {
    reviewId: 1,
    state: APPROVED_STATE,
    submittedAt: "2026-08-01T18:59:48Z",
    reviewerLogin: REVIEWER_BOT,
    commitId: HEAD,
    body: "",
    ...overrides,
  };
}

describe("findMatchingReview — standing verdict resolution (mt#3555)", () => {
  const approved = mkReview({
    reviewId: 4835481763,
    state: APPROVED_STATE,
    submittedAt: "2026-08-01T18:59:48Z",
  });
  const changesRequested = mkReview({
    reviewId: 4835507156,
    state: CHANGES_REQUESTED_STATE,
    submittedAt: "2026-08-01T19:07:55Z",
    body: BLOCKING_BODY,
  });

  test("returns the newer CHANGES_REQUESTED, not the older APPROVED on the same commit", () => {
    const match = findMatchingReview([approved, changesRequested], SINCE, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(4835507156);
    expect(match?.state).toBe(CHANGES_REQUESTED_STATE);
  });

  test("the returned CHANGES_REQUESTED carries its findings and a non-zero blockingCount", () => {
    const match = findMatchingReview([approved, changesRequested], SINCE, REVIEWER_BOT, HEAD);
    expect(match).toBeDefined();
    const trimmed = trimReview(match as ReviewListEntry);
    expect(trimmed.blockingCount).toBe(1);
    expect(trimmed.findings).toHaveLength(1);
    expect(trimmed.findings[0]?.severity).toBe("BLOCKING");
  });

  // The mt#1123 / mt#1747 direction — a CHANGES_REQUESTED the same reviewer
  // later resolved must NOT keep winning. This half was already correct on the
  // approval path; it must not regress here.
  test("returns the newer APPROVED when it supersedes a CHANGES_REQUESTED on the same commit", () => {
    const earlierRejection = mkReview({
      reviewId: 10,
      state: CHANGES_REQUESTED_STATE,
      submittedAt: "2026-08-01T18:59:48Z",
      body: BLOCKING_BODY,
    });
    const laterApproval = mkReview({
      reviewId: 11,
      state: APPROVED_STATE,
      submittedAt: "2026-08-01T19:07:55Z",
    });
    const match = findMatchingReview([earlierRejection, laterApproval], SINCE, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(11);
    expect(match?.state).toBe(APPROVED_STATE);
  });

  // COMMENTED is informational, never a verdict: it does not supersede the
  // reviewer's earlier decision.
  test("a later COMMENTED does not supersede an earlier APPROVED", () => {
    const laterComment = mkReview({
      reviewId: 21,
      state: COMMENTED_STATE,
      submittedAt: "2026-08-01T19:00:48Z",
    });
    const match = findMatchingReview([approved, laterComment], SINCE, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(4835481763);
    expect(match?.state).toBe(APPROVED_STATE);
  });

  // …but a COMMENTED-only wait must still resolve: `pr-drive-subcommand`
  // branches on a COMMENT result, so dropping it would strand that caller.
  test("returns the latest COMMENTED when no decision-bearing review matches", () => {
    const firstComment = mkReview({
      reviewId: 31,
      state: COMMENTED_STATE,
      submittedAt: "2026-08-01T18:30:00Z",
    });
    const secondComment = mkReview({
      reviewId: 32,
      state: COMMENTED_STATE,
      submittedAt: "2026-08-01T18:45:00Z",
    });
    const match = findMatchingReview([firstComment, secondComment], SINCE, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(32);
    expect(match?.state).toBe(COMMENTED_STATE);
  });

  // Multi-reviewer shape of the same defect: with no reviewer filter, a second
  // reviewer's later APPROVED must not mask a first reviewer's standing
  // rejection.
  test("a standing CHANGES_REQUESTED wins over another reviewer's later APPROVED", () => {
    const humanRejection = mkReview({
      reviewId: 41,
      state: CHANGES_REQUESTED_STATE,
      submittedAt: "2026-08-01T18:50:00Z",
      reviewerLogin: "a-human",
      body: BLOCKING_BODY,
    });
    const botApproval = mkReview({
      reviewId: 42,
      state: APPROVED_STATE,
      submittedAt: "2026-08-01T19:20:00Z",
    });
    const match = findMatchingReview([humanRejection, botApproval], SINCE, undefined, HEAD);
    expect(match?.reviewId).toBe(41);
    expect(match?.state).toBe(CHANGES_REQUESTED_STATE);
  });

  // PR #2525's real history, read from the GitHub API: ten alternating reviews
  // from one reviewer between 18:37Z and 19:30Z. The standing verdict at the
  // end of that sequence is the final APPROVED.
  test("resolves the real PR #2525 history to the final APPROVED", () => {
    const history: ReviewListEntry[] = [
      { id: 1, state: CHANGES_REQUESTED_STATE, at: "2026-08-01T18:37:35Z" },
      { id: 2, state: CHANGES_REQUESTED_STATE, at: "2026-08-01T18:41:06Z" },
      { id: 3, state: APPROVED_STATE, at: "2026-08-01T18:45:00Z" },
      { id: 4, state: CHANGES_REQUESTED_STATE, at: "2026-08-01T18:54:41Z" },
      { id: 5, state: APPROVED_STATE, at: "2026-08-01T18:59:48Z" },
      { id: 6, state: CHANGES_REQUESTED_STATE, at: "2026-08-01T19:07:55Z" },
      { id: 7, state: APPROVED_STATE, at: "2026-08-01T19:16:22Z" },
      { id: 8, state: APPROVED_STATE, at: "2026-08-01T19:18:23Z" },
      { id: 9, state: APPROVED_STATE, at: "2026-08-01T19:24:09Z" },
      { id: 10, state: APPROVED_STATE, at: "2026-08-01T19:30:48Z" },
    ].map(({ id, state, at }) => mkReview({ reviewId: id, state, submittedAt: at }));
    const match = findMatchingReview(history, SINCE, REVIEWER_BOT, HEAD);
    expect(match?.reviewId).toBe(10);
    expect(match?.state).toBe(APPROVED_STATE);
  });
});
