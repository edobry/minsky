/**
 * GitHub PR review operations.
 *
 * Contains:
 * - submitReview — posts a review (APPROVE, COMMENT, REQUEST_CHANGES)
 * - dismissReview — dismisses a stale or superseded review
 * - resolveReviewThread — marks a review thread as resolved (GraphQL-only)
 * - unresolveReviewThread — marks a resolved thread as unresolved (GraphQL-only)
 *
 * All route through the service-account / bot token via `gh.getToken()`
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
  /** Line number in the file (1-based). When startLine is set, this is the END of the range. */
  line: number;
  /** Review comment body */
  body: string;
  /**
   * Which side of a diff hunk to attach the comment to.
   *
   * Defaulting:
   *  - If startSide is provided alone, side inherits from startSide.
   *  - Otherwise side defaults to RIGHT (the head/incoming side).
   *
   * Use side: "LEFT" to comment on a deletion or pre-change code; the default
   * RIGHT will not anchor to a deleted line and GitHub may reject the payload.
   */
  side?: "LEFT" | "RIGHT";
  /**
   * First line of a multi-line comment range (1-based, inclusive).
   * Must be strictly less than `line`. When absent, the comment is single-line.
   */
  startLine?: number;
  /**
   * Diff side for the start of a multi-line range.
   * GitHub requires startSide === side when both are provided
   * (https://docs.github.com/en/rest/pulls/comments).
   * When startLine is set and side is omitted, side is inferred from startSide
   * (and vice versa) so the resulting payload is always consistent.
   */
  startSide?: "LEFT" | "RIGHT";
}

/**
 * Validate a ReviewComment's multi-line range fields before forwarding to the GitHub API.
 *
 * Rules (from GitHub API docs:
 *   https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request):
 *  - If startLine is present, line must be strictly greater than startLine.
 *  - If startSide is present and side is provided, they must be equal — GitHub
 *    requires both sides of a multi-line range to anchor on the same diff side.
 *    Mismatched sides return 422 Unprocessable Entity.
 *
 * @throws MinskyError with a descriptive message when a constraint is violated.
 */
