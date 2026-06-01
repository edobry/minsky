/**
 * GitHub PR lifecycle operations extracted from GitHubBackend.
 *
 * Contains: createPullRequest, updatePullRequest, closePullRequest,
 * mergePullRequest, getPullRequestDetails, getPullRequestDiff,
 * getPRReviewThreads.
 *
 * Each function receives its dependencies explicitly (Octokit, owner/repo,
 * session helpers) so the main class stays a thin delegation layer.
 */

import { Octokit } from "@octokit/rest";
import { MinskyError, getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { execGitWithTimeout } from "../utils/git-exec";
import type { TokenRole } from "../auth/token-provider";
import type { SessionProviderInterface } from "../session";
import type { PRInfo, MergeInfo } from "./index";
import {
  classifyOctokitError,
  handleOctokitError,
  handleCreatePR422,
  handleMerge405or422,
  type ErrorContext,
} from "./github-error-handler";
import type { AuthorshipTier } from "../provenance/types";
import { ensureAuthorshipLabelsExist, addAuthorshipLabel } from "../provenance/authorship-labels";
import { SessionStatus } from "../session/types";

// ── Shared helpers ──────────────────────────────────────────────────────

export interface GitHubContext {
  owner: string;
  repo: string;
  /**
   * Token accessor. Optional `role` selects which service-account identity
   * provides the token: "implementer" (default) uses the minsky-ai App;
   * "reviewer" uses the minsky-reviewer App when configured. When the
   * reviewer App is not configured, this method silently falls back to the
   * implementer App's token — callers that must enforce a strict identity
   * (e.g., APPROVE / REQUEST_CHANGES on a self-authored bot PR) MUST gate
   * on `isRoleConfigured("reviewer")` first.
   */
  getToken: (role?: TokenRole) => Promise<string>;
  /** Optional user-token accessor for privileged fallback on permission failures. */
  getUserToken?: () => Promise<string>;
  /**
   * Strict per-role configuration check. Returns true iff the requested role
   * has dedicated credentials (i.e., its own App configured). Distinct from
   * `getToken(role)`, which silently falls back. Optional for backwards
   * compatibility with older test stubs that don't supply it; production
   * code paths populated by `requireGitHubContext` always include it.
   */
  isRoleConfigured?: (role: TokenRole) => boolean;
}

/**
 * Create a silent-log Octokit instance.
 */
export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

/**
 * Resolve a PR number from an identifier that may be a number, a numeric
 * string, or a branch name. Uses `findPRNumberForBranch` when needed.
 */
export async function resolvePRNumber(
  prIdentifier: string | number,
  gh: GitHubContext,
  findForBranch: (branch: string) => Promise<number>
): Promise<number> {
  if (typeof prIdentifier === "number") return prIdentifier;
  const parsed = parseInt(prIdentifier, 10);
  if (!isNaN(parsed) && String(parsed) === prIdentifier) return parsed;
  return findForBranch(prIdentifier);
}

/**
 * Find the PR number for a given branch name by searching open then
 * closed PRs.
 */
export async function findPRNumberForBranch(
  branchName: string,
  gh: GitHubContext,
  octokit: Octokit
): Promise<number> {
  try {
    // Search with owner prefix first, then without (for forks)
    for (const state of ["open", "closed"] as const) {
      const { data: pulls } = await octokit.rest.pulls.list({
        owner: gh.owner,
        repo: gh.repo,
        state,
        head: `${gh.owner}:${branchName}`,
        per_page: 100,
      });
      const match = pulls.find((pr) => pr.head.ref === branchName);
      if (match) return match.number;
    }

    for (const state of ["open", "closed"] as const) {
      const { data: pulls } = await octokit.rest.pulls.list({
        owner: gh.owner,
        repo: gh.repo,
        state,
        per_page: 100,
      });
      const match = pulls.find((pr) => pr.head.ref === branchName);
      if (match) return match.number;
    }

    throw new MinskyError(`No pull request found for branch: ${branchName}`);
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    throw new MinskyError(
      `Failed to find PR number for branch ${branchName}: ` + `${getErrorMessage(error)}`
    );
  }
}

// ── PR lifecycle operations ─────────────────────────────────────────────

/**
 * Create a GitHub pull request.
 */
export async function createPullRequest(
  gh: GitHubContext,
  title: string,
  body: string,
  sourceBranch: string,
  baseBranch: string,
  workdir: string,
  session: string | undefined,
  draft: boolean,
  getSessionDB: () => Promise<SessionProviderInterface>,
  authorshipTier?: AuthorshipTier
): Promise<PRInfo> {
  try {
    // Ensure the source branch is pushed to the remote
    await execGitWithTimeout("push", `push origin ${sourceBranch}`, {
      workdir,
      timeout: 60000,
    });

    const githubToken = await gh.getToken();
    const octokit = createOctokit(githubToken);

    const prResponse = await octokit.rest.pulls.create({
      owner: gh.owner,
      repo: gh.repo,
      title,
      body,
      head: sourceBranch,
      base: baseBranch,
      draft: draft || false,
    });

    const pr = prResponse.data;

    log.cli(`GitHub PR: ${pr.html_url}`);
    log.cli(`PR #${pr.number}: ${title}`);

    const prInfo: PRInfo = {
      number: pr.number,
      url: pr.html_url,
      state: pr.state as "open" | "closed" | "merged",
      metadata: {
        id: pr.id,
        node_id: pr.node_id,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        owner: gh.owner,
        repo: gh.repo,
        workdir,
        draft: pr.draft,
      },
    };

    // Update session record with PR information
    if (session) {
      try {
        const sessionDB = await getSessionDB();
        const sessionRecord = await sessionDB.getSession(session);
        if (sessionRecord) {
          await sessionDB.updateSession(session, {
            lastActivityAt: new Date().toISOString(),
            status: SessionStatus.PR_OPEN,
            pullRequest: {
              number: pr.number,
              url: pr.html_url,
              state: pr.draft
                ? "draft"
                : (pr.state as "open" | "closed" | "merged" | "draft") || "open",
              createdAt: pr.created_at,
              mergedAt: pr.merged_at || undefined,
              headBranch: pr.head.ref,
              baseBranch: pr.base.ref,
              github: {
                id: pr.id,
                nodeId: pr.node_id,
                htmlUrl: pr.html_url,
                author: pr.user?.login || "unknown",
              },
              lastSynced: new Date().toISOString(),
            },
          });
          log.debug(`Updated session record for ${session} with PR #${pr.number}`);
        }
      } catch (error) {
        log.debug(`Failed to update session record with PR info: ${error}`);
      }
    }

    // Apply authorship tier label if a tier was provided
    if (authorshipTier !== undefined) {
      try {
        await ensureAuthorshipLabelsExist(octokit, gh.owner, gh.repo);
        await addAuthorshipLabel(octokit, gh.owner, gh.repo, pr.number, authorshipTier);
      } catch (labelError) {
        // Label failure is non-fatal — warn but don't block PR creation
        log.warn(
          `Failed to apply authorship label to PR #${pr.number}: ${getErrorMessage(labelError)}`
        );
      }
    }

    return prInfo;
  } catch (error) {
    // Re-throw MinskyErrors (already classified)
    if (error instanceof MinskyError) throw error;

    const info = classifyOctokitError(error);
    const ctx: ErrorContext = {
      operation: "create pull request",
      owner: gh.owner,
      repo: gh.repo,
      sourceBranch,
      baseBranch,
    };

    // Handle 422 validation errors specific to PR creation
    handleCreatePR422(info, ctx);

    // Generic handler covers 401, 403, 404, 429, network, etc.
    handleOctokitError(error, ctx);
  }
}

/**
 * Update an existing GitHub pull request.
 */
export async function updatePullRequest(
  gh: GitHubContext,
  options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  },
  getSessionDB: () => Promise<SessionProviderInterface>
): Promise<PRInfo> {
  // Resolve PR number
  let prNumber: number;
  if (options.prIdentifier) {
    prNumber =
      typeof options.prIdentifier === "string"
        ? parseInt(options.prIdentifier, 10)
        : options.prIdentifier;
    if (isNaN(prNumber)) {
      throw new MinskyError(`Invalid PR number: ${options.prIdentifier}`);
    }
  } else if (options.session) {
    const sessionDB = await getSessionDB();
    const sessionRecord = await sessionDB.getSession(options.session);
    if (!sessionRecord) {
      throw new MinskyError(`Session '${options.session}' not found`);
    }

    if (sessionRecord.pullRequest?.number) {
      prNumber =
        typeof sessionRecord.pullRequest.number === "string"
          ? parseInt(sessionRecord.pullRequest.number, 10)
          : sessionRecord.pullRequest.number;
    } else {
      // Find PR via GitHub API using current git branch
      try {
        const githubToken = await gh.getToken();
        if (!options.session) {
          throw new MinskyError("Session ID is required to update PR without explicit PR number");
        }
        const sessionWorkdir = await sessionDB.getSessionWorkdir(options.session);
        const { GitService } = require("../git");
        const gitService = new GitService(sessionDB);
        const currentBranch = (
          await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
        ).trim();

        const octokit = createOctokit(githubToken);
        const { data: pulls } = await octokit.rest.pulls.list({
          owner: gh.owner,
          repo: gh.repo,
          head: `${gh.owner}:${currentBranch}`,
          state: "open",
        });

        const first = pulls[0];
        if (!first) {
          throw new MinskyError(`No open PR found for branch '${currentBranch}'`);
        }
        prNumber = first.number;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new MinskyError(`No PR found for session '${options.session}': ${msg}`);
      }
    }
  } else {
    throw new MinskyError("Either prIdentifier or session must be provided");
  }

  try {
    const githubToken = await gh.getToken();
    const octokit = createOctokit(githubToken);

    const updateData: { title?: string; body?: string } = {};
    if (options.title !== undefined) updateData.title = options.title;
    if (options.body !== undefined) updateData.body = options.body;

    if (Object.keys(updateData).length === 0) {
      throw new MinskyError("At least one field (title or body) must be provided for update");
    }

    const response = await octokit.rest.pulls.update({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      ...updateData,
    });

    log.debug(`Updated GitHub PR #${prNumber}`, {
      title: updateData.title,
      body: updateData.body
        ? updateData.body.substring(0, 100) + (updateData.body.length > 100 ? "..." : "")
        : undefined,
    });

    return {
      number: response.data.number,
      url: response.data.html_url,
      state: response.data.state as "open" | "closed" | "merged",
      metadata: {
        owner: gh.owner,
        repo: gh.repo,
        workdir: options.session
          ? await (await getSessionDB()).getSessionWorkdir(options.session)
          : "",
      },
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "update pull request",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
  }
}

/**
 * Close a GitHub pull request without merging. Optionally posts a comment
 * before flipping the state, so the closure note is visible chronologically
 * before the close event in the PR timeline.
 *
 * Refuses to operate on already-closed or already-merged PRs with a clear
 * error rather than returning a silent success. The merged check uses
 * `pulls.get`'s `merged` field — GitHub's `pulls.update` with `state: closed`
 * on a merged PR is a no-op, but the caller deserves to know.
 *
 * Tracking task: mt#1955.
 */
export async function closePullRequest(
  gh: GitHubContext,
  options: {
    prIdentifier?: string | number;
    session?: string;
    comment?: string;
  },
  getSessionDB: () => Promise<SessionProviderInterface>
): Promise<PRInfo> {
  // Resolve PR number (mirror updatePullRequest's resolution flow)
  let prNumber: number;
  if (options.prIdentifier) {
    prNumber =
      typeof options.prIdentifier === "string"
        ? parseInt(options.prIdentifier, 10)
        : options.prIdentifier;
    if (isNaN(prNumber)) {
      throw new MinskyError(`Invalid PR number: ${options.prIdentifier}`);
    }
  } else if (options.session) {
    const sessionDB = await getSessionDB();
    const sessionRecord = await sessionDB.getSession(options.session);
    if (!sessionRecord) {
      throw new MinskyError(`Session '${options.session}' not found`);
    }

    if (sessionRecord.pullRequest?.number) {
      prNumber =
        typeof sessionRecord.pullRequest.number === "string"
          ? parseInt(sessionRecord.pullRequest.number, 10)
          : sessionRecord.pullRequest.number;
    } else {
      throw new MinskyError(
        `No PR recorded for session '${options.session}'. Use 'session pr create' to create a PR first.`
      );
    }
  } else {
    throw new MinskyError("Either prIdentifier or session must be provided");
  }

  try {
    const githubToken = await gh.getToken();
    const octokit = createOctokit(githubToken);

    // Fetch current state so we can refuse already-closed or merged PRs
    // BEFORE doing any side-effects (comment post or state flip). This is
    // the idempotency + safety guard called out by mt#1955 SC #4.
    const { data: currentPr } = await octokit.rest.pulls.get({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
    });

    if (currentPr.merged) {
      throw new MinskyError(
        `Cannot close PR #${prNumber}: already merged at ${currentPr.merged_at}. Closing a merged PR via the close endpoint is a no-op; refusing rather than silently succeeding.`
      );
    }
    if (currentPr.state === "closed") {
      throw new MinskyError(
        `Cannot close PR #${prNumber}: already closed at ${currentPr.closed_at}.`
      );
    }

    // Post the closure comment BEFORE the state flip so it appears
    // chronologically before the close event in the PR timeline. PR
    // comments are issue comments at the API level (mt#1955 SC #3).
    if (options.comment && options.comment.length > 0) {
      await octokit.rest.issues.createComment({
        owner: gh.owner,
        repo: gh.repo,
        issue_number: prNumber,
        body: options.comment,
      });
      log.debug(`Posted closure comment on PR #${prNumber}`);
    }

    // Flip state to closed via the pulls.update endpoint
    const response = await octokit.rest.pulls.update({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      state: "closed",
    });

    log.debug(`Closed GitHub PR #${prNumber} without merging`);

    return {
      number: response.data.number,
      url: response.data.html_url,
      state: response.data.state as "open" | "closed" | "merged",
      metadata: {
        owner: gh.owner,
        repo: gh.repo,
        commentPosted: Boolean(options.comment && options.comment.length > 0),
        closedAt: response.data.closed_at ?? undefined,
      },
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "close pull request",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    });
  }
}

