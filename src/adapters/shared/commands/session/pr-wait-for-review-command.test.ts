/**
 * Unit tests for the session pr wait-for-review adapter's text-mode rendering.
 *
 * The mt#2043 diagnostic payload (sinceUsed + lastSeenReviews + rejectionReason)
 * needs to be surfaced in text mode, not just JSON. Reviewer (PR #1232 R1)
 * BLOCKING finding required this. These tests lock the rendering contract
 * so a future refactor can't silently regress it.
 */

import { describe, expect, test } from "bun:test";
import {
  formatMatchMessage,
  formatTimeoutMessage,
  isTrimmedReview,
  createSessionPrWaitForReviewCommand,
} from "./pr-wait-for-review-command";
import type {
  AnnotatedReview,
  SessionPrWaitForReviewMatch,
  SessionPrWaitForReviewTimeout,
} from "@minsky/domain/session/commands/pr-wait-for-review-subcommand";
import { ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";

const REVIEWER_BOT = "minsky-reviewer[bot]";
/** Shared check-run name literal (extracted per custom/no-magic-string-duplication, mt#2777 SC#1). */
const FINDINGS_CHECK_NAME = "minsky-reviewer/findings";

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

  test("renders the trimmed findings shape by default (mt#2656)", () => {
    const result: SessionPrWaitForReviewMatch = {
      matched: true,
      review: {
        reviewId: 42,
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-07T00:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        blockingCount: 2,
        nonBlockingCount: 1,
        findings: [
          { severity: "BLOCKING", location: "src/foo.ts:42", summary: "Null check missing." },
          { severity: "BLOCKING", location: "src/bar.ts:10", summary: "Off-by-one error." },
          { severity: "NON-BLOCKING", location: "src/baz.ts:5", summary: "Consider a rename." },
        ],
      },
      elapsedMs: 91_000,
      pollCount: 7,
    };
    const msg = formatMatchMessage(result);
    expect(msg).toContain("2 BLOCKING");
    expect(msg).toContain("1 NON-BLOCKING");
    expect(msg).toContain("src/foo.ts:42");
    expect(msg).toContain("Null check missing.");
    expect(msg).toContain("src/bar.ts:10");
    expect(msg).toContain("src/baz.ts:5");
    expect(msg).not.toContain("undefined");
  });

  test("renders '(no findings)' for a trimmed clean-approve review", () => {
    const result: SessionPrWaitForReviewMatch = {
      matched: true,
      review: {
        reviewId: 1,
        state: "APPROVED",
        submittedAt: "2026-07-07T00:00:00Z",
        reviewerLogin: REVIEWER_BOT,
        blockingCount: 0,
        nonBlockingCount: 0,
        findings: [],
      },
      elapsedMs: 5_000,
      pollCount: 1,
    };
    const msg = formatMatchMessage(result);
    expect(msg).toContain("0 BLOCKING");
    expect(msg).toContain("(no findings)");
  });

  test("isTrimmedReview discriminates trimmed vs. full review shapes", () => {
    expect(
      isTrimmedReview({
        reviewId: 1,
        state: "APPROVED",
        reviewerLogin: null,
        blockingCount: 0,
        nonBlockingCount: 0,
        findings: [],
      })
    ).toBe(true);
    expect(isTrimmedReview({ reviewId: 1, state: "APPROVED", reviewerLogin: null, body: "" })).toBe(
      false
    );
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
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("Timeout reached without a match");
    expect(msg).toContain("600s");
    expect(msg).toContain("21 poll(s)");
    expect(msg).toContain("Threshold (since): 2026-05-22T18:32:55.000Z");
    expect(msg).toContain("No reviews on the PR at the final poll");
  });

  // mt#2777 SC#1: the final-authoritative-check outcome must be legible in
  // text mode, not just the JSON payload (mirrors the mt#2043 precedent for
  // lastSeenReviews/sinceUsed).
  test("renders the final-authoritative-check outcome and reviewer check-run state", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: [],
      finalCheckPerformed: true,
      reviewerCheckRunState: {
        name: FINDINGS_CHECK_NAME,
        status: "in_progress",
        conclusion: null,
        url: null,
      },
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain(
      "Final authoritative check: re-read reviews list immediately before timing out"
    );
    expect(msg).toContain('Reviewer check-run "minsky-reviewer/findings": in_progress');
  });

  // mt#3877 (PR #2907 R1): this diagnostic changes the REMEDY — so it must not
  // be --json-only, and it must not name the WRONG remedy.
  //
  // mt#4046: it used to say "PUSH NOT LANDED", asserting one of the two causes.
  // The other — the head moved and the caller's sha is stale — never resolves by
  // waiting, so an agent told to check the push and wait burns the full timeout
  // and then reads its own silence as a bypass condition. Five sessions in five
  // days did exactly that. The line now names both causes and prints the head
  // actually observed, which is the sha to re-wait against.
  test("names BOTH causes when expectedHeadSha was never reached, not just a stuck push", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: [],
      expectedHeadShaUnreached: {
        expected: "6303291ad0000000000000000000000000000000",
        lastObservedHeadSha: "9a3a8ca4b0000000000000000000000000000000",
        // mt#4995: these two shas share no prefix, so this is the generic
        // branch — which is the one this test is about.
        classification: "push-pending",
      },
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("EXPECTED HEAD NEVER REACHED");
    expect(msg).toContain("6303291ad0000000000000000000000000000000");
    expect(msg).toContain("9a3a8ca4b0000000000000000000000000000000");
    expect(msg).toContain("NOT reviewer silence");
    // Both causes present, each with its own remedy. Phrased without naming
    // specific commands or result fields (PR #3021 R1): this line renders for
    // any backend with HEAD-sha support, and the rule it points at — take the
    // sha from whichever call last pushed — holds regardless of which one that
    // was.
    expect(msg).toContain("push has not landed");
    expect(msg).toContain("whichever call last pushed");
    // The load-bearing half: waiting is NOT a universal remedy here.
    expect(msg).toContain("never resolves by waiting");
    // The old wording asserted one cause as fact; it must not survive.
    expect(msg).not.toContain("PUSH NOT LANDED");
  });

  // mt#4995 SC3: when the mismatch is CLASSIFIED as a fabricated extension, the
  // generic two-cause line stops being the right answer — one of its two causes
  // has been ruled out by evidence, and leaving it in asks the reader to weigh a
  // possibility the tool already eliminated. The originating incident's exact
  // shape: `session_commit` returned the 9-character `f76e55628`, the caller
  // padded it to 40, and the wait would have burned its whole budget.
  test("names the extended-abbreviation cause, and drops the wait-for-the-push remedy", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 812,
      pollCount: 1,
      sinceUsed: "2026-09-04T21:00:00.000Z",
      lastSeenReviews: [],
      expectedHeadShaUnreached: {
        expected: "f76e556285ff4d6a4e0d21b0ba1e0a54ba7d2e0f",
        lastObservedHeadSha: "f76e556281b76e51949a057834f279e73d03a8e0",
        classification: "divergent-prefix",
      },
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
    };
    const msg = formatTimeoutMessage(result);

    // Still not silence, and still both shas — the shared header is unchanged.
    expect(msg).toContain("EXPECTED HEAD NEVER REACHED");
    expect(msg).toContain("NOT reviewer silence");
    // The cause, named specifically enough to act on.
    expect(msg).toContain("ABBREVIATED sha extended to full length");
    expect(msg).toContain("names no commit");
    // The remedy, including the part that caused the incident: the value was
    // padded out precisely because the caller believed 40 characters were
    // required, so saying "pass it verbatim" without that is half an answer.
    expect(msg).toContain("VERBATIM");
    expect(msg).toContain("must not");
    expect(msg).toContain("40 characters");
    // The load-bearing exclusion: the generic branch's advice is WRONG here and
    // must not render. Waiting cannot resolve a sha that names no commit.
    expect(msg).not.toContain("The push has not landed");
    expect(msg).not.toContain("Two causes, opposite remedies");
  });

  test("an ordinary timeout carries no push-not-landed line", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: [],
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
    };
    expect(formatTimeoutMessage(result)).not.toContain("PUSH NOT LANDED");
  });

  test("renders a failed-conclusion check-run state and a failed final-check re-read", () => {
    const result: SessionPrWaitForReviewTimeout = {
      matched: false,
      elapsedMs: 600_000,
      pollCount: 21,
      sinceUsed: "2026-05-22T18:32:55.000Z",
      lastSeenReviews: [],
      finalCheckPerformed: false,
      reviewerCheckRunState: {
        name: FINDINGS_CHECK_NAME,
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/edobry/minsky/runs/1",
      },
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("Final authoritative check: re-read attempt failed");
    expect(msg).toContain('Reviewer check-run "minsky-reviewer/findings": completed (failure)');
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
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
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
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
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
      finalCheckPerformed: true,
      reviewerCheckRunState: null,
    };
    const msg = formatTimeoutMessage(result);
    expect(msg).toContain("[PENDING] <null> @ <no submittedAt>");
    expect(msg).toContain("missing-submittedAt:");
  });
});

