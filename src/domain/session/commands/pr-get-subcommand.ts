/**
 * Session PR Get Subcommand
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { PullRequestInfo } from "../session-db";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
import { first } from "../../../utils/array-safety";

/**
 * Shape of the live PR data returned from GitHub Octokit pulls.get / pulls.list responses.
 * Only the fields actually consumed in this file are listed.
 */
interface GitHubLivePr {
  number: number;
  html_url: string;
  state: string;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
  changed_files?: number;
  commits?: number;
}

export interface SessionPrGetDependencies {
  sessionDB: SessionProviderInterface;
}

/**
 * Session PR Get implementation
 * Gets detailed information about a specific PR
 */
export async function sessionPrGet(
  params: {
    sessionId?: string;
    name?: string;
    task?: string;
    repo?: string;
    json?: boolean;
    backend?: "github" | "gitlab" | "bitbucket";
    status?: string; // optional constraint
    since?: string;
    until?: string;
    content?: boolean;
  },
  deps: SessionPrGetDependencies
): Promise<{
  pullRequest: {
    number?: number;
    title: string;
    sessionId: string;
    taskId?: string;
    branch: string;
    status: string;
    url?: string;
    createdAt?: string;
    updatedAt?: string;
    description?: string | null;
    spec?: string;
    author?: string;
    filesChanged?: number;
    commits?: number;
    backendType?: "github" | "gitlab" | "bitbucket";
  };
}> {
  const { sessionDB } = deps;

  try {
    // Resolve session context using existing resolver
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.sessionId || params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    // Get the session record
    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    // Check if session has PR information
    const pr = sessionRecord.pullRequest;
    const prState = sessionRecord.prState;

    let finalPullRequest = pr;
    let currentBranch = "";

    // If no PR data in session record, try to discover and repair from GitHub API
    if (!pr && sessionRecord.backendType === "github") {
      log.info(
        `No GitHub PR data in session record for ${resolvedContext.sessionId}, querying GitHub API for repair...`
      );

      try {
        // Use the repository backend to query GitHub
        const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
        const _repositoryBackend = await createRepositoryBackendFromSession(
          sessionRecord,
          sessionDB
        );

        // Query GitHub API to find PR by current branch
        const { GitService } = require("../../git");
        const gitService = new GitService(sessionDB);
        const sessionWorkdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionId);
        currentBranch = (
          await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
        ).trim();

        // Try to find PR using GitHub backend's API
        const { getConfiguration } = require("../../configuration/index");
        const { Octokit } = require("@octokit/rest");

        const config = getConfiguration();
        const githubToken = config.github.token;
        if (!githubToken) {
          throw new Error("GitHub token required");
        }

        const octokit = new Octokit({ auth: githubToken });

        // Extract owner/repo from session record
        const { extractGitHubInfoFromUrl } = require("../repository-backend-detection");
        const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
        if (!githubInfo) {
          throw new Error(`Could not extract GitHub info from URL: ${sessionRecord.repoUrl}`);
        }
        const { owner, repo } = githubInfo;

        // Query GitHub for PRs from this branch
        const { data: pulls } = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${currentBranch}`,
          state: "all", // Include open, closed, merged
        });

        if (pulls.length > 0) {
          // Found a PR! Repair the session record with essential workflow state only
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Octokit REST response type for pulls.list is untyped in our codebase
          const githubPr: any = first(pulls, "GitHub PRs for branch");
          const repairedPrData: PullRequestInfo = {
            number: githubPr.number,
            url: githubPr.html_url,
            state: githubPr.state as PullRequestInfo["state"],
            createdAt: githubPr.created_at,
            mergedAt: githubPr.merged_at || undefined,
            headBranch: githubPr.head?.ref,
            baseBranch: githubPr.base?.ref,
            lastSynced: new Date().toISOString(),
            // REMOVED: title, body, updatedAt - fetched live from GitHub API
          };

          // Update session record with discovered PR data (normalized to PullRequestInfo shape)
          await sessionDB.updateSession(resolvedContext.sessionId, { pullRequest: repairedPrData });

          log.info(`✅ Repaired session record with PR #${githubPr.number} from GitHub API`);
          finalPullRequest = repairedPrData;
        }
      } catch (repairError) {
        log.debug(`GitHub API repair failed: ${getErrorMessage(repairError)}`);
        // Continue with original no-PR-found logic below
      }
    }

    // If we have a PR but it's missing key metadata (timestamps/branch), try to enrich from GitHub
    if (
      sessionRecord.backendType === "github" &&
      finalPullRequest &&
      // Missing any of these warrants an enrichment attempt
      (!("createdAt" in finalPullRequest) ||
        !("updatedAt" in finalPullRequest) ||
        !finalPullRequest.headBranch)
    ) {
      try {
        const { getConfiguration } = require("../../configuration/index");
        const { Octokit } = require("@octokit/rest");

        const config = getConfiguration();
        const githubToken = config.github.token;
        if (!githubToken) {
          throw new Error("GitHub token required for PR enrichment");
        }

        const octokit = new Octokit({ auth: githubToken });

        // Extract owner/repo from session record
        const { extractGitHubInfoFromUrl } = require("../repository-backend-detection");
        const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
        if (!githubInfo) {
          throw new Error(`Could not extract GitHub info from URL: ${sessionRecord.repoUrl}`);
        }
        const { owner, repo } = githubInfo;

        if (finalPullRequest.number) {
          const pull_number = finalPullRequest.number;
          const { data: prDetails } = await octokit.rest.pulls.get({ owner, repo, pull_number });

          const enriched: PullRequestInfo = {
            ...finalPullRequest,
            url: prDetails.html_url || finalPullRequest.url,
            state: (prDetails.state as PullRequestInfo["state"]) || finalPullRequest.state,
            createdAt: prDetails.created_at,
            mergedAt: prDetails.merged_at || finalPullRequest.mergedAt,
            headBranch: prDetails.head?.ref || finalPullRequest.headBranch,
            baseBranch: prDetails.base?.ref || finalPullRequest.baseBranch,
            lastSynced: new Date().toISOString(),
            // REMOVED: title, body, updatedAt - fetched live from GitHub API
          };

          await sessionDB.updateSession(resolvedContext.sessionId, { pullRequest: enriched });

          finalPullRequest = enriched;
        }
      } catch (enrichError) {
        log.debug(`GitHub PR enrichment skipped: ${getErrorMessage(enrichError)}`);
      }
    }

    // If still no PR data after repair attempt, throw error
    if (!finalPullRequest && !prState?.exists) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionId}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    // For GitHub backend, get the actual git branch if we don't have it yet
    if (!currentBranch && sessionRecord.backendType === "github") {
      try {
        const { GitService } = require("../../git");
        const gitService = new GitService(sessionDB);
        const sessionWorkdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionId);
        currentBranch = (
          await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
        ).trim();
      } catch (error) {
        log.debug(`Could not get current branch: ${getErrorMessage(error)}`);
      }
    }

    // For GitHub backend, fetch live PR data from GitHub API
    let livePrData: GitHubLivePr | null = null;
    if (sessionRecord.backendType === "github" && finalPullRequest?.number) {
      try {
        const { getConfiguration } = require("../../configuration/index");
        const { Octokit } = require("@octokit/rest");

        const config = getConfiguration();
        const githubToken = config.github.token;
        if (githubToken) {
          const octokit = new Octokit({ auth: githubToken });

          // Extract owner/repo from session record
          const { extractGitHubInfoFromUrl } = require("../repository-backend-detection");
          const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
          if (githubInfo) {
            const { owner, repo } = githubInfo;
            const { data: livePr } = await octokit.rest.pulls.get({
              owner,
              repo,
              pull_number: finalPullRequest.number,
            });
            livePrData = livePr;
            log.debug(`Fetched live PR data for #${finalPullRequest.number}`);
          }
        }
      } catch (error) {
        log.debug(
          `Failed to fetch live PR data, falling back to cached: ${getErrorMessage(error)}`
        );
      }
    }

    // Build PR information using live data when available, fallback to cached
    const fp = finalPullRequest;
    const pullRequest = {
      number: fp?.number,
      title: livePrData?.title || fp?.title || `PR for ${sessionRecord.session}`,
      sessionId: sessionRecord.session,
      taskId: sessionRecord.taskId,
      branch:
        sessionRecord.backendType === "github"
          ? fp?.headBranch || currentBranch || sessionRecord.session
          : prState?.branchName || `pr/${sessionRecord.branch || sessionRecord.session}`,
      status: livePrData?.state || fp?.state || (prState?.exists ? "created" : "not_found"),
      url: livePrData?.html_url || fp?.url,
      // Use live timestamps when available
      createdAt: livePrData?.created_at || fp?.createdAt || prState?.createdAt,
      updatedAt: livePrData?.updated_at || fp?.updatedAt || prState?.lastChecked,
      description: livePrData?.body || fp?.body,
      author: livePrData?.user?.login || fp?.github?.author,
      filesChanged: fp?.filesChanged, // Keep from cache for performance
      commits: fp?.commits, // Keep from cache for performance
      backendType: sessionRecord.backendType || undefined,
    };

    // Use shared utilities for backend/status/time constraints on single PR
    const {
      parseStatusFilter,
      parseBackendFilter,
      parseTime,
    } = require("../../../utils/result-handling/filters");
    const statusSet = parseStatusFilter(params.status);
    const backendFilter = parseBackendFilter(params.backend);
    const sinceTs = parseTime(params.since);
    const untilTs = parseTime(params.until);

    if (backendFilter && pullRequest.backendType !== backendFilter) {
      throw new ResourceNotFoundError("No PR found matching the specified filters");
    }

    if (statusSet) {
      const st = (pullRequest.status || "").toLowerCase();
      if (!statusSet.has(st)) {
        throw new ResourceNotFoundError("No PR found matching the specified filters");
      }
    }

    if (sinceTs !== null || untilTs !== null) {
      if (!pullRequest.updatedAt) {
        throw new ResourceNotFoundError("No PR found matching the specified filters");
      }
      const prTs = Date.parse(pullRequest.updatedAt);
      if (Number.isNaN(prTs)) {
        throw new ResourceNotFoundError("No PR found matching the specified filters");
      }
      if (sinceTs !== null && prTs < sinceTs) {
        throw new ResourceNotFoundError("No PR found matching the specified filters");
      }
      if (untilTs !== null && prTs > untilTs) {
        throw new ResourceNotFoundError("No PR found matching the specified filters");
      }
    }

    return { pullRequest };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof ValidationError) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
  }
}