/**
 * Assemble the merge commit body from the PR body, optional git trailers, and an optional
 * audited-bypass signature (mt#2215).
 *
 * Normalizes separators so each present block is joined by exactly one blank line, regardless
 * of whether the inputs carry leading/trailing whitespace — avoids malformed messages when, e.g.,
 * the PR body has no trailing newline or a trailer string begins without a leading newline.
 *
 * Git trailers are placed LAST so trailer parsing (Co-authored-by, etc.) stays valid — the
 * audited-bypass prose block, when present, is inserted between the body and the trailers.
 */
export function buildMergeCommitBody(
  baseBody: string,
  mergeTrailers?: string,
  bypassAuditMessage?: string
): string {
  const blocks: string[] = [];
  const push = (s: string | undefined) => {
    const trimmed = (s ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
    if (trimmed) blocks.push(trimmed);
  };
  push(baseBody);
  push(bypassAuditMessage);
  push(mergeTrailers);
  return blocks.join("\n\n");
}

/**
 * Merge a GitHub pull request.
 */
export async function mergePullRequest(
  gh: GitHubContext,
  prIdentifier: string | number,
  diagnoseMergeBlockerFn: (prNumber: number, octokit: Octokit) => Promise<string>,
  mergeTrailers?: string,
  tokenOverride?: () => Promise<string>,
  bypassAuditMessage?: string
): Promise<MergeInfo> {
  const prNumber = typeof prIdentifier === "string" ? parseInt(prIdentifier, 10) : prIdentifier;
  if (isNaN(prNumber)) {
    throw new MinskyError(`Invalid PR number: ${prIdentifier}`);
  }

  try {
    const githubToken = await (tokenOverride ? tokenOverride() : gh.getToken());
    const octokit = createOctokit(githubToken);

    // Get the PR details first
    const prResponse = await octokit.rest.pulls.get({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
    });

    const pr = prResponse.data;

    if (pr.state !== "open") {
      throw new MinskyError(`Pull request #${prNumber} is not open (current state: ${pr.state})`);
    }

    if (!pr.mergeable) {
      throw new MinskyError(
        `Pull request #${prNumber} has merge conflicts that must be ` + `resolved first`
      );
    }

    const baseMessage = pr.body || "";
    // mt#2215: assemble the merge commit body with normalized separators; the audited-bypass
    // signature (when present) is inserted between the body and any git trailers.
    const commitMessage = buildMergeCommitBody(baseMessage, mergeTrailers, bypassAuditMessage);

    const mergeParams = {
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      merge_method: "merge" as const,
      commit_title: pr.title || `Merge pull request #${prNumber} from ${pr.head.ref}`,
      commit_message: commitMessage,
    };

    let mergeResponse: Awaited<ReturnType<typeof octokit.rest.pulls.merge>>;
    try {
      mergeResponse = await octokit.rest.pulls.merge(mergeParams);
    } catch (mergeError) {
      const mergeInfo = classifyOctokitError(mergeError);
      // Only attempt user-token fallback on 403 permission errors, not on 405/422 merge conflicts
      const is403 =
        mergeInfo.status === 403 ||
        (mergeInfo.messageLower.includes("403") && !mergeInfo.messageLower.includes("422"));
      const is405or422 = mergeInfo.status === 405 || mergeInfo.status === 422;

      if (is403 && !is405or422 && !tokenOverride && gh.getUserToken) {
        // Bot token lacks merge rights — attempt fallback to user PAT
        log.warn(
          `[merge] Bot token lacked merge permission on ${gh.owner}/${gh.repo}#${prNumber}; ` +
            `retrying with user PAT. Fix: grant the App contents:write + pull_requests:write on this repo.`
        );
        try {
          const userToken = await gh.getUserToken();
          const userOctokit = createOctokit(userToken);
          mergeResponse = await userOctokit.rest.pulls.merge(mergeParams);
          log.warn(`[merge] Bot token lacked permission; succeeded with user PAT fallback.`);
        } catch (userMergeError) {
          throw new MinskyError(
            `Bot token lacks merge rights for ${gh.owner}/${gh.repo}#${prNumber}. ` +
              `User PAT fallback also failed: ${getErrorMessage(userMergeError)}. To fix:\n` +
              `  (a) Grant the GitHub App contents:write + pull_requests:write permissions on this repo\n` +
              `  (b) Ensure the user PAT has merge rights\n` +
              `Run \`gh pr merge ${prNumber}\` manually to unblock this PR in the meantime.`
          );
        }
      } else if (is403 && !is405or422 && !tokenOverride) {
        // 403 with no user token fallback available (getUserToken not provided)
        throw new MinskyError(
          `Bot token lacks merge rights for ${gh.owner}/${gh.repo}#${prNumber}. To fix:\n` +
            `  (a) Grant the GitHub App contents:write + pull_requests:write permissions on this repo\n` +
            `  (b) Ensure the user PAT has merge rights (currently the TokenProvider returned no user token, so fallback was skipped)\n` +
            `Run \`gh pr merge ${prNumber}\` manually to unblock this PR in the meantime.`
        );
      } else {
        // Re-throw for the outer catch to handle (405/422 merge conflicts, tokenOverride 403s, etc.)
        throw mergeError;
      }
    }

    const merge = mergeResponse.data;

    return {
      commitHash: merge.sha,
      mergeDate: new Date().toISOString(),
      mergedBy: pr.user?.login || "unknown",
      metadata: {
        pr_number: prNumber,
        pr_url: pr.html_url,
        merge_method: "merge",
        merged_at: new Date().toISOString(),
        owner: gh.owner,
        repo: gh.repo,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
      },
    };
  } catch (error) {
    if (error instanceof MinskyError) throw error;

    const info = classifyOctokitError(error);
    const ctx: ErrorContext = {
      operation: "merge pull request",
      owner: gh.owner,
      repo: gh.repo,
      prNumber,
    };

    // Try to diagnose merge blockers for 405/422
    if (
      info.status === 405 ||
      info.status === 422 ||
      info.messageLower.includes("405") ||
      info.messageLower.includes("422") ||
      info.messageLower.includes("merge conflicts")
    ) {
      try {
        const githubToken = await gh.getToken();
        const octokit = createOctokit(githubToken);
        const diagnosis = await diagnoseMergeBlockerFn(prNumber, octokit);
        handleMerge405or422(info, ctx, diagnosis);
      } catch (_diagnoseError) {
        handleMerge405or422(info, ctx);
      }
    }

    handleOctokitError(error, ctx);
  }
}

/**
 * Get PR details for review rendering.
 */
export async function getPullRequestDetails(
  gh: GitHubContext,
  options: { prIdentifier?: string | number; session?: string },
  getSessionDB: () => Promise<SessionProviderInterface>,
  findForBranch: (branch: string) => Promise<number>
): Promise<{
  number?: number | string;
  url?: string;
  state?: string;
  title?: string;
  body?: string;
  headBranch?: string;
  baseBranch?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
}> {
  let prNumber: number | undefined;
  if (options.prIdentifier !== undefined) {
    prNumber =
      typeof options.prIdentifier === "string"
        ? parseInt(options.prIdentifier, 10)
        : options.prIdentifier;
    if (isNaN(prNumber as number)) {
      prNumber = await findForBranch(String(options.prIdentifier));
    }
  } else if (options.session) {
    const sessionDB = await getSessionDB();
    const sessionRecord = await sessionDB.getSession(options.session);
    if (sessionRecord?.pullRequest?.number) {
      prNumber =
        typeof sessionRecord.pullRequest.number === "string"
          ? parseInt(sessionRecord.pullRequest.number, 10)
          : sessionRecord.pullRequest.number;
    } else if (sessionRecord?.pullRequest?.headBranch) {
      prNumber = await findForBranch(sessionRecord.pullRequest.headBranch);
    }
  }

  if (prNumber === undefined) {
    throw new MinskyError("Unable to resolve GitHub PR number for details retrieval");
  }

  const githubToken = await gh.getToken();
  const octokit = createOctokit(githubToken);

  const prResp = await octokit.rest.pulls.get({
    owner: gh.owner,
    repo: gh.repo,
    pull_number: prNumber,
  });
  const pr = prResp.data;
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state,
    title: pr.title || undefined,
    body: pr.body || undefined,
    headBranch: pr.head?.ref,
    baseBranch: pr.base?.ref,
    author: pr.user?.login,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at || undefined,
  };
}

