/**
 * GitHub PR lifecycle operations extracted from GitHubBackend.
 *
 * Contains: createPullRequest, updatePullRequest, mergePullRequest,
 * getPullRequestDetails, getPullRequestDiff.
 *
 * Each function receives its dependencies explicitly (Octokit, owner/repo,
 * session helpers) so the main class stays a thin delegation layer.
 */

import { Octokit } from "@octokit/rest";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { execGitWithTimeout } from "../../utils/git-exec";
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
  getToken: () => Promise<string>;
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
 * Merge a GitHub pull request.
 */
export async function mergePullRequest(
  gh: GitHubContext,
  prIdentifier: string | number,
  diagnoseMergeBlockerFn: (prNumber: number, octokit: Octokit) => Promise<string>,
  mergeTrailers?: string,
  tokenOverride?: () => Promise<string>
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
    const commitMessage = mergeTrailers ? baseMessage + mergeTrailers : baseMessage;

    const mergeResponse = await octokit.rest.pulls.merge({
      owner: gh.owner,
      repo: gh.repo,
      pull_number: prNumber,
      merge_method: "merge",
      commit_title: pr.title || `Merge pull request #${prNumber} from ${pr.head.ref}`,
      commit_message: commitMessage,
    });

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
