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
import { isBotReviewerEntry, type PriorReview } from "./prior-review-summary";

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
  /**
   * List of file paths changed by this PR (relative to repo root).
   * Used by the scope classifier (mt#1188) to determine docs-only / test-only.
   * Fetched from the pulls.listFiles endpoint alongside the diff.
   */
  filesChanged: string[];
  /**
   * Authoritative changed-files count from the PR API (`pulls.get` →
   * `changed_files`). The classifier compares this against
   * `filesChanged.length` to detect listFiles truncation (cap exceeded, error
   * fallback, etc.) and downgrade to `normal` rather than classify on a
   * partial view.
   */
  changedFilesCount: number;
}

/**
 * Hard limit on the number of changed files fetched per PR to avoid runaway
 * pagination on PRs that touch thousands of files (GitHub caps at 3000 files
 * per PR but the classifier's heuristics work on far fewer). When the cap is
 * hit we return [] so the scope classifier falls through to conservative
 * `normal` scope rather than classifying on partial data.
 */
export const MAX_FILES_FETCHED = 1000;

/**
 * Fetch the list of files changed by a PR, following Link headers via
 * octokit.paginate. Returns an array of filename strings.
 *
 * Safety cap: if more than MAX_FILES_FETCHED files are returned the cap is
 * exceeded and [] is returned (scope classifier falls through to normal).
 * On any error an empty array is also returned; both cases emit a structured
 * JSON log so the failure is observable in the service logs.
 *
 * Exported for tests.
 */
export async function fetchListFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  let allFiles: Array<{ filename: string }>;
  try {
    allFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        event: "pr_scope_listfiles_error",
        owner,
        repo,
        pr: prNumber,
        error: message,
      })
    );
    return [];
  }

  if (allFiles.length > MAX_FILES_FETCHED) {
    console.log(
      JSON.stringify({
        event: "pr_scope_files_cap_exceeded",
        owner,
        repo,
        pr: prNumber,
        fileCount: allFiles.length,
        cap: MAX_FILES_FETCHED,
      })
    );
    return [];
  }

  return allFiles.map((f) => f.filename);
}

export async function fetchPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestContext> {
  const [prResponse, diffResponse, filesChanged] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    }),
    fetchListFiles(octokit, owner, repo, prNumber),
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
    filesChanged,
    changedFilesCount: pr.changed_files,
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
 * Hard limit on the number of reviews fetched per PR to avoid runaway pagination
 * on pathological PRs with hundreds of reviews. listReviews returns oldest-first,
 * so we take the first MAX_REVIEWS_FETCHED (oldest) and log a warning when truncated.
 */
const MAX_REVIEWS_FETCHED = 500;

/**
 * Fetch prior reviews on a PR posted by the reviewer bot.
 *
 * Filters to reviews from the ALLOWED_REVIEWER_BOT_LOGINS allowlist that also
 * contain the Chinese-wall marker. Drops DISMISSED and PENDING reviews.
 * Returns the remaining reviews sorted ascending by submittedAt (oldest first),
 * ready for summarizePriorReviews.
 *
 * Uses octokit.paginate to fetch all pages (GitHub's listReviews caps at 100
 * per page). Capped at MAX_REVIEWS_FETCHED (500) to avoid runaway fetches on
 * pathological PRs; a warning is logged when the cap is hit.
 *
 * Filter logic lives in isBotReviewerEntry (prior-review-summary.ts) so it
 * can be tested without importing @octokit dependencies.
 */
