/**
 * Tests for fetchPostedReviews (mt#2829): in-band read of posted PR review
 * prose. Covers the spec's acceptance tests:
 *  - PR with 2 review rounds → tool returns both, bodies intact, ordered
 *  - PR with zero reviews → empty list, not error
 *  - The PR #1893 shape: a CHANGES_REQUESTED review's prose is retrievable
 *    even when the structured findings channel was empty
 * Plus the mt#2656/mt#2817 payload-trimming discipline (bodies capped with
 * an explicit, loud truncation marker + boolean flag — never a silent cut).
 */
import { describe, expect, test } from "bun:test";
import {
  fetchPostedReviews,
  MAX_COMMENT_BODY_CHARS,
  MAX_REVIEW_BODY_CHARS,
} from "./pr-get-reviews";
import type {
  PostedReviewComment,
  RepositoryBackend,
  ReviewListEntry,
} from "../../repository/index";

/** Shared reviewer-bot login literal (extracted per custom/no-magic-string-duplication). */
const REVIEWER_BOT = "minsky-reviewer[bot]";
/** Shared review-state literals (extracted per custom/no-magic-string-duplication). */
const CHANGES_REQUESTED_STATE = "CHANGES_REQUESTED" as const;
const APPROVED_STATE = "APPROVED" as const;
/** Shared comment-anchor path literal (extracted per custom/no-magic-string-duplication). */
const COMMENT_PATH = "src/foo.ts";
/** Shared placeholder body literal for tests that don't care about body content (extracted per custom/no-magic-string-duplication). */
const PLACEHOLDER_BODY = "body";

function mkReview(overrides: Partial<ReviewListEntry>): ReviewListEntry {
  return {
    reviewId: 1,
    state: "COMMENTED",
    submittedAt: "2026-07-15T10:00:00Z",
    reviewerLogin: REVIEWER_BOT,
    body: "",
    ...overrides,
  };
}

function mkComment(overrides: Partial<PostedReviewComment>): PostedReviewComment {
  return {
    commentId: 1,
    reviewId: 1,
    path: COMMENT_PATH,
    line: 42,
    originalLine: 42,
    body: "",
    ...overrides,
  };
}

function mkBackend(opts: {
  listReviews?: (prIdentifier: string | number) => Promise<ReviewListEntry[]>;
  listReviewComments?: (prIdentifier: string | number) => Promise<PostedReviewComment[]>;
}): RepositoryBackend {
  return {
    review: {
      approve: async () => ({}) as never,
      getApprovalStatus: async () => ({}) as never,
      listReviews: opts.listReviews,
      listReviewComments: opts.listReviewComments,
    },
  } as unknown as RepositoryBackend;
}

