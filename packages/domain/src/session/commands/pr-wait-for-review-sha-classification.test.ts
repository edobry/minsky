/**
 * Classifying a FAILED `expectedHeadSha` match (mt#4995).
 *
 * mt#3877 added the head filter and mt#4039 made it prefix-anchored, so a
 * mismatch is now reported honestly — but reported the SAME WAY whatever caused
 * it. Two causes hide behind that one report and they call for opposite
 * responses: a commit still in flight arrives if you wait, and a sha the caller
 * constructed never does. Today both spend the full `timeoutSeconds` and end in
 * `expectedHeadShaUnreached`, which per `/implement-task` §9 reads like reviewer
 * silence — the documented lead-in to the bypass ladder.
 *
 * The originating incident (2026-09-04, PR #3635 / mt#4897) is the fixture
 * below: `session_commit` returned the 9-character `f76e55628`, and the caller
 * passed those 9 real characters plus 31 invented ones, believing the parameter
 * needed a full 40-character sha. It does not — `headShaMatchesExpected` matches
 * a prefix by design. The value was hexadecimal and well over the 7-character
 * floor, so both existing boundary checks admitted it, and only comparison
 * against the observed head could ever have caught it.
 *
 * Lives in its own file rather than in `pr-wait-for-review-push-lag.test.ts`
 * for that file's own stated reason (mem#833): it sits near the 400-line
 * `max-lines` WARN threshold, and this repo's zero-tolerance ESLint warning gate
 * (mt#1097) makes a warning unshippable — so extract a sibling rather than shave
 * lines out of a file to buy margin the next merge consumes.
 */
import { describe, expect, test } from "bun:test";
import {
  MIN_ABBREVIATED_SHA_LENGTH,
  classifyHeadShaMismatch,
  sessionPrWaitForReview,
  type SessionPrWaitForReviewDependencies,
} from "./pr-wait-for-review-subcommand";
import type { ReviewListEntry, RepositoryBackend } from "../../repository/index";
import type { SessionProviderInterface, SessionRecord } from "../types";

/** The real head on PR #3635, which the remote served throughout. */
const OBSERVED_HEAD = "f76e556281b76e51949a057834f279e73d03a8e0";
/** What `session_commit` actually returned — a true prefix of the above. */
const TRUE_ABBREVIATION = "f76e55628";
/** What the caller passed: the 9 real characters, then 31 invented ones. */
const FABRICATED = "f76e556285ff4d6a4e0d21b0ba1e0a54ba7d2e0f";
/** An unrelated commit — the shape a push that has not landed yet produces. */
const UNRELATED = "0123456789abcdef0123456789abcdef01234567";

const DIVERGENT_PREFIX = "divergent-prefix" as const;
const PUSH_PENDING = "push-pending" as const;

const review: ReviewListEntry = {
  reviewId: 7,
  state: "APPROVED" as const,
  submittedAt: "2026-09-04T21:19:00Z",
  reviewerLogin: "minsky-reviewer[bot]",
  body: "",
  commitId: OBSERVED_HEAD,
};

/**
 * The remote serves `OBSERVED_HEAD` forever, with a review of it already
 * posted. Nothing here is in flight — the only variable across these tests is
 * the sha the CALLER supplied.
 *
 * @param opts.withHeadSha when false the backend has no `getPullRequestHeadSha`
 * at all, which is AT4: nothing is ever observed, so nothing can be classified.
 */
