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

import { Octokit } from "@octokit/rest";
import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";
import { parseUnifiedDiff } from "../../utils/parse-diff";
import { validateDiffAnchors } from "./diff-anchor-validator";
import { handleOctokitError } from "./github-error-handler";
import {
  type GitHubContext,
  createOctokit,
  resolvePRNumber,
  findPRNumberForBranch,
} from "./github-pr-operations";
import type { ReviewListEntry } from "./index";

export { DiffAnchorError, type DiffAnchorFailure } from "./diff-anchor-validator";

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
  /**
   * Optional replacement code for a GitHub suggestion block.
   *
   * When present, the comment body sent to GitHub is augmented with a fenced
   * suggestion block containing this text. GitHub renders suggestion blocks
   * with a one-click "Apply suggestion" button.
   *
   * Constraint: the number of lines in `suggestion` MUST equal the number of
   * lines in the anchored range:
   *  - Single-line comment (no startLine): suggestion must be exactly 1 line.
   *  - Multi-line comment (startLine..line): suggestion must be exactly
   *    (line - startLine + 1) lines.
   *
   * Validation is enforced in validateReviewComment() and throws a MinskyError
   * before the Octokit call if the counts differ.
   */
  suggestion?: string;
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

  if (comment.suggestion !== undefined) {
    // Normalize line endings first so that \r\n (Windows) and lone \r (old Mac)
    // are both treated as a single newline for line-counting purposes.
    // Strip ALL trailing newlines after normalization so that suggestions ending
    // with "\n", "\r\n", "\r\n\r\n", etc. are counted the same way.
    const suggestionText = comment.suggestion.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const suggestionLineCount = suggestionText.split("\n").length;

    // Determine the anchored line range
    const anchoredLineCount =
      comment.startLine !== undefined ? comment.line - comment.startLine + 1 : 1;

    if (suggestionLineCount !== anchoredLineCount) {
      throw new MinskyError(
        `Suggestion line count mismatch on path "${comment.path}": suggestion has ` +
          `${suggestionLineCount} line(s) but the anchored range covers ` +
          `${anchoredLineCount} line(s) ` +
          `(${comment.startLine !== undefined ? `startLine ${comment.startLine}..line ${comment.line}` : `line ${comment.line}`}). ` +
          `GitHub only renders a suggestion block when the line counts match.`
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

    // Pre-flight diff anchor validation.
    // Fetch the PR diff and validate that each comment's (path, line, side)
    // lies within the diff before forwarding to GitHub. This converts opaque
    // 422 responses from GitHub into typed DiffAnchorErrors with nearest-valid-
    // anchor hints. Design: fetch inline here so callers need no API change.
    if (options.comments && options.comments.length > 0) {
      const diffOctokit = new Octokit({
        auth: token,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        request: {
          headers: { accept: "application/vnd.github.v3.diff" },
        },
      });
      const diffResponse = await diffOctokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: gh.owner,
          repo: gh.repo,
          pull_number: prNumber,
          headers: { accept: "application/vnd.github.v3.diff" },
        }
      );
      const diffText = String((diffResponse as { data?: unknown }).data ?? "");
      const parsedDiff = parseUnifiedDiff(diffText);
      validateDiffAnchors(parsedDiff, options.comments);
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

      // When a suggestion is provided, append a fenced suggestion block to the body.
      // GitHub renders this as an "Apply suggestion" button when the suggestion line
      // count matches the anchored range (validated above in validateReviewComment).
      //
      // 1. Normalize line endings: convert \r\n (Windows) and lone \r (old Mac) to \n
      //    first, so that \r characters don't leak into the fenced block.
      // 2. Strip trailing newlines after normalization so suggestions ending with
      //    "\n\n" etc. don't produce double-blank-lines inside the fenced block.
      // 3. Compute fence length: if the suggestion contains backtick runs, the fence
      //    delimiter must be longer than the longest such run to prevent early fence
      //    termination. Use at least 3 backticks (the GitHub minimum), and at least
      //    one more than the longest backtick run found in the content.
      const normalizedSuggestion =
        c.suggestion !== undefined
          ? c.suggestion.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
          : undefined;
      let resolvedBody: string;
      if (normalizedSuggestion !== undefined) {
        // Find longest backtick run in the suggestion content.
        const backtickRuns = normalizedSuggestion.match(/`+/g);
        const longestRun = backtickRuns ? Math.max(...backtickRuns.map((r) => r.length)) : 0;
        const fenceLen = Math.max(3, longestRun + 1);
        const fence = "`".repeat(fenceLen);
        resolvedBody = `${c.body}\n\n${fence}suggestion\n${normalizedSuggestion}\n${fence}`;
      } else {
        resolvedBody = c.body;
      }

      return {
        path: c.path,
        line: c.line,
        body: resolvedBody,
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

/**
 * Pre-mutation ownership check: GraphQL accepts a global node ID and will
 * operate on any thread the bot token can access. Without this guard, a
 * caller passing a valid threadId from a different repository (mistakenly
 * or maliciously) would silently mutate that thread. Verify the thread
 * belongs to the expected owner/repo (and PR if known) before mutating.
 *
 * Returns the thread's repository slug for diagnostic logging.
 */
const RESOLVE_THREAD_OWNERSHIP_QUERY = `
  query ReviewThreadOwnership($threadId: ID!) {
    node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        id
        repository {
          owner { login }
          name
        }
        pullRequest {
          number
        }
      }
    }
  }
`;

interface ThreadOwnershipResponse {
  node: {
    __typename: string;
    id: string;
    repository: { owner: { login: string }; name: string };
    pullRequest: { number: number };
  } | null;
}

async function assertThreadBelongsToRepo(
  gh: GitHubContext,
  threadId: string,
  octokit: ReturnType<typeof createOctokit>,
  expectedPrNumber?: number
): Promise<void> {
  // If the lookup itself fails (network, auth), the caller's outer try/catch
  // routes it through handleOctokitError; we don't pre-empt here.
  const response = await octokit.graphql<ThreadOwnershipResponse>(RESOLVE_THREAD_OWNERSHIP_QUERY, {
    threadId,
  });

  if (!response.node) {
    throw new MinskyError(
      `Thread '${threadId}' does not exist or is not accessible to this token. ` +
        `Ensure the threadId is the GraphQL node ID of a PullRequestReviewThread ` +
        `(see resolveReviewThread JSDoc for accepted sources).`
    );
  }

  if (response.node.__typename !== "PullRequestReviewThread") {
    throw new MinskyError(
      `Thread '${threadId}' resolves to a ${response.node.__typename} node, ` +
        `not a PullRequestReviewThread. Do NOT pass a review comment's node_id; ` +
        `comment IDs and thread IDs are distinct GitHub objects.`
    );
  }

  const actualOwner = response.node.repository.owner.login;
  const actualRepo = response.node.repository.name;
  const actualPr = response.node.pullRequest.number;

  if (
    actualOwner.toLowerCase() !== gh.owner.toLowerCase() ||
    actualRepo.toLowerCase() !== gh.repo.toLowerCase()
  ) {
    throw new MinskyError(
      `Thread '${threadId}' belongs to ${actualOwner}/${actualRepo} ` +
        `but this session targets ${gh.owner}/${gh.repo}. ` +
        `Cross-repo thread mutation is not permitted.`
    );
  }

  if (expectedPrNumber !== undefined && actualPr !== expectedPrNumber) {
    throw new MinskyError(
      `Thread '${threadId}' belongs to PR #${actualPr} in ${gh.owner}/${gh.repo} ` +
        `but this session targets PR #${expectedPrNumber}. ` +
        `Cross-PR thread mutation is not permitted.`
    );
  }
}

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
 * node ID of the `PullRequestReviewThread`. Sources:
 *  - GraphQL: `pullRequest.reviewThreads.nodes[].id`
 *  - REST: items returned by `GET /repos/{owner}/{repo}/pulls/{pull_number}/threads`
 *    carry the thread's `node_id` (the threads endpoint, NOT the comments endpoint).
 *  - The `reviewThreads[].id` field on `session_pr_review_context` (mt#1343).
 *
 * Note: a review comment's `node_id` is NOT a thread ID — distinct GitHub objects.
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

    // Cross-repo guard: GraphQL accepts any node ID the bot can access.
    // Verify the thread belongs to this session's owner/repo before mutating.
    await assertThreadBelongsToRepo(gh, threadId, octokit);

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

    // Cross-repo guard: same rationale as resolveReviewThread.
    await assertThreadBelongsToRepo(gh, threadId, octokit);

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