// ---------------------------------------------------------------------------
// createSessionPrWaitForReviewCommand — catch-block ordering (mt#2888,
// PR #2018 R1 regression fix)
// ---------------------------------------------------------------------------
//
// `getDeps` is `await`-ed first inside the command's `try` block, so a
// throwing `getDeps` reaches the SAME `catch` block a throwing domain call
// would — the simplest injection point available without mocking the
// `sessionPrWaitForReview` module import.

describe("createSessionPrWaitForReviewCommand — error-classification ordering (mt#2888)", () => {
  const CTX = { interface: "cli" } as any;

  test("REGRESSION: a ResourceNotFoundError whose message contains 'rate limit' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ResourceNotFoundError(
      "Session 'my-session' not found (internal rate limit tracker had no entry)"
    );
    const command = createSessionPrWaitForReviewCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("REGRESSION: a ValidationError whose message contains '(HTTP 5' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ValidationError("Invalid --since timestamp: '(HTTP 500-ish looking value)'");
    const command = createSessionPrWaitForReviewCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("a genuine GitHub-rate-limit MinskyError (handleOctokitError's exact headline) IS classified as RATE_LIMITED", async () => {
    const command = createSessionPrWaitForReviewCommand(async () => {
      throw new Error(
        "GitHub Rate Limit Exceeded\n\nYou've hit GitHub's API rate limit.\n\nTo fix this:\n  - Wait a few minutes before trying again"
      );
    });
    try {
      await command.execute({ sessionId: "my-session" }, CTX);
      throw new Error("expected command.execute to throw");
    } catch (err) {
      expect((err as { payload?: { code?: string } })?.payload?.code).toBe("RATE_LIMITED");
    }
  });
});