export function validateReviewComment(comment: ReviewComment): void {
  if (comment.startLine !== undefined) {
    if (comment.startLine >= comment.line) {
      throw new MinskyError(
        `Invalid multi-line comment range: startLine (${comment.startLine}) must be ` +
          `strictly less than line (${comment.line}) on path "${comment.path}".`
      );
    }
  }

  if (comment.startSide !== undefined && comment.side !== undefined) {
    if (comment.startSide !== comment.side) {
      throw new MinskyError(
        `Invalid multi-line comment: startSide ("${comment.startSide}") must equal ` +
          `side ("${comment.side}") on path "${comment.path}". GitHub rejects mismatched sides.`
      );
    }
  }
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

    // Validate all comments before touching the network.
    if (options.comments) {
      for (const comment of options.comments) {
        validateReviewComment(comment);
      }
    }

    // Map our ReviewComment[] to the shape expected by the Octokit REST API.
    // The API accepts { path, line, body, side, start_line, start_side }.
    //
    // Side defaulting:
    //   - If side is provided, use it.
    //   - Else if startSide is provided (multi-line range), use it — this keeps
    //     side and start_side consistent so callers can't accidentally produce
    //     a mismatched payload by setting only startSide.
    //   - Else default to RIGHT.
    //
    // Multi-line fields are spread conditionally so they are absent (not undefined)
    // on single-line comments — Octokit serializes undefined as null on some
    // endpoints, and GitHub rejects null start_line.
    const apiComments = options.comments?.map((c) => {
      const resolvedSide = (c.side ?? c.startSide ?? "RIGHT") as "LEFT" | "RIGHT";
      return {
        path: c.path,
        line: c.line,
        body: c.body,
        side: resolvedSide,
        ...(c.startLine !== undefined
          ? {
              start_line: c.startLine,
              start_side: (c.startSide ?? resolvedSide) as "LEFT" | "RIGHT",
            }
          : {}),
      };
    });

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

    return reviews.flatMap((r): ReviewListEntry[] => {
      // Only surface reviews whose state is one we recognize. Unknown states
      // (e.g., a future GitHub state we haven't mapped yet) are skipped
      // rather than coerced — coercing to COMMENTED would let the wait-for-
      // review tool falsely match on them. Log a warning so an operator can
      // notice if GitHub introduces a new state we should handle.
      const state = r.state;
      if (
        state !== "APPROVED" &&
        state !== "CHANGES_REQUESTED" &&
        state !== "COMMENTED" &&
        state !== "DISMISSED" &&
        state !== "PENDING"
      ) {
        log.warn("GitHub review returned unrecognized state; skipping", {
          prNumber,
          reviewId: r.id,
          state,
        });
        return [];
      }
      return [
        {
          reviewId: r.id,
          state,
          submittedAt: r.submitted_at ?? undefined,
          reviewerLogin: r.user?.login ?? null,
          body: r.body ?? "",
          htmlUrl: r.html_url,
        },
      ];
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

// ── GraphQL thread resolution mutations ─────────────────────────────────────

/**
 * GraphQL response shape for resolveReviewThread and unresolveReviewThread.
 */
interface ResolveThreadResponse {
  resolveReviewThread?: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

interface UnresolveThreadResponse {
  unresolveReviewThread?: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

const UNRESOLVE_REVIEW_THREAD_MUTATION = `
  mutation UnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

/**
 * Resolve a GitHub PR review thread.
 *
 * GitHub REST API does not expose review-thread resolution; this is a
 * GraphQL-only mutation (`resolveReviewThread`). The `threadId` is the
 * node ID returned by `PullRequestReviewThread.id` in the GraphQL API
 * (also surfaced in `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments`
 * as `node_id` on each comment's thread).
 *
 * Auth goes through `gh.getToken()` — the same TokenProvider path as other
 * forge mutations — so the resolution is recorded under the bot identity.
 *
 * @param gh     GitHub context (owner, repo, getToken).
 * @param threadId  GraphQL node ID of the `PullRequestReviewThread` to resolve.
 */
export async function resolveReviewThread(
  gh: GitHubContext,
  threadId: string,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<void> {
  if (!threadId || threadId.trim().length === 0) {
    throw new MinskyError(
      "resolveReviewThread requires a non-empty threadId (the GraphQL node ID of the review thread)."
    );
  }

  try {
    const token = await gh.getToken();
    const octokit = octokitOverride ?? createOctokit(token);

    const response = await octokit.graphql<ResolveThreadResponse>(RESOLVE_REVIEW_THREAD_MUTATION, {
      threadId,
    });

    log.info("GitHub PR review thread resolved", {
      threadId,
      isResolved: response.resolveReviewThread?.thread.isResolved,
      owner: gh.owner,
      repo: gh.repo,
    });
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "resolve review thread",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

/**
 * Unresolve a previously-resolved GitHub PR review thread.
 *
 * Mirror of `resolveReviewThread` — uses the `unresolveReviewThread`
 * GraphQL mutation. Useful for round-trip testing and for reopening a
 * thread that was resolved prematurely.
 *
 * @param gh     GitHub context (owner, repo, getToken).
 * @param threadId  GraphQL node ID of the `PullRequestReviewThread` to unresolve.
 */
export async function unresolveReviewThread(
  gh: GitHubContext,
  threadId: string,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<void> {
  if (!threadId || threadId.trim().length === 0) {
    throw new MinskyError(
      "unresolveReviewThread requires a non-empty threadId (the GraphQL node ID of the review thread)."
    );
  }

  try {
    const token = await gh.getToken();
    const octokit = octokitOverride ?? createOctokit(token);

    const response = await octokit.graphql<UnresolveThreadResponse>(
      UNRESOLVE_REVIEW_THREAD_MUTATION,
      { threadId }
    );

    log.info("GitHub PR review thread unresolved", {
      threadId,
      isResolved: response.unresolveReviewThread?.thread.isResolved,
      owner: gh.owner,
      repo: gh.repo,
    });
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "unresolve review thread",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}
