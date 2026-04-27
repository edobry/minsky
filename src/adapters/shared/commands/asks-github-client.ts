/**
 * Production GithubReviewClient adapter for the Ask reconciler.
 *
 * Bridges the reconciler's narrow `GithubReviewClient` interface to
 * `listReviews()` from `src/domain/repository/github-pr-review.ts`.
 *
 * Auth routes through the injected TokenProvider so the same service-account
 * / user-token selection logic used by all other GitHub operations applies
 * consistently. The token is scoped to `${owner}/${repo}` to align with
 * least-privilege (GitHub App installation tokens are per-repository).
 *
 * @see mt#1292 — production wiring follow-up to mt#1240
 */

import { listReviews } from "../../../domain/repository/github-pr-review";
import type { GitHubContext } from "../../../domain/repository/github-pr-operations";
import type { GithubReview, GithubReviewClient } from "../../../domain/ask/reconciler";
import type { TokenProvider } from "../../../domain/auth";
import type { ReviewListEntry } from "../../../domain/repository/index";

/**
 * The subset of `listReviews` that `makeProductionGithubReviewClient` needs.
 * Accepting an explicit function parameter instead of a module-level import
 * lets tests inject a fake without module mocking while keeping the public
 * signature narrow.
 */
type ListReviewsFn = (
  gh: GitHubContext,
  prIdentifier: string | number
) => Promise<ReviewListEntry[]>;

/**
 * Build a `GithubReviewClient` backed by the real `listReviews` infrastructure.
 *
 * Each call to `listReviews` constructs a per-call `GitHubContext` from the
 * owner/repo supplied by the reconciler (parsed from the Ask's contextRef) and
 * the token pair provided by `tokenProvider`.
 *
 * The token is scoped to `${owner}/${repo}` so that GitHub App installation
 * tokens are issued for the correct repository — matching the least-privilege
 * pattern used in `GitHubBackend.getGitHubContext()`.
 *
 * @param tokenProvider   TokenProvider instance — typically built from
 *   `createTokenProvider(cfg.github, cfg.github?.token ?? "")`.
 * @param listReviewsImpl Override for the underlying `listReviews` function.
 *   Defaults to the real implementation; tests pass a fake.
 */
export function makeProductionGithubReviewClient(
  tokenProvider: TokenProvider,
  listReviewsImpl: ListReviewsFn = listReviews
): GithubReviewClient {
  return {
    async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
      const gh: GitHubContext = {
        owner,
        repo,
        getToken: () => tokenProvider.getServiceToken(`${owner}/${repo}`),
      };

      const entries = await listReviewsImpl(gh, prNumber);

      return entries.map((e) => ({
        reviewId: e.reviewId,
        state: e.state,
        reviewerLogin: e.reviewerLogin,
        body: e.body,
      }));
    },
  };
}
