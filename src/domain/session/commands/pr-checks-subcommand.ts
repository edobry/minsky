/**
 * Session PR Checks Subcommand
 *
 * Reports CI check-run status for the pull request associated with a session.
 * Supports an optional wait/polling mode that blocks until all checks complete
 * (or the timeout is reached).
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
import { requireGitHubToken, createOctokit } from "../../repository/github-pr-operations";
import { extractGitHubInfoFromUrl } from "../repository-backend-detection";
import { getCheckRunsForRef, type ChecksResult } from "../../repository/github-pr-checks";

export interface SessionPrChecksDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrChecksParams {
  sessionId?: string;
  name?: string;
  task?: string;
  repo?: string;
  /** When true, poll until all checks complete (or timeout). */
  wait?: boolean;
  /** Maximum seconds to wait when wait=true (default: 600). */
  timeoutSeconds?: number;
  /** Polling interval in seconds when wait=true (default: 30). */
  intervalSeconds?: number;
}

/**
 * Get (and optionally wait for) CI check status for a session pull request.
 */
export async function sessionPrChecks(
  params: SessionPrChecksParams,
  deps: SessionPrChecksDependencies
): Promise<ChecksResult> {
  const { sessionDB } = deps;
  const timeoutMs = (params.timeoutSeconds ?? 600) * 1000;
  const intervalMs = (params.intervalSeconds ?? 30) * 1000;

  try {
    // Resolve session
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.sessionId ?? params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    // Require GitHub backend
    if (sessionRecord.backendType !== "github") {
      throw new ValidationError(
        `session.pr.checks only supports GitHub-backed sessions. ` +
          `This session uses backend: ${sessionRecord.backendType ?? "local"}`
      );
    }

    // Require an existing PR
    const prNumber = sessionRecord.pullRequest?.number;
    if (!prNumber) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionId}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    // Resolve owner/repo from the session's remote URL
    const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl ?? "");
    if (!githubInfo) {
      throw new MinskyError(
        `Could not extract GitHub owner/repo from session URL: ${sessionRecord.repoUrl}`
      );
    }
    const gh = githubInfo;

    // Authenticate
    const token = requireGitHubToken();
    const octokit = createOctokit(token);

    /**
     * Inner helper: fetch the head SHA from the PR and then retrieve checks.
     */
    async function fetchChecks(): Promise<ChecksResult> {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: gh.owner,
        repo: gh.repo,
        pull_number: prNumber!,
      });

      const headSha: string = pr.head.sha;
      log.debug(`Fetching checks for PR #${prNumber} (SHA: ${headSha})`);

      return getCheckRunsForRef(gh, headSha, octokit);
    }

    // Non-wait mode: single fetch
    if (!params.wait) {
      return fetchChecks();
    }

    // Wait mode: poll until all checks complete or timeout
    const deadline = Date.now() + timeoutMs;
    let result = await fetchChecks();

    while (!result.allPassed && result.summary.pending > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const sleepMs = Math.min(intervalMs, remaining);
      if (sleepMs <= 0) break;

      log.info(
        `Waiting for ${result.summary.pending} pending check(s)... ` +
          `(${Math.round(remaining / 1000)}s remaining)`
      );

      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      result = await fetchChecks();
    }

    if (!result.allPassed && result.summary.pending > 0) {
      return { ...result, timedOut: true };
    }

    return result;
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR checks: ${getErrorMessage(error)}`);
  }
}
