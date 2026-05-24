/**
 * Unit tests for the session pr wait-for-review adapter's text-mode rendering.
 *
 * The mt#2043 diagnostic payload (sinceUsed + lastSeenReviews + rejectionReason)
 * needs to be surfaced in text mode, not just JSON. Reviewer (PR #1232 R1)
 * BLOCKING finding required this. These tests lock the rendering contract
 * so a future refactor can't silently regress it.
 */

import { describe, expect, test } from "bun:test";
import { formatMatchMessage, formatTimeoutMessage } from "./pr-wait-for-review-command";
import type {
  AnnotatedReview,
  SessionPrWaitForReviewMatch,
  SessionPrWaitForReviewTimeout,
} from "../../../../domain/session/commands/pr-wait-for-review-subcommand";

const REVIEWER_BOT = "minsky-reviewer[bot]";

describe("formatMatchMessage", () => {
  test("renders reviewer, state, elapsed, pollCount, submitted, URL, body excerpt", () => {
    const result: SessionPrWaitForReviewMatch = {
      matched: true,
      review: {
        reviewId: 42,
        state: "APPROVED",
        submittedAt: "2026-05-22T01:11:20Z",
        reviewerLogin: REVIEWER_BOT,
        body: "Looks good.\nNo blocking findings.",
        htmlUrl: "https://github.com/edobry/minsky/pull/1232#pullrequestreview-42",
      },
      elapsedMs: 91_000,
      pollCount: 7,
    };
    const msg = formatMatchMessage(result);
    expect(msg).toContain(REVIEWER_BOT);
    expect(msg).toContain("APPROVED");
    expect(msg).toContain("91s");
    expect(msg).toContain("7 poll(s)");
    expect(msg).toContain("2026-05-22T01:11:20Z");
    expect(msg).toContain("https://github.com/edobry/minsky/pull/1232");
    expect(msg).toContain("Looks good.");
    expect(msg).toContain("No blocking findings.");
  });

  test("renders fallback for empty review body", () => {
    const result: SessionPrWaitForReviewMatch = {
      matched: true,
      review: {
        reviewId: 1,
        state: "COMMENTED",
        submittedAt: "2026-05-22T01:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
      },
      elapsedMs: 5_000,
      pollCount: 1,
    };
    const msg = formatMatchMessage(result);
    expect(msg).toContain("(empty review body)");
  });

  test("renders unknown reviewer when reviewerLogin is null", () => {
    const result: SessionPrWaitForReviewMatch = {
      matched: true,
      review: {
        reviewId: 1,
        state: "COMMENTED",
        submittedAt: "2026-05-22T01:00:00Z",
        reviewerLogin: null,
        body: "x",
      },
      elapsedMs: 1_000,
      pollCount: 1,
    };
    const msg = formatMatchMessage(result);
    expect(msg).toContain("unknown");
  });
});

describe("formatTimeoutMessage (mt#2043 diagnostic visibility)", () => {
  test("renders sinceUsed and 'no reviews' line when lastSeenReviews is empty", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: [],
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("Timeout reached without a match");
    expect(msg).toContain("600s");
    expect(msg).toContain("21 poll(s)");
    expect(msg).toContain("Threshold (since): 2026-05-22T18:32:55.000Z");
    expect(msg).toContain("No reviews on the PR at the final poll");
  });

  test("renders up to 5 lastSeenReviews entries with rejectionReason", () => {
    const reviews: AnnotatedReview[] = [
      {
        reviewId: 1,
        state: "COMMENTED",
        submittedAt: "2026-05-21T17:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        body: "",
        rejectionReason:
          "since: submittedAt 2026-05-21T17:00:00Z < threshold 2026-05-21T18:32:55.000Z",
      },
      {
        reviewId: 2,
        state: "APPROVED",
        submittedAt: "2026-05-21T19:00:00Z",
        reviewerLogin: "someone-else",
        body: "",
        rejectionReason: "reviewer-mismatch: reviewerLogin someone-else != filter minsky-reviewer",
      },
    ];
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: reviews,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("Last seen 2 review(s):");
    expect(msg).toContain("[COMMENTED] minsky-reviewer[bot] @ 2026-05-21T17:00:00Z");
    expect(msg).toContain("since: submittedAt 2026-05-21T17:00:00Z");
    expect(msg).toContain("[APPROVED] someone-else @ 2026-05-21T19:00:00Z");
    expect(msg).toContain("reviewer-mismatch:");
  });

  test("truncates at 5 entries and notes how many more (use --json)", () => {
    const reviews: AnnotatedReview[] = Array.from({ length: 8 }, (_, i) => ({
      reviewId: i + 1,
      state: "COMMENTED",
      submittedAt: `2026-05-21T17:0${i}:00Z`,
      reviewerLogin: REVIEWER_BOT,
      body: "",
      rejectionReason: `since: submittedAt 2026-05-21T17:0${i}:00Z < threshold ...`,
    }));
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: reviews,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("Last seen 8 review(s):");
    // The first 5 should be present
    expect(msg).toContain("17:00:00Z");
    expect(msg).toContain("17:04:00Z");
    // The 6th-onwards should NOT be inline
    expect(msg).not.toContain("17:05:00Z");
    expect(msg).not.toContain("17:07:00Z");
    expect(msg).toContain("... and 3 more (use --json for full list)");
  });

  test("renders <null> for null reviewerLogin and <no submittedAt> for missing submittedAt", () => {
    const reviews: AnnotatedReview[] = [
      {
        reviewId: 1,
        state: "PENDING",
        submittedAt: undefined,
        reviewerLogin: null,
        body: "",
        rejectionReason: "missing-submittedAt: review has no submittedAt timestamp",
      },
    ];
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 5_000,
      pollCount: 1,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: reviews,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("[PENDING] <null> @ <no submittedAt>");
    expect(msg).toContain("missing-submittedAt:");
  });
});
