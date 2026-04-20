/**
 * GitHub PR review submission operations.
 *
 * Contains: submitReview — posts a review (APPROVE, COMMENT, REQUEST_CHANGES)
 * to a GitHub pull request using the service-account / bot token.
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
