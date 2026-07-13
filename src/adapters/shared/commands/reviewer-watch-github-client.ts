/**
 * Production `MissedReviewClient` adapter for the local reviewer-watch.
 *
 * Wraps Octokit (built from `tokenProvider.getServiceToken(repoScope)`) into
 * the narrow `MissedReviewClient` interface the watcher expects. Mirrors the
 * structure of `asks-github-client.ts` so the same TokenProvider + scoped-
 * token pattern applies consistently across the codebase.
 *
 * Token role: the watcher is the operator's local view, not a bot impersonator.
 * It uses the default service-account role (`implementer`) — reads of PR lists
 * and review summaries are non-mutating and do not require the reviewer App
 * identity. The token is scoped to `${owner}/${repo}` per the project's
 * least-privilege convention.
 */

import { Octokit } from "@octokit/rest";
import { createOctokit } from "@minsky/domain/repository/github-pr-operations";
import type { MissedReviewClient, OpenPR, PRReviewSummary } from "@minsky/domain/reviewer-watch";
import type { TokenProvider } from "@minsky/domain/auth";

/**
 * Build a `MissedReviewClient` backed by a real Octokit instance.
 *
 * Token acquisition is deferred to the first call — the per-call closures
 * await `tokenProvider.getServiceToken(repoScope)` so that token refresh
 * (GitHub App installation tokens expire every 60 minutes) happens
 * transparently.
 */
export function makeProductionMissedReviewClient(
  tokenProvider: TokenProvider,
  octokitFactory: (token: string) => Octokit = createOctokit
): MissedReviewClient {
  return {
    async listOpenPRs(owner: string, repo: string): Promise<OpenPR[]> {
      const token = await tokenProvider.getServiceToken(`${owner}/${repo}`);
      const octokit = octokitFactory(token);

      const prs = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });

      return prs.map((pr) => ({
        number: pr.number,
        headSha: pr.head.sha,
        authorLogin: pr.user?.login ?? "",
        htmlUrl: pr.html_url,
        draft: pr.draft === true,
      }));
    },

    async listReviews(owner: string, repo: string, prNumber: number): Promise<PRReviewSummary[]> {
      const token = await tokenProvider.getServiceToken(`${owner}/${repo}`);
      const octokit = octokitFactory(token);

      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      return reviews.map((r) => ({
        reviewerLogin: r.user?.login ?? null,
        commitId: r.commit_id ?? "",
        state: r.state,
      }));
    },
  };
}