function makeDeps(opts: { withHeadSha: boolean }): SessionPrWaitForReviewDependencies {
  let clock = 1_000_000;

  const sessionRecord = {
    session: "s",
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(0).toISOString(),
    pullRequest: { number: 3635, branch: "task/mt-4897", baseBranch: "main" },
    taskId: "mt#4995",
  } as unknown as SessionRecord;

  const backend = {
    review: {
      listReviews: async () => [review],
      getPullRequestCreatedAt: async () => new Date(0).toISOString(),
      ...(opts.withHeadSha ? { getPullRequestHeadSha: async () => OBSERVED_HEAD } : {}),
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

const waitWith = async (expectedHeadSha: string | undefined, withHeadSha = true) =>
  sessionPrWaitForReview(
    { sessionId: "s", intervalSeconds: 5, timeoutSeconds: 600, expectedHeadSha },
    makeDeps({ withHeadSha })
  );

describe("classifyHeadShaMismatch (mt#4995)", () => {
  test("the originating incident classifies as divergent-prefix", () => {
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, FABRICATED)).toBe(DIVERGENT_PREFIX);
  });

  test("an unrelated sha is push-pending — the wait-it-out case", () => {
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, UNRELATED)).toBe(PUSH_PENDING);
  });

  test("a value that MATCHES is not a mismatch at all", () => {
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, TRUE_ABBREVIATION)).toBeNull();
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, OBSERVED_HEAD)).toBeNull();
  });

  test("an absent side yields no classification, never a guess", () => {
    // AT4's unit-level half: with nothing observed there is nothing to compare,
    // and inventing a verdict here would be worse than staying silent.
    expect(classifyHeadShaMismatch(undefined, FABRICATED)).toBeNull();
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, undefined)).toBeNull();
    expect(classifyHeadShaMismatch(undefined, undefined)).toBeNull();
  });

  test("the threshold is exactly MIN_ABBREVIATED_SHA_LENGTH, checked from both sides", () => {
    // SC4: the boundary is the whole discriminator, so pin it directly rather
    // than trusting the two example shas above to sit on the right side of it.
    const head = `abcdefa${"0".repeat(33)}`;
    // Shares 7 -> at the threshold, so DIVERGENT.
    expect(classifyHeadShaMismatch(head, `abcdefa${"9".repeat(33)}`)).toBe(DIVERGENT_PREFIX);
    // Shares 6 -> below it, so the conservative branch.
    expect(classifyHeadShaMismatch(head, `abcdef9${"9".repeat(33)}`)).toBe(PUSH_PENDING);
    expect(MIN_ABBREVIATED_SHA_LENGTH).toBe(7);
  });

  test("classification normalizes case and whitespace like the matcher does", () => {
    expect(classifyHeadShaMismatch(OBSERVED_HEAD, `  ${FABRICATED.toUpperCase()}  `)).toBe(
      DIVERGENT_PREFIX
    );
  });

  test("SC4 negative control: no existing test fixture trips the discriminator", () => {
    // The sibling file's two fixtures are the shas most likely to be fed
    // through this code by accident. Neither shares a 7-character prefix, so
    // adding the classifier cannot have changed what those tests exercise.
    const staleSha = "9a3a8ca4b0000000000000000000000000000000";
    const pushedSha = "6303291ad0000000000000000000000000000000";
    expect(classifyHeadShaMismatch(staleSha, pushedSha)).toBe(PUSH_PENDING);
    expect(classifyHeadShaMismatch(staleSha, "deadbeef")).toBe(PUSH_PENDING);
  });
});

describe("sessionPrWaitForReview — mismatch classification (mt#4995)", () => {
  test("AT1: a fabricated extension returns on the first poll, not at timeout", async () => {
    const result = await waitWith(FABRICATED);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.expectedHeadShaUnreached).toEqual({
        expected: FABRICATED,
        lastObservedHeadSha: OBSERVED_HEAD,
        classification: DIVERGENT_PREFIX,
      });
      // SC2: the budget was 600s. One poll, no sleep — the conclusion was
      // available the moment a head was observed.
      expect(result.pollCount).toBe(1);
      expect(result.elapsedMs).toBeLessThan(1000);
    }
  });

  test("AT1: the review was visible all along — this was never reviewer silence", async () => {
    const result = await waitWith(FABRICATED);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      const [annotated] = result.lastSeenReviews;
      expect(annotated?.reviewId).toBe(7);
      expect(annotated?.rejectionReason).toContain("push-not-landed");
    }
  });

  test("AT2: a true abbreviated prefix still matches (mt#4039 regression)", async () => {
    const result = await waitWith(TRUE_ABBREVIATION);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.review.reviewId).toBe(7);
    }
  });

  test("AT3: a sha sharing fewer than 7 characters waits, exactly as before", async () => {
    const result = await waitWith(UNRELATED);

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.expectedHeadShaUnreached?.classification).toBe(PUSH_PENDING);
      // SC5: this is the branch mt#3877 and mt#4039 exist to protect. It must
      // still spend its budget polling — the contrast with AT1's single poll is
      // the entire behavioural claim of this task.
      expect(result.pollCount).toBeGreaterThan(50);
    }
  });

  test("AT4: with no observable head, nothing is classified and nothing is reported", async () => {
    const result = await waitWith(FABRICATED, false);

    // With no `getPullRequestHeadSha` the head filter has no opinion, so the
    // review is admitted — unchanged behaviour, and `expectedHeadShaUnreached`
    // is never constructed.
    expect(result.matched).toBe(true);
  });
});