describe("fetchPostedReviews", () => {
  test("two review rounds: both returned, bodies intact, in submission order", async () => {
    const round1 = mkReview({
      reviewId: 101,
      state: CHANGES_REQUESTED_STATE,
      submittedAt: "2026-07-15T10:00:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "## Spec verification\n\nFound 2 issues.\n\n## Findings\n\n- [BLOCKING] src/foo.ts:10 — missing null check",
    });
    const round2 = mkReview({
      reviewId: 202,
      state: APPROVED_STATE,
      submittedAt: "2026-07-15T11:30:00Z",
      reviewerLogin: REVIEWER_BOT,
      body: "## Spec verification\n\nAll criteria met.",
    });

    const backend = mkBackend({
      listReviews: async () => [round1, round2],
      listReviewComments: async () => [
        mkComment({
          commentId: 1,
          reviewId: 101,
          path: COMMENT_PATH,
          line: 10,
          originalLine: 10,
          body: "add a null check here",
        }),
        mkComment({
          commentId: 2,
          reviewId: 202,
          path: "src/bar.ts",
          line: 5,
          body: "nit: rename this",
        }),
      ],
    });

    const result = await fetchPostedReviews(backend, 1893);

    expect(result).toHaveLength(2);
    expect(result[0]?.reviewId).toBe(101);
    expect(result[0]?.state).toBe(CHANGES_REQUESTED_STATE);
    expect(result[0]?.body).toBe(round1.body);
    expect(result[0]?.bodyTruncated).toBe(false);
    expect(result[0]?.comments).toEqual([
      {
        path: COMMENT_PATH,
        line: 10,
        originalLine: 10,
        body: "add a null check here",
        bodyTruncated: false,
      },
    ]);

    expect(result[1]?.reviewId).toBe(202);
    expect(result[1]?.state).toBe(APPROVED_STATE);
    expect(result[1]?.body).toBe(round2.body);
    expect(result[1]?.comments).toHaveLength(1);
    expect(result[1]?.comments[0]?.path).toBe("src/bar.ts");

    // Ordering: round1 before round2 (submission order — mirrors listReviews's
    // own chronological contract; this test asserts the composition doesn't
    // reorder what the backend already returns in order).
    expect(result.map((r) => r.reviewId)).toEqual([101, 202]);
  });

  test("zero reviews: returns an empty list, not an error", async () => {
    const backend = mkBackend({
      listReviews: async () => [],
      listReviewComments: async () => [],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result).toEqual([]);
  });

  test("backend with no listReviews support: returns an empty list, not an error", async () => {
    const backend = mkBackend({});

    const result = await fetchPostedReviews(backend, 1);

    expect(result).toEqual([]);
  });

  test("backend with no listReviewComments support: reviews still returned, with empty comments", async () => {
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: "approved, nice work" })],
      // listReviewComments intentionally omitted
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe("approved, nice work");
    expect(result[0]?.comments).toEqual([]);
  });

  // mt#2829 acceptance test: verify on the PR #1893 shape — a
  // CHANGES_REQUESTED review's prose is retrievable even when the structured
  // findings channel was empty (the originating incident: the reviewer
  // posted CHANGES_REQUESTED with zero structured findings, but real prose
  // in the body; the agent had no in-band way to read it).
  test("CHANGES_REQUESTED review with empty structured findings channel: body prose still retrievable", async () => {
    const defectiveVerdictBody =
      "I have concerns about this change but did not use the findings tool to " +
      "report them. Please reconsider the approach to error handling.";
    const backend = mkBackend({
      listReviews: async () => [
        mkReview({
          reviewId: 1893,
          state: CHANGES_REQUESTED_STATE,
          body: defectiveVerdictBody,
        }),
      ],
      listReviewComments: async () => [],
    });

    const result = await fetchPostedReviews(backend, 1893);

    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe(CHANGES_REQUESTED_STATE);
    expect(result[0]?.body).toBe(defectiveVerdictBody);
    expect(result[0]?.comments).toEqual([]);
  });

  test("works for a human review as well as a bot review (reviewerLogin passthrough)", async () => {
    const backend = mkBackend({
      listReviews: async () => [
        mkReview({ reviewId: 1, reviewerLogin: "edobry", state: APPROVED_STATE, body: "lgtm" }),
      ],
      listReviewComments: async () => [],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]?.reviewerLogin).toBe("edobry");
  });

  test("payload trimming (mt#2656/mt#2817): an enormous review body is capped with a loud, explicit marker", async () => {
    const hugeBody = "x".repeat(MAX_REVIEW_BODY_CHARS + 500);
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: hugeBody })],
      listReviewComments: async () => [],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]?.bodyTruncated).toBe(true);
    expect(result[0]?.body.length).toBeLessThan(hugeBody.length);
    expect(result[0]?.body).toContain("[TRUNCATED:");
    expect(result[0]?.body).toContain(`${hugeBody.length} chars`);
  });

  test("payload trimming: a review body within the cap is not truncated", async () => {
    const normalBody = "a reasonably sized review body";
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: normalBody })],
      listReviewComments: async () => [],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]?.bodyTruncated).toBe(false);
    expect(result[0]?.body).toBe(normalBody);
  });

  test("payload trimming: an enormous inline comment body is capped with a loud, explicit marker", async () => {
    const hugeCommentBody = "y".repeat(MAX_COMMENT_BODY_CHARS + 200);
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: "see inline comments" })],
      listReviewComments: async () => [
        mkComment({ commentId: 1, reviewId: 1, body: hugeCommentBody }),
      ],
    });

    const result = await fetchPostedReviews(backend, 1);

    const comment = result[0]?.comments[0];
    expect(comment?.bodyTruncated).toBe(true);
    expect(comment?.body.length).toBeLessThan(hugeCommentBody.length);
    expect(comment?.body).toContain("[TRUNCATED:");
  });

  test("diffs are never part of the payload shape (no diff/patch field on review or comment)", async () => {
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: PLACEHOLDER_BODY })],
      listReviewComments: async () => [mkComment({ commentId: 1, reviewId: 1, body: "comment" })],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]).not.toHaveProperty("diff");
    expect(result[0]?.comments[0]).not.toHaveProperty("diff");
    expect(result[0]?.comments[0]).not.toHaveProperty("diffHunk");
  });

  test("a comment with reviewId null is not attached to any review", async () => {
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: PLACEHOLDER_BODY })],
      listReviewComments: async () => [
        mkComment({ commentId: 1, reviewId: null, body: "orphaned comment" }),
      ],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]?.comments).toEqual([]);
  });

  test("an outdated inline comment (line null) carries originalLine for recovery", async () => {
    const backend = mkBackend({
      listReviews: async () => [mkReview({ reviewId: 1, body: PLACEHOLDER_BODY })],
      listReviewComments: async () => [
        mkComment({ commentId: 1, reviewId: 1, line: null, originalLine: 7, body: "stale anchor" }),
      ],
    });

    const result = await fetchPostedReviews(backend, 1);

    expect(result[0]?.comments[0]?.line).toBeNull();
    expect(result[0]?.comments[0]?.originalLine).toBe(7);
  });
});
