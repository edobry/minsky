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
  /** Base repository owner (where the PR targets). Same as `headOwner` for in-repo PRs. */
  owner: string;
  /** Base repository name. Same as `headRepo` for in-repo PRs. */
  repo: string;
  /**
   * Head repository owner. For PRs from forks, this differs from `owner`.
   * `headSha` only exists in the head repo for forked PRs; tool calls that
   * want to read at HEAD must use these coordinates to avoid 404s.
   */
  headOwner: string;
  /** Head repository name. See `headOwner` for fork handling. */
  headRepo: string;
  /** True when the PR originates from a different repo (a fork). */
  isForkedPR: boolean;
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

  // Head repository coords may differ from base coords for forked PRs.
  // pr.head.repo is null in rare cases (deleted fork); fall back to base.
  const headOwner = pr.head.repo?.owner.login ?? owner;
  const headRepo = pr.head.repo?.name ?? repo;
  const isForkedPR = headOwner !== owner || headRepo !== repo;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    owner,
    repo,
    headOwner,
    headRepo,
    isForkedPR,
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
 * Normalize a user-supplied path for the GitHub Contents API.
 *
 * The GitHub API expects an empty string for the repository root. Callers
 * (and the tool prompt) sometimes pass ".", "./", or "/" instead. Also strip
 * a leading "./" prefix so "./src/foo" and "src/foo" behave identically.
 *
 * Exported for tests.
 */
export function normalizeContentPath(path: string): string {
  if (path === "." || path === "./" || path === "/" || path === "") return "";
  // Strip a leading "./" prefix so "./src/foo" and "src/foo" behave identically.
  if (path.startsWith("./")) path = path.slice(2);
  // Strip ALL leading slashes (LLMs commonly supply absolute-like paths like
  // "/src/foo.ts" — the Contents API expects relative, and a leading slash
  // produces a 404).
  while (path.startsWith("/")) path = path.slice(1);
  // Strip trailing slash (getContent treats dir paths the same with/without)
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Sentinel returned by readFileAtRef when a file exceeds the API's truncation threshold. */
export const TRUNCATED_FILE_NOTICE =
  "[TRUNCATED] This file exceeds the GitHub Contents API size limit and only a partial snippet could be fetched. Do not make claims about the full file contents — mark any claim as NEEDS VERIFICATION.";

/**
 * Read the content of a file at a specific git ref.
 *
 * Returns the file content as a string, or null if the file does not exist
 * (404). Throws on unexpected errors (permissions, malformed response, etc.).
 *
 * For files that exceed the Contents API's ~1MB threshold, GitHub sets
 * `truncated: true` and returns only a snippet. Rather than silently return
 * partial content (which would let the reviewer model "verify" against
 * incomplete data and make confidently wrong claims — exactly the class of
 * error mt#1126 tries to prevent), prepend TRUNCATED_FILE_NOTICE so the
 * model sees the caveat inline with the content.
 */
export async function readFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  const normalizedPath = normalizeContentPath(path);
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: normalizedPath,
      ref,
    });
    const data = response.data;
    // getContent returns an array for directories; a single object for files.
    if (Array.isArray(data)) {
      throw new Error(`Path "${path}" is a directory, not a file`);
    }
    if (data.type !== "file") {
      throw new Error(`Path "${path}" is not a file (type=${data.type})`);
    }
    // Content is base64-encoded by the GitHub API.
    if (!("content" in data) || typeof data.content !== "string") {
      throw new Error(`Unexpected response shape for "${path}": no content field`);
    }
    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    // The Contents API sets truncated: true when the file exceeds its size
    // threshold (~1MB). Prepend a notice so the model doesn't treat the
    // partial content as complete. A fuller fix would fall back to
    // download_url / raw mediaType; deferring that as a follow-up.
    const isTruncated = "truncated" in data && (data as { truncated?: boolean }).truncated === true;
    return isTruncated ? `${TRUNCATED_FILE_NOTICE}\n\n${decoded}` : decoded;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "status" in (err as Record<string, unknown>) &&
      (err as Record<string, unknown>).status === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * List the immediate children (files and directories) of a directory at a
 * specific git ref.
 *
 * Returns null if the path does not exist (404). Throws on unexpected errors.
 * Accepts ".", "./", "/" or "" for the repository root (normalized internally).
 */
export async function listDirectoryAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<Array<{ name: string; type: "file" | "dir" }> | null> {
  const normalizedPath = normalizeContentPath(path);
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: normalizedPath,
      ref,
    });
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error(`Path "${path}" is not a directory`);
    }
    return data
      .filter((entry) => entry.type === "file" || entry.type === "dir")
      .map((entry) => ({
        name: entry.name,
        type: entry.type as "file" | "dir",
      }));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "status" in (err as Record<string, unknown>) &&
      (err as Record<string, unknown>).status === 404
    ) {
      return null;
    }
    throw err;
  }
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
