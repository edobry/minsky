/**
 * `expectedHeadSha`: don't consider reviews until the push lands (mt#3877).
 *
 * `session_commit` runs the full suite in pre-commit and routinely exceeds the
 * 120s MCP tool timeout, at which point the harness backgrounds it and the push
 * completes up to a minute later. A watcher armed in that window returns a
 * review of the PREVIOUS head — re-reporting findings the unpushed commit
 * already fixed, and costing a full review round (observed on PR #2730,
 * 2026-08-09, 44 seconds between the review and the push).
 *
 * `requireCurrentHead` cannot cover it: in that window the superseded commit
 * genuinely IS the remote's current head, so the filter meant to exclude a
 * stale review is satisfied by exactly the wrong thing. These tests pin the
 * missing half — the commit the CALLER meant to have reviewed.
 *
 * Lives in its own file rather than in `pr-wait-for-review-subcommand.test.ts`
 * because that file is at the 1500-line `max-lines` ceiling — the same reason
 * `pr-wait-for-review-standing-verdict.test.ts` is separate (mem#833: extract a
 * sibling rather than shave lines out of a file at its ceiling, since shaving
 * buys margin the next concurrent merge consumes).
 */
import { describe, expect, test } from "bun:test";
import {
  sessionPrWaitForReview,
  type SessionPrWaitForReviewDependencies,
} from "./pr-wait-for-review-subcommand";
import type { ReviewListEntry, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";

const REVIEWER_BOT = "minsky-reviewer[bot]";
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;
const APPROVED_STATE = "APPROVED" as const;

/** The commit the reviewer saw — the one the fix supersedes. */
const STALE_SHA = "9a3a8ca4b0000000000000000000000000000000";
/** The commit `session_commit` produced, still in flight to the remote. */
const PUSHED_SHA = "6303291ad0000000000000000000000000000000";

const staleReview: ReviewListEntry = {
  reviewId: 1,
  state: CHANGES_REQUESTED_STATE,
  submittedAt: "2026-08-09T00:09:20Z",
  reviewerLogin: REVIEWER_BOT,
  body: "",
  commitId: STALE_SHA,
};

const freshReview: ReviewListEntry = {
  reviewId: 2,
  state: APPROVED_STATE,
  submittedAt: "2026-08-09T00:18:58Z",
  reviewerLogin: REVIEWER_BOT,
  body: "",
  commitId: PUSHED_SHA,
};

/**
 * Reproduces the PR #2730 shape: the remote serves the pre-push commit for the
 * first `staleForPolls` polls, with a review of THAT commit already posted.
 *
 * @param opts.pushEverLands when false the remote never advances, which is the
 * genuinely-stuck-push case the timeout diagnostic has to name.
 */
function makePushLagDeps(
  staleForPolls: number,
  opts: { pushEverLands: boolean }
): SessionPrWaitForReviewDependencies {
  let headIdx = 0;
  let listIdx = 0;
  let clock = 1_000_000;

  const sessionRecord = {
    session: "s",
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(0).toISOString(),
    pullRequest: { number: 123, branch: "task/mt-test", baseBranch: "main" },
    taskId: "mt#3877",
  } as unknown as SessionRecord;

  const stillStale = (poll: number): boolean => !opts.pushEverLands || poll < staleForPolls;

  const backend = {
    review: {
      // The stale review is visible from the first poll; the fresh one only
      // once the push has landed.
      listReviews: async () => (stillStale(listIdx++) ? [staleReview] : [staleReview, freshReview]),
      getPullRequestCreatedAt: async () => new Date(0).toISOString(),
      getPullRequestHeadSha: async () => (stillStale(headIdx++) ? STALE_SHA : PUSHED_SHA),
    },
  } as unknown as RepositoryBackend;

  return {
    sessionDB: { getSession: async () => sessionRecord } as unknown as SessionProviderInterface,
    createBackend: async () => backend,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  } as unknown as SessionPrWaitForReviewDependencies;
}

describe("sessionPrWaitForReview — expectedHeadSha (mt#3877)", () => {
  test("waits through the push-lag window instead of returning the stale review", async () => {
    const deps = makePushLagDeps(2, { pushEverLands: true });

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 60, expectedHeadSha: PUSHED_SHA },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      // reviewId 1 is the stale round this exists to skip.
      expect(result.review.reviewId).toBe(2);
      expect(result.pollCount).toBe(3);
    }
  });

  test("without expectedHeadSha the same script returns the stale review — the param is what changes it", async () => {
    // Negative control for the MECHANISM, not just the code path: it shows that
    // requireCurrentHead alone admits the superseded review, which is the defect
    // mt#3877 reports.
    const deps = makePushLagDeps(2, { pushEverLands: true });

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 60 },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(1);
      expect(result.pollCount).toBe(1);
    }
  });

  test("a suppressed review is annotated as suppressed, never as 'matched' (PR #2907 R1)", async () => {
    // The timeout payload's per-review reason is what an agent reads to work
    // out why the wait failed. A review that passes every ordinary filter but
    // was suppressed wholesale by the head gate must not read "matched" there —
    // that asserts the opposite of what happened.
    const deps = makePushLagDeps(0, { pushEverLands: false });

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 10, expectedHeadSha: PUSHED_SHA },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      const [annotated] = result.lastSeenReviews;
      expect(annotated).toBeDefined();
      expect(annotated?.rejectionReason).toContain("push-not-landed");
      expect(annotated?.rejectionReason).not.toContain("matched:");
    }
  });

  test("a timeout names the sha the remote never reached", async () => {
    // "The push is stuck" and "the reviewer is silent" call for opposite
    // responses, and only one of them is a bypass condition — so the timeout
    // payload has to distinguish them.
    const deps = makePushLagDeps(0, { pushEverLands: false });

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 10, expectedHeadSha: PUSHED_SHA },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.expectedHeadShaUnreached).toEqual({
        expected: PUSHED_SHA,
        lastObservedHeadSha: STALE_SHA,
      });
    }
  });
});
