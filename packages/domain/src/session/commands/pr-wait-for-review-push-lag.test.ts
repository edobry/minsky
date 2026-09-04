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
  MIN_ABBREVIATED_SHA_LENGTH,
  headShaMatchesExpected,
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
        // mt#4995: an unrelated head shares no prefix, so this stays the
        // wait-it-out case — the behaviour these tests pin is unchanged.
        classification: "push-pending",
      });
    }
  });
});

/**
 * mt#4039: the comparison is PREFIX-anchored, because the value callers have is
 * abbreviated.
 *
 * Every test above passes a full 40-character sha, which is why mt#3877 and its
 * review round both missed this: `session_commit` returns `commitHash`
 * ABBREVIATED and `/implement-task` §9 says to pass it through verbatim, so the
 * documented flow could never match. On PR #2914 that suppressed two genuine
 * reviews for a full 900s wait; the identical wait matched in 128s once the sha
 * was expanded by hand. These tests use the abbreviated form deliberately.
 */
describe("sessionPrWaitForReview — abbreviated expectedHeadSha (mt#4039)", () => {
  /** What `session_commit` actually returns for PUSHED_SHA. */
  const PUSHED_SHA_ABBREVIATED = PUSHED_SHA.slice(0, 9);

  test("an abbreviated sha matches the full remote head", async () => {
    const deps = makePushLagDeps(2, { pushEverLands: true });

    const result = await sessionPrWaitForReview(
      {
        sessionId: "s",
        intervalSeconds: 5,
        timeoutSeconds: 60,
        expectedHeadSha: PUSHED_SHA_ABBREVIATED,
      },
      deps
    );

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(2);
    }
  });

  test("NEGATIVE CONTROL: strict equality — the pre-fix comparison — rejects this exact pair", () => {
    // The bug was one `===`. Pinning it directly keeps the test above honest:
    // if someone reverts to equality, the test above fails and this one records
    // why. Without this, a reader cannot tell that the abbreviated case was
    // ever broken.
    expect(PUSHED_SHA === PUSHED_SHA_ABBREVIATED).toBe(false);
    expect(headShaMatchesExpected(PUSHED_SHA, PUSHED_SHA_ABBREVIATED)).toBe(true);
  });

  test("a sha that is not a prefix still fails to match, and the timeout names it", async () => {
    const deps = makePushLagDeps(0, { pushEverLands: false });

    const result = await sessionPrWaitForReview(
      { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 10, expectedHeadSha: "deadbeef" },
      deps
    );

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.expectedHeadShaUnreached).toEqual({
        expected: "deadbeef",
        lastObservedHeadSha: STALE_SHA,
        classification: "push-pending",
      });
    }
  });

  test("a too-short value is REJECTED up front, not matched promiscuously", async () => {
    const deps = makePushLagDeps(2, { pushEverLands: true });

    await expect(
      sessionPrWaitForReview(
        { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 60, expectedHeadSha: "630" },
        deps
      )
    ).rejects.toThrow(/at least 7 characters/);
  });

  test("a non-hex value is REJECTED — it could only ever suppress", async () => {
    const deps = makePushLagDeps(2, { pushEverLands: true });

    await expect(
      sessionPrWaitForReview(
        { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 60, expectedHeadSha: "not-a-sha!" },
        deps
      )
    ).rejects.toThrow(/hexadecimal commit sha/);
  });
});

describe("headShaMatchesExpected (mt#4039)", () => {
  test("an undefined on either side means no opinion, and matches", () => {
    expect(headShaMatchesExpected(PUSHED_SHA, undefined)).toBe(true);
    expect(headShaMatchesExpected(undefined, PUSHED_SHA)).toBe(true);
    expect(headShaMatchesExpected(undefined, undefined)).toBe(true);
  });

  test("an exact full sha still matches — the fix widens, it does not replace", () => {
    expect(headShaMatchesExpected(PUSHED_SHA, PUSHED_SHA)).toBe(true);
    expect(headShaMatchesExpected(PUSHED_SHA, STALE_SHA)).toBe(false);
  });

  test("comparison is case-insensitive and tolerates surrounding whitespace", () => {
    expect(headShaMatchesExpected(PUSHED_SHA, PUSHED_SHA.slice(0, 9).toUpperCase())).toBe(true);
    expect(headShaMatchesExpected(PUSHED_SHA, `  ${PUSHED_SHA.slice(0, 9)}  `)).toBe(true);
  });

  test("below the minimum abbreviation it never matches, even as a real prefix", () => {
    // Defense in depth behind the command-layer rejection: a 6-char prefix of
    // the head is still refused, so no caller reaching the matcher by another
    // path can match on a collision-prone stub.
    expect(PUSHED_SHA.startsWith(PUSHED_SHA.slice(0, 6))).toBe(true);
    expect(headShaMatchesExpected(PUSHED_SHA, PUSHED_SHA.slice(0, 6))).toBe(false);
    expect(MIN_ABBREVIATED_SHA_LENGTH).toBe(7);
  });

  test("a value longer than the head cannot be a prefix of it", () => {
    expect(headShaMatchesExpected(PUSHED_SHA.slice(0, 10), PUSHED_SHA)).toBe(false);
  });
});
