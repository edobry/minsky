/**
 * Production GithubReviewClient adapter for the Ask reconciler.
 *
 * Bridges the reconciler's narrow `GithubReviewClient` interface to
 * `listReviews()` from `src/domain/repository/github-pr-review.ts`.
 *
 * Auth routes through the injected TokenProvider so the same service-account
 * / user-token selection logic used by all other GitHub operations applies
 * consistently.
 *
 * @see mt#1292 — production wiring follow-up to mt#1240
 */

import { listReviews } from "../../../domain/repository/github-pr-review";
import type { GitHubContext } from "../../../domain/repository/github-pr-operations";
import type { GithubReview, GithubReviewClient } from "../../../domain/ask/reconciler";
import type { TokenProvider } from "../../../domain/auth";

/**
 * Build a `GithubReviewClient` backed by the real `listReviews` infrastructure.
 *
 * Each call to `listReviews` constructs a per-call `GitHubContext` from the
 * owner/repo supplied by the reconciler (parsed from the Ask's contextRef) and
 * the token pair provided by `tokenProvider`. This mirrors the pattern used in
 * `GitHubBackend.getGitHubContext()`:
 *
 * ```ts
 * return { owner, repo, getToken: () => tokenProvider.getServiceToken(), ... };
 * ```
 *
 * @param tokenProvider  TokenProvider instance — typically built from
 *   `createTokenProvider(cfg.github, cfg.github?.token ?? "")`.
 */
export function makeProductionGithubReviewClient(tokenProvider: TokenProvider): GithubReviewClient {
  return {
    async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubReview[]> {
      const gh: GitHubContext = {
        owner,
        repo,
        getToken: () => tokenProvider.getServiceToken(),
        getUserToken: () => tokenProvider.getUserToken(),
      };

      const entries = await listReviews(gh, prNumber);

      return entries.map((e) => ({
        reviewId: e.reviewId,
        state: e.state,
        reviewerLogin: e.reviewerLogin,
        body: e.body,
      }));
    },
  };
}
