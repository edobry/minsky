/**
 * GitHub API client for the reviewer service.
 *
 * Uses the minsky-reviewer App's installation token to fetch PR context and
 * post reviews. Authenticates via @octokit/auth-app (JWT → installation
 * token, short-lived, refreshes automatically).
 *
 * Distinct from Minsky's existing TokenProvider; deliberately so, because
 * the reviewer service lives in its own deployment boundary.
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { ReviewerConfig } from "./config";

export async function createOctokit(config: ReviewerConfig): Promise<Octokit> {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
  });

  const { token } = await auth({ type: "installation" });

  return new Octokit({ auth: token });
}

export interface PullRequestContext {
  number: number;
  title: string;
  body: string;
  owner: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  diff: string;
  headSha: string;
}

export async function fetchPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestContext> {
  const [prResponse, diffResponse] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    }),
  ]);

  const pr = prResponse.data;
  // mediaType: { format: "diff" } makes Octokit return the body as a raw
  // string at runtime even though the typed response is PullRequest. String()
  // safely coerces the runtime value without the as-unknown double cast.
  const diff = String(diffResponse.data);

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    owner,
    repo,
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    diff,
    headSha: pr.head.sha,
  };
}

export interface SubmittedReview {
  id: number;
  htmlUrl: string;
}

export async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string
): Promise<SubmittedReview> {
  const response = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event,
    body,
  });

  return {
    id: response.data.id,
    htmlUrl: response.data.html_url,
  };
}

/**
 * Return the reviewer App's bot identity (login name) via the /app endpoint.
 *
 * This must use App-level JWT auth, not installation token auth. `/user`
 * endpoints like `octokit.rest.users.getAuthenticated` require user-scoped
 * tokens (PAT or OAuth) and return 403 "Resource not accessible by
 * integration" when called with an installation token.
 *
 * The App's `slug` maps to the bot login as `${slug}[bot]`. Cached after
 * the first call since the App identity is stable across the service's
 * lifetime.
 */
let cachedAppIdentity: { login: string } | null = null;

export async function getAppIdentity(config: ReviewerConfig): Promise<{ login: string }> {
  if (cachedAppIdentity) return cachedAppIdentity;

  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    installationId: config.installationId,
  });

  // `type: "app"` returns an App-level JWT (not an installation token), which
  // is required for `/app` endpoints.
  const { token } = await auth({ type: "app" });

  const appOctokit = new Octokit({ auth: token });
  const response = await appOctokit.rest.apps.getAuthenticated();
  if (!response.data) {
    throw new Error(
      "apps.getAuthenticated returned no data; check App credentials and JWT generation."
    );
  }
  cachedAppIdentity = { login: `${response.data.slug}[bot]` };
  return cachedAppIdentity;
}