export async function fetchPriorReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PriorReview[]> {
  // paginate fetches all pages automatically. listReviews returns oldest-first.
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  let rawReviews = allReviews;
  if (rawReviews.length > MAX_REVIEWS_FETCHED) {
    console.warn(
      `[fetchPriorReviews] PR #${prNumber} has ${rawReviews.length} reviews, ` +
        `exceeding the cap of ${MAX_REVIEWS_FETCHED}. Only the first ${MAX_REVIEWS_FETCHED} will be used.`
    );
    rawReviews = rawReviews.slice(0, MAX_REVIEWS_FETCHED);
  }

  const reviews = rawReviews
    .map(
      (r): PriorReview => ({
        id: r.id,
        state: r.state as PriorReview["state"],
        submittedAt: r.submitted_at ?? new Date(0).toISOString(),
        commitId: r.commit_id,
        userLogin: r.user?.login ?? "",
        // GitHub's Reviews API returns null for empty approve/comment bodies.
        // Coalesce to "" so downstream body.includes(...) in
        // isBotReviewerEntry doesn't throw on PRs containing empty reviews.
        body: r.body ?? "",
      })
    )
    .filter((r) => isBotReviewerEntry(r))
    // Sort ascending by submittedAt — oldest first
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  return reviews;
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
  // Strip ALL trailing slashes (getContent treats dir paths the same
  // with/without; multiple trailing slashes like "src/foo//" must also
  // normalize).
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * Entry types reported by the GitHub Contents API.
 *
 * Beyond `file` and `dir`, the API also surfaces `symlink` (a git symbolic
 * link entry) and `submodule` (a git submodule). Earlier revisions silently
 * filtered the latter two; mt#1216 surfaces them so the reviewer can see
 * symlinked configs and submodule references when verifying repo structure.
 */
export type DirEntryType = "file" | "dir" | "symlink" | "submodule";

export interface DirEntry {
  name: string;
  type: DirEntryType;
}

/**
 * Structured result from `readFileAtRef`.
 *
 * Truncation rides as a boolean flag rather than a string prefix on the
 * content (mt#1216 — the prefix broke downstream parsing when the truncated
 * file itself was JSON or another structured format). Binary files return a
 * placeholder kind so the model doesn't burn context on raw UTF-8 garbage.
 */
export type ReadFileResult =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary"; size: number; truncated: boolean };

/**
 * Heuristic binary detection: scan the first `sampleBytes` of the buffer for
 * null bytes. Files with a NUL in their first ~8KB are treated as binary —
 * the same heuristic file(1) and most tooling use. Decoding such a file as
 * UTF-8 produces lossy garbage that wastes the model's context budget.
 */
function isBinaryBuffer(buf: Buffer, sampleBytes = 8192): boolean {
  const limit = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Read the content of a file at a specific git ref.
 *
 * Returns a discriminated union:
 *   - `{ kind: "text", content, truncated }` for text files (truncated=true
 *     when GitHub's Contents API returned a partial snippet for a >~1MB file)
 *   - `{ kind: "binary", size }` for files whose decoded content contains
 *     null bytes in the first 8KB (common heuristic)
 *   - `null` when the file does not exist (404)
 *
 * Throws on unexpected errors (permissions, malformed response, etc.).
 */
export async function readFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<ReadFileResult | null> {
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
    const buf = Buffer.from(data.content, "base64");
    // GitHub's Contents API reports truncation on files above ~1MB; when set,
    // `content` is only a partial snippet and `data.size` is still the full
    // repository-stored size. Preserve both facts on the result so callers
    // (envelope, prompt, model) can disambiguate snippet-vs-file boundaries.
    const truncated = "truncated" in data && (data as { truncated?: boolean }).truncated === true;
    const apiSize =
      typeof (data as { size?: unknown }).size === "number"
        ? (data as { size: number }).size
        : buf.length;
    if (isBinaryBuffer(buf)) {
      return { kind: "binary", size: apiSize, truncated };
    }
    return { kind: "text", content: buf.toString("utf-8"), truncated };
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
 *
 * Includes `symlink` and `submodule` entries with their real type so the
 * reviewer can see them when verifying repo structure (mt#1216).
 */
export async function listDirectoryAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<DirEntry[] | null> {
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
      .filter(
        (entry): entry is typeof entry & { type: DirEntryType } =>
          entry.type === "file" ||
          entry.type === "dir" ||
          entry.type === "symlink" ||
          entry.type === "submodule"
      )
      .map((entry) => ({ name: entry.name, type: entry.type }));
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
