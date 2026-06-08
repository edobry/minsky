/**
 * Guarded review submission (mt#2350).
 *
 * Wraps `submitReview` with the two mt#2350 guards so the single inline-comment
 * submission site in `runReview` stays lean:
 *
 *  1. Inline-comment anchor pre-validation (Part 1) — partitions composed inline
 *     comments against the PR diff and demotes unanchorable ones into the review
 *     body, so a single unresolvable anchor no longer 422s the whole review.
 *  2. Non-retryable-submission-failure recording (Part 2) — on a non-retryable
 *     (4xx) failure, records the failure for the sweeper circuit breaker and
 *     re-throws (preserving the existing bubble-up); on success, clears any
 *     prior failure state for the (PR, head_sha).
 *
 * Owned by the reviewer service. No imports from src/.
 */

import type { Octokit } from "@octokit/rest";
import { submitReview, type ReviewInlineComment, type SubmittedReview } from "./github-client";
import type { ComposedInlineComment } from "./compose-review";
import type { ReviewerDb } from "./db/client";
import {
  parseRightSideAnchorableLines,
  partitionInlineComments,
  formatUnanchoredFindings,
} from "./anchor-validation";
import {
  classifySubmissionError,
  recordSubmissionFailure,
  clearSubmissionFailures,
} from "./submission-failure-tracker";
import { log } from "./logger";

export interface GuardedSubmitInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /** Annotated review body (the unanchored-findings section is appended here). */
  body: string;
  /** Composed inline comments (file/line/body/inReplyTo) from compose-review. */
  composedInlineComments: ComposedInlineComment[];
  /** Full PR unified diff, used to resolve RIGHT-side anchors. */
  diff: string;
  /** PR head SHA (the circuit-breaker key). */
  headSha: string;
  /** Per-call GitHub timeout. */
  timeoutMs: number;
  /** Reviewer DB (circuit-breaker state). When absent, recording is skipped. */
  db?: ReviewerDb;
}

/**
 * Submit a review with anchor pre-validation and circuit-breaker recording.
 *
 * Throws the original submission error on failure (after best-effort recording)
 * so the existing webhook/sweeper bubble-up behavior is preserved.
 */
export async function submitReviewWithGuards(input: GuardedSubmitInput): Promise<SubmittedReview> {
  const { octokit, owner, repo, prNumber, event, headSha, timeoutMs, db } = input;
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  // Map composed inline comments (file/line/body/inReplyTo) to the submitReview
  // shape (mt#1345).
  const mappedInlineComments: ReviewInlineComment[] = input.composedInlineComments.map((c) => ({
    path: c.file,
    line: c.line,
    body: c.body,
    ...(c.inReplyTo !== undefined ? { inReplyTo: c.inReplyTo } : {}),
  }));

  // Part 1: pre-validate anchors. A single unresolvable RIGHT-side anchor 422s
  // the ENTIRE createReview payload ("Line could not be resolved"), losing the
  // whole review (PR #1602, PR #1115). Demote unanchorable comments to the body.
  const anchorable = parseRightSideAnchorableLines(input.diff);
  const { anchored, unanchored } = partitionInlineComments(mappedInlineComments, anchorable);
  if (unanchored.length > 0) {
    log.warn("reviewer.inline_comments_demoted", {
      event: "reviewer.inline_comments_demoted",
      prUrl,
      sha: headSha,
      demotedCount: unanchored.length,
      anchoredCount: anchored.length,
      demoted: unanchored.map((c) => `${c.path}:${c.line}`),
    });
  }
  const reviewBody = input.body + formatUnanchoredFindings(unanchored);
  const inlineCommentsForSubmit: ReviewInlineComment[] | undefined =
    anchored.length > 0 ? anchored : undefined;

  let review: SubmittedReview;
  try {
    review = await submitReview(
      octokit,
      owner,
      repo,
      prNumber,
      event,
      reviewBody,
      timeoutMs,
      inlineCommentsForSubmit
    );
  } catch (submitErr) {
    // Part 2: record a non-retryable failure for the sweeper circuit breaker,
    // then re-throw to preserve the existing bubble-up (webhook handler records
    // failed_at_reviewer; sweeper catch-logs sweeper.retrigger_failed).
    const classified = classifySubmissionError(submitErr);
    if (classified !== null && !classified.retryable && db !== undefined) {
      await recordSubmissionFailure(db, {
        owner,
        repo,
        prNumber,
        headSha,
        errorClass: classified.class,
        status: classified.status,
        message: classified.message,
      });
    }
    throw submitErr;
  }

  // A successful submission clears any prior non-retryable-failure state for
  // this (PR, head_sha) so a recovered HEAD re-opens the retrigger path.
  if (db !== undefined) {
    await clearSubmissionFailures(db, { owner, repo, prNumber, headSha });
  }

  return review;
}