/**
 * Get PR diff and optional stats.
 */
export async function getPullRequestDiff(
  gh: GitHubContext,
  options: { prIdentifier?: string | number; session?: string },
  getSessionDB: () => Promise<SessionProviderInterface>,
  findForBranch: (branch: string) => Promise<number>
): Promise<{
  diff: string;
  stats?: { filesChanged: number; insertions: number; deletions: number };
}> {
  let prNumber: number | undefined;
  if (options.prIdentifier !== undefined) {
    prNumber =
      typeof options.prIdentifier === "string"
        ? parseInt(options.prIdentifier, 10)
        : options.prIdentifier;
    if (isNaN(prNumber as number)) {
      prNumber = await findForBranch(String(options.prIdentifier));
    }
  } else if (options.session) {
    const sessionDB = await getSessionDB();
    const sessionRecord = await sessionDB.getSession(options.session);
    if (sessionRecord?.pullRequest?.number) {
      prNumber =
        typeof sessionRecord.pullRequest.number === "string"
          ? parseInt(sessionRecord.pullRequest.number, 10)
          : sessionRecord.pullRequest.number;
    } else if (sessionRecord?.pullRequest?.headBranch) {
      prNumber = await findForBranch(sessionRecord.pullRequest.headBranch);
    }
  }

  if (prNumber === undefined) {
    throw new MinskyError("Unable to resolve GitHub PR number for diff retrieval");
  }

  const githubToken = await gh.getToken();
  const octokit = new Octokit({
    auth: githubToken,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    request: {
      headers: { accept: "application/vnd.github.v3.diff" },
    },
  });

  const diffResponse = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: gh.owner,
    repo: gh.repo,
    pull_number: prNumber,
    headers: { accept: "application/vnd.github.v3.diff" },
  });
  const diff = String((diffResponse as { data?: unknown }).data || "");

  const filesResponse = await octokit.rest.pulls.listFiles({
    owner: gh.owner,
    repo: gh.repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const files = filesResponse.data;
  const stats = files.reduce(
    (
      acc: { filesChanged: number; insertions: number; deletions: number },
      f: { additions?: number; deletions?: number }
    ) => {
      acc.filesChanged += 1;
      acc.insertions += f.additions || 0;
      acc.deletions += f.deletions || 0;
      return acc;
    },
    { filesChanged: 0, insertions: 0, deletions: 0 }
  );

  return { diff, stats };
}

// ── PR review threads ───────────────────────────────────────────────────────

/**
 * A single comment within a review thread.
 */
export interface ReviewThreadComment {
  /** GitHub login of the comment author */
  author: string | null;
  /** Comment body text */
  body: string;
  /** ISO-8601 timestamp of comment creation */
  createdAt: string;
}

/**
 * A review thread (an inline diff discussion) on a pull request.
 *
 * `isOutdated` is true when the thread was anchored to a line that no longer
 * exists at the HEAD of the PR branch (e.g., due to a force-push or rebase).
 * In that case GitHub reports `line: null`.
 */
export interface ReviewThread {
  /** GitHub node ID of the thread */
  id: string;
  /** File path the thread is anchored to */
  path: string;
  /**
   * Line number the thread ends on (1-based). Null when the thread is
   * outdated (the anchored line was removed from the diff).
   */
  line: number | null;
  /**
   * First line of a multi-line thread range (1-based). Undefined for
   * single-line threads.
   */
  startLine?: number;
  /** Whether the thread has been marked resolved by a reviewer */
  isResolved: boolean;
  /** Whether the thread is outdated (anchored line no longer in the diff) */
  isOutdated: boolean;
  /** Whether the thread is collapsed in the GitHub UI */
  isCollapsed: boolean;
  /** Ordered list of comments in the thread (oldest first, up to 10) */
  comments: ReviewThreadComment[];
  /**
   * True when the thread has more than 10 comments — only the first 10 are
   * included in `comments`. The caller should display a "more comments" notice.
   */
  truncatedComments: boolean;
}

/**
 * Result of fetching PR review threads, including pagination metadata.
 */
export interface ReviewThreadsResult {
  /** The fetched threads (up to 200; see `truncated`) */
  threads: ReviewThread[];
  /**
   * True when the PR has more than 200 threads — the list is capped at 200
   * and the caller should display a "too many threads" notice.
   */
  truncated: boolean;
}

// ── GraphQL types for pullRequest.reviewThreads ──────────────────────────────

interface GraphQLReviewThreadComment {
  author: { login: string } | null;
  body: string;
  createdAt: string;
}

interface GraphQLReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  isCollapsed: boolean;
  comments: {
    totalCount: number;
    nodes: GraphQLReviewThreadComment[];
  };
}

interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GraphQLReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: GraphQLReviewThread[];
        pageInfo: GraphQLPageInfo;
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query GetPRReviewThreads($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 50, after: $after) {
          nodes {
            id
            path
            line
            startLine
            isResolved
            isOutdated
            isCollapsed
            comments(first: 10) {
              totalCount
              nodes {
                author { login }
                body
                createdAt
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const MAX_REVIEW_THREADS = 200;

/**
 * Fetch all review threads for a pull request using the GitHub GraphQL API.
 *
 * Paginates through `pullRequest.reviewThreads` (50 per page) and caps at
 * 200 threads total, setting `truncated: true` if more exist.
 *
 * Auth is routed through `gh.getToken()` — the same TokenProvider path used
 * by all other PR operations.
 *
 * Returns `{ threads: [], truncated: false }` on network, auth, or GraphQL
 * failures — the reviewer context is non-fatal and should degrade gracefully.
 * Only programmer-level errors (TypeError, etc.) from within the iteration
 * logic are unexpected; recoverable runtime errors are logged at debug level.
 *
 * @param gh GitHub context (owner, repo, token provider)
 * @param prNumber The pull request number
 * @param octokitOverride Optional Octokit instance (for testing / DI)
 */
export async function getPRReviewThreads(
  gh: GitHubContext,
  prNumber: number,
  octokitOverride?: Octokit
): Promise<ReviewThreadsResult> {
  const emptyResult: ReviewThreadsResult = { threads: [], truncated: false };

  let token: string;
  try {
    token = await gh.getToken();
  } catch (error) {
    log.debug(`getPRReviewThreads: failed to acquire token for PR #${prNumber}`, {
      error: getErrorMessage(error),
    });
    return emptyResult;
  }

  const octokit = octokitOverride ?? createOctokit(token);

  const allThreads: ReviewThread[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let truncated = false;

  while (hasNextPage) {
    let response: GraphQLReviewThreadsResponse;
    try {
      response = await octokit.graphql<GraphQLReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
        owner: gh.owner,
        repo: gh.repo,
        prNumber,
        after: cursor,
      });
    } catch (error) {
      log.debug(`getPRReviewThreads: GraphQL error for PR #${prNumber}`, {
        error: getErrorMessage(error),
      });
      return emptyResult;
    }

    // Null-guard: GraphQL returns data with null subfields (rather than throwing)
    // when the repository or pullRequest is inaccessible (cross-repo permissions,
    // PR not found in scope, 403/404). Without this guard, the dereference below
    // would throw a TypeError that escapes the per-call try/catch and breaks the
    // documented non-fatal contract.
    const page = response.repository?.pullRequest?.reviewThreads;
    if (!page) {
      log.debug(
        `getPRReviewThreads: GraphQL returned null repository or pullRequest for PR #${prNumber} (likely permissions or scope mismatch)`
      );
      return emptyResult;
    }

    for (const node of page.nodes) {
      if (allThreads.length >= MAX_REVIEW_THREADS) {
        truncated = true;
        hasNextPage = false;
        break;
      }

      allThreads.push({
        id: node.id,
        path: node.path,
        line: node.line,
        ...(node.startLine !== null ? { startLine: node.startLine } : {}),
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        isCollapsed: node.isCollapsed,
        comments: node.comments.nodes.map((c) => ({
          author: c.author?.login ?? null,
          body: c.body,
          createdAt: c.createdAt,
        })),
        truncatedComments: node.comments.totalCount > 10,
      });
    }

    if (!truncated) {
      hasNextPage = page.pageInfo.hasNextPage;
      cursor = page.pageInfo.endCursor;
    }
  }

  log.debug("Fetched PR review threads", {
    prNumber,
    threadCount: allThreads.length,
    truncated,
    owner: gh.owner,
    repo: gh.repo,
  });

  return { threads: allThreads, truncated };
}
