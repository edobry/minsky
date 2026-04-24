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
