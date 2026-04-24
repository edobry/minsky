/**
 * GitHub PR review operations.
 *
 * Contains:
 * - submitReview — posts a review (APPROVE, COMMENT, REQUEST_CHANGES)
 * - dismissReview — dismisses a stale or superseded review
 *
 * Both route through the service-account / bot token via `gh.getToken()`
 * (TokenProvider-aware).
 */

import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";
import { handleOctokitError } from "./github-error-handler";
import {
  type GitHubContext,
  createOctokit,
  resolvePRNumber,
  findPRNumberForBranch,
} from "./github-pr-operations";
import type { ReviewListEntry } from "./index";

export interface ReviewComment {
  /** Relative path of the file to comment on */
  path: string;
  /** Line number in the file (1-based) */
  line: number;
  /** Review comment body */
  body: string;
  /** Which side of a diff hunk to attach the comment to (default: RIGHT) */
  side?: "LEFT" | "RIGHT";
}

export interface SubmitReviewOptions {
  /** Review body text (overall comment) */
  body: string;
  /** Review event type */
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  /** Optional inline (line-level) comments */
  comments?: ReviewComment[];
}

export interface SubmitReviewResult {
  /** GitHub review ID */
  reviewId: number;
  /** Web URL of the submitted review */
  htmlUrl: string;
}

/**
 * Submit a review on a GitHub pull request.
 *
 * Uses `octokit.rest.pulls.createReview()` which accepts body, event, and an
 * optional inline-comments array in a single REST call — no GraphQL needed.
 *
 * Auth goes through `gh.getToken()` which honours the TokenProvider's service
 * account when one is configured, posting the review under the bot identity.
 */
export async function submitReview(
  gh: GitHubContext,
  prIdentifier: string | number,
  options: SubmitReviewOptions
): Promise<SubmitReviewResult> {
  const prNumber = await resolvePRNumber(prIdentifier, gh, async (branch) => {
    const token = await gh.getToken();
    const ok = createOctokit(token);
    return findPRNumberForBranch(branch, gh, ok);
  });

  try {
    const token = await gh.getToken();
    const octokit = createOctokit(token);

    // Validate PR is open before submitting
    const prResponse = await octokit.rest.pulls.get({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
    });

    if (prResponse.data.state !== "open") {
      throw new MinskyError(
        `Pull request #${prNumber} is not open (current state: ${prResponse.data.state})`
      );
    }

    // Map our ReviewComment[] to the shape expected by the Octokit REST API.
    // The API accepts { path, line, body, side } directly.
    const apiComments = options.comments?.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
      side: (c.side ?? "RIGHT") as "LEFT" | "RIGHT",
    }));

    const reviewResponse = await octokit.rest.pulls.createReview({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      body: options.body,
      event: options.event,
      ...(apiComments && apiComments.length > 0 ? { comments: apiComments } : {}),
    });

    const review = reviewResponse.data;

    log.info("GitHub PR review submitted successfully", {
      prNumber,
      reviewId: review.id,
      event: options.event,
      owner: gh.owner,
      repo: gh.repo,
    });

    return {
      reviewId: review.id,
      htmlUrl: review.html_url,
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "submit pull request review",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
    // handleOctokitError always throws; this satisfies TypeScript
    throw error;
  }
}

export interface DismissReviewOptions {
  /** Reason / message shown on the dismissed review (required by GitHub API) */
  message: string;
}

export interface DismissReviewResult {
  /** GitHub review ID that was dismissed */
  reviewId: number;
  /** Web URL of the dismissed review */
  htmlUrl: string;
  /** Final state after dismissal (expected: "DISMISSED") */
  state: string;
}

/**
 * Dismiss a review on a GitHub pull request.
 *
 * Uses `octokit.rest.pulls.dismissReview()` which requires a message
 * explaining the dismissal. The message is stored by GitHub and shown
 * in the review history.
 *
 * Auth goes through `gh.getToken()` which honours the TokenProvider's
 * service account when one is configured — so the dismissal is recorded
 * under the bot identity (or the user identity when appropriate).
 *
 * @see mt#1142 — structural fix for stale-adversarial-review cleanup
 */
export async function dismissReview(
  gh: GitHubContext,
  prIdentifier: string | number,
  reviewId: number,
  options: DismissReviewOptions
): Promise<DismissReviewResult> {
  if (!options.message || options.message.trim().length === 0) {
    throw new MinskyError(
      "dismissReview requires a non-empty message explaining the dismissal " +
        "(the GitHub API rejects empty messages, and readers need to know why " +
        "a review was dismissed)."
    );
  }

  const prNumber = await resolvePRNumber(prIdentifier, gh, async (branch) => {
    const token = await gh.getToken();
    const ok = createOctokit(token);
    return findPRNumberForBranch(branch, gh, ok);
  });

  try {
    const token = await gh.getToken();
    const octokit = createOctokit(token);

    const response = await octokit.rest.pulls.dismissReview({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      review_id: reviewId,
      message: options.message,
      event: "DISMISS",
    });

    const dismissed = response.data;

    log.info("GitHub PR review dismissed successfully", {
      prNumber,
      reviewId: dismissed.id,
      state: dismissed.state,
      owner: gh.owner,
      repo: gh.repo,
    });

    return {
      reviewId: dismissed.id,
      htmlUrl: dismissed.html_url,
      state: dismissed.state,
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "dismiss pull request review",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
    throw error;
  }
}

/**
 * List all reviews on a GitHub pull request, across all pages.
 *
 * Uses `octokit.paginate` against `octokit.rest.pulls.listReviews` so the
 * call returns every review on the PR, not just the first 30 (GitHub's
 * default page size). Iteration-heavy callers (e.g., the wait-for-review
 * poller) rely on this because GitHub returns reviews in chronological
 * order (oldest first): without pagination, a PR with many historical
 * reviews would never surface a newly-posted one.
 *
 * Auth goes through `gh.getToken()` (TokenProvider-aware). This is a
 * read-only listing — no identity mutation, no comments posted.
 */
export async function listReviews(
  gh: GitHubContext,
  prIdentifier: string | number
): Promise<ReviewListEntry[]> {
  const prNumber = await resolvePRNumber(prIdentifier, gh, async (branch) => {
    const token = await gh.getToken();
    const ok = createOctokit(token);
    return findPRNumberForBranch(branch, gh, ok);
  });

  try {
    const token = await gh.getToken();
    const octokit = createOctokit(token);

    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    log.debug("GitHub PR reviews listed", {
      prNumber,
      reviewCount: reviews.length,
      owner: gh.owner,
      repo: gh.repo,
    });

    return reviews.map((r): ReviewListEntry => {
      // Normalize GitHub's free-form state string to the ReviewListEntry union.
      // Unknown states fall through to COMMENTED (the most neutral option)
      // rather than throwing — listing must never fail on a single odd row.
      const normalizedState: ReviewListEntry["state"] =
        r.state === "APPROVED" ||
        r.state === "CHANGES_REQUESTED" ||
        r.state === "COMMENTED" ||
        r.state === "DISMISSED" ||
        r.state === "PENDING"
          ? r.state
          : "COMMENTED";
      return {
        reviewId: r.id,
        state: normalizedState,
        submittedAt: r.submitted_at ?? undefined,
        reviewerLogin: r.user?.login ?? null,
        body: r.body ?? "",
        htmlUrl: r.html_url,
      };
    });
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "list pull request reviews",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
    throw error;
  }
}
