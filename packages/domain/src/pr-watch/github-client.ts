/**
 * Production GithubPrClient adapter for the PR-watch reconciler.
 *
 * Bridges the reconciler's narrow `GithubPrClient` interface to Octokit,
 * authenticating via the project's TokenProvider (same pattern used by
 * asks-github-client.ts and reviewer-watch-github-client.ts).
 *
 * Token is scoped to `${owner}/${repo}` per the project's least-privilege
 * convention. Token acquisition is deferred to each call so that GitHub App
 * installation tokens (which expire every 60 minutes) refresh transparently.
 *
 * @see mt#1618 — production wiring follow-up to mt#1295
 */

import { Octokit } from "@octokit/rest";
import { createOctokit } from "../repository/github-pr-operations";
import type { GithubPrClient, GithubPr, GithubPrReview, GithubCheckRun } from "./watcher";
import type { TokenProvider } from "../auth";

/**
 * Build a `GithubPrClient` backed by a real Octokit instance.
 *
 * Each method acquires a fresh scoped token from `tokenProvider` so that
 * GitHub App installation token refreshes happen transparently between calls.
 * The token is scoped to `${owner}/${repo}` to match the least-privilege
 * pattern used in `GitHubBackend.getGitHubContext()`.
 *
 * @param tokenProvider  TokenProvider instance — typically built from
 *   `createTokenProvider(cfg.github, cfg.github?.token ?? "")`.
 * @param octokitFactory Optional override for the Octokit factory (tests only).
 */
export function makeProductionGithubPrClient(
  tokenProvider: TokenProvider,
  octokitFactory: (token: string) => Octokit = createOctokit
): GithubPrClient {
  return {
    async getPr(owner: string, repo: string, prNumber: number): Promise<GithubPr | null> {
      const token = await tokenProvider.getServiceToken(`${owner}/${repo}`);
      const octokit = octokitFactory(token);

      try {
        const response = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });
        return {
          merged: response.data.merged === true,
          title: response.data.title,
        };
      } catch (err: unknown) {
        // 404 means PR does not exist — return null per contract.
        const status = getErrorStatus(err);
        if (status === 404) return null;
        throw err;
      }
    },

    async listReviews(owner: string, repo: string, prNumber: number): Promise<GithubPrReview[]> {
      const token = await tokenProvider.getServiceToken(`${owner}/${repo}`);
      const octokit = octokitFactory(token);

      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      return reviews.map((r) => ({
        id: r.id,
        state: r.state as GithubPrReview["state"],
        reviewerLogin: r.user?.login ?? null,
      }));
    },

    async listCheckRuns(owner: string, repo: string, prNumber: number): Promise<GithubCheckRun[]> {
      const token = await tokenProvider.getServiceToken(`${owner}/${repo}`);
      const octokit = octokitFactory(token);

      // List check runs for the PR's latest commit via the checks API.
      // First fetch the PR to get the HEAD SHA.
      let headSha: string;
      try {
        const prResponse = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });
        headSha = prResponse.data.head.sha;
      } catch (err: unknown) {
        const status = getErrorStatus(err);
        if (status === 404) return [];
        throw err;
      }

      const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
        owner,
        repo,
        ref: headSha,
        per_page: 100,
      });

      return checkRuns.map((run) => ({
        name: run.name,
        conclusion: run.conclusion ?? null,
      }));
    },
  };
}

/**
 * Extract a numeric HTTP status from an Octokit RequestError-shaped value.
 * Returns undefined when err is not a status-bearing object.
 */
function getErrorStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}
