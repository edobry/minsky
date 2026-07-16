/**
 * Posted PR reviews composition (mt#2829)
 *
 * In-band read of posted GitHub review prose: composes `ReviewOperations.listReviews`
 * (top-level review metadata + full body) with `ReviewOperations.listReviewComments`
 * (per-review inline diff comments) into a single ordered list, so an agent
 * diagnosing a defective or silent reviewer verdict can read exactly what was
 * posted — without a blind `reviewer_retrigger`.
 *
 * Payload trimming discipline (mt#2656): bodies are INCLUDED (that's the point
 * of this read) but capped if enormous, with the truncation stated loudly in
 * the body itself plus a boolean flag (the mt#2817 loud-caps convention — an
 * explicit truncation signal, never a silent cut). Diffs are never included.
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";
import type {
  RepositoryBackend,
  ReviewListEntry,
  PostedReviewComment,
} from "../../repository/index";

/**
 * Cap on a review's top-level body. Review bodies can legitimately run long
 * (structured spec-verification tables, multi-finding prose) so the cap is
 * generous relative to `MAX_COMMENT_BODY_CHARS`.
 */
export const MAX_REVIEW_BODY_CHARS = 20_000;

/**
 * Cap on a single inline comment's body. Inline comments are normally a
 * sentence or two; a comment this long is unusual and worth trimming.
 */
export const MAX_COMMENT_BODY_CHARS = 4_000;

export interface PostedReviewInlineComment {
  path: string;
  /** Current diff line (1-based); `null` when the anchor is outdated. */
  line: number | null;
  /** Line at comment-creation time; present even when `line` is `null`. */
  originalLine: number | null;
  body: string;
  /** True when `body` was cut to `MAX_COMMENT_BODY_CHARS` — see the appended `[TRUNCATED: ...]` marker in `body` itself. */
  bodyTruncated: boolean;
}

export interface PostedReview {
  reviewId: number;
  reviewerLogin: string | null;
  state: ReviewListEntry["state"];
  /** ISO-8601 submission timestamp (absent for a still-PENDING draft). */
  submittedAt?: string;
  htmlUrl?: string;
  /** Full review body text (may be trimmed — see `bodyTruncated`). */
  body: string;
  /** True when `body` was cut to `MAX_REVIEW_BODY_CHARS` — see the appended `[TRUNCATED: ...]` marker in `body` itself. */
  bodyTruncated: boolean;
  /** Inline diff comments submitted with this review, in listing order. */
  comments: PostedReviewInlineComment[];
}

/**
 * Trim a body to `maxChars`, appending a loud, explicit truncation marker
 * (mt#2817 convention: state truncation in the payload, never cut silently)
 * naming the original length so a caller knows how much was dropped.
 */
function truncateBody(body: string, maxChars: number): { body: string; truncated: boolean } {
  if (body.length <= maxChars) {
    return { body, truncated: false };
  }
  const kept = safeTruncate(body, maxChars, "head");
  return {
    body:
      `${kept}\n\n[TRUNCATED: full body is ${body.length} chars; showing first ${maxChars}. ` +
      `mt#2829 payload-trimming cap per mt#2656.]`,
    truncated: true,
  };
}

/**
 * Compose posted GitHub reviews + their inline comments into the mt#2829
 * `session_pr_get(reviews: true)` payload shape.
 *
 * Returns reviews in the order `ReviewOperations.listReviews` returns them
 * (GitHub: chronological by submission — i.e. submission order, multiple
 * rounds included). Returns `[]` (not an error) when the backend supports no
 * reviews API, or the PR genuinely has zero reviews.
 */
export async function fetchPostedReviews(
  backend: RepositoryBackend,
  prNumber: number
): Promise<PostedReview[]> {
  if (!backend.review.listReviews) {
    return [];
  }

  const [reviews, comments] = await Promise.all([
    backend.review.listReviews(prNumber),
    backend.review.listReviewComments
      ? backend.review.listReviewComments(prNumber)
      : Promise.resolve<PostedReviewComment[]>([]),
  ]);

  const commentsByReview = new Map<number, PostedReviewComment[]>();
  for (const comment of comments) {
    if (comment.reviewId === null) continue;
    const list = commentsByReview.get(comment.reviewId) ?? [];
    list.push(comment);
    commentsByReview.set(comment.reviewId, list);
  }

  return reviews.map((review): PostedReview => {
    const trimmedBody = truncateBody(review.body, MAX_REVIEW_BODY_CHARS);
    const reviewComments = (commentsByReview.get(review.reviewId) ?? []).map(
      (comment): PostedReviewInlineComment => {
        const trimmedComment = truncateBody(comment.body, MAX_COMMENT_BODY_CHARS);
        return {
          path: comment.path,
          line: comment.line,
          originalLine: comment.originalLine,
          body: trimmedComment.body,
          bodyTruncated: trimmedComment.truncated,
        };
      }
    );

    return {
      reviewId: review.reviewId,
      reviewerLogin: review.reviewerLogin,
      state: review.state,
      submittedAt: review.submittedAt,
      htmlUrl: review.htmlUrl,
      body: trimmedBody.body,
      bodyTruncated: trimmedBody.truncated,
      comments: reviewComments,
    };
  });
}
