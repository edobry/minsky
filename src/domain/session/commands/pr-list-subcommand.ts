/**
 * Session PR List Subcommand
 */

import { MinskyError, getErrorMessage } from "../../../errors/index";
import type { SessionProviderInterface } from "../types";

export interface SessionPrListDependencies {
  sessionDB: SessionProviderInterface;
}

/**
 * Session PR List implementation
 * Lists all PRs associated with sessions
 */
export async function sessionPrList(
  params: {
    session?: string;
    task?: string;
    status?: string; // comma-separated list or 'all'
    backend?: "github";
    since?: string; // YYYY-MM-DD or relative like 7d, 24h
    until?: string; // YYYY-MM-DD or relative like 7d, 24h
    repo?: string;
    json?: boolean;
    verbose?: boolean;
  },
  deps: SessionPrListDependencies
): Promise<{
  pullRequests: Array<{
    sessionId: string;
    taskId?: string;
    prNumber?: number | string;
    status: string;
    title: string;
    url?: string;
    updatedAt?: string;
    branch?: string;
    backendType?: string;
  }>;
}> {
  const { sessionDB } = deps;

  try {
    // Get all sessions
    const sessions = await sessionDB.listSessions();

    // Apply user filters first
    let candidateSessions = sessions;

    if (params.session) {
      candidateSessions = candidateSessions.filter((s) => s.sessionId === params.session);
    }

    if (params.task) {
      const normalizedTask = params.task.replace(/^#/, "");
      candidateSessions = candidateSessions.filter(
        (s) => s.taskId?.replace(/^#/, "") === normalizedTask
      );
    }

    // Query repository backends for actual PRs (no caching, proper delegation)
    const { createRepositoryBackendFromSession } = await import("../session-pr-operations");

    const pullRequestResults = await Promise.all(
      candidateSessions.map(async (session) => {
        try {
          // Create repository backend for this session
          const repositoryBackend = await createRepositoryBackendFromSession(session, sessionDB);

          // Query the backend for PR details - this delegates to GitHub API for GitHub sessions
          const prDetails = await repositoryBackend.pr.get({
            session: session.sessionId,
          });

          // Backend found a PR - return the details with proper merged status
          const state = prDetails.state || "unknown";
          const status = prDetails.mergedAt ? "merged" : state;

          return {
            sessionId: session.sessionId,
            taskId: session.taskId,
            prNumber: prDetails.number,
            status,
            title: prDetails.title || `PR for ${session.sessionId}`,
            url: prDetails.url,
            updatedAt: prDetails.updatedAt,
            branch: prDetails.headBranch || session.sessionId,
            backendType: session.backendType,
          };
        } catch (error) {
          // No PR found for this session - don't include it in results
          return null;
        }
      })
    );

    // Filter out sessions without PRs
    const pullRequests = pullRequestResults.filter((pr) => pr !== null) as Array<{
      sessionId: string;
      taskId?: string;
      prNumber?: number | string;
      status: string;
      title: string;
      url?: string;
      updatedAt?: string;
      branch?: string;
      backendType?: string;
    }>;

    // Use shared utilities for filters
    const {
      parseStatusFilter,
      parseBackendFilter,
      parseTime,
      filterByStatus,
      filterByBackend,
      filterByTimeRange,
    } = require("../../../utils/result-handling/filters");

    const statusSet = parseStatusFilter(params.status);
    const backendFilter = parseBackendFilter(params.backend);
    const sinceTs = parseTime(params.since);
    const untilTs = parseTime(params.until);

    let byFilters = pullRequests;
    if (backendFilter) byFilters = filterByBackend(byFilters, backendFilter);
    if (statusSet) byFilters = filterByStatus(byFilters, statusSet);
    byFilters = filterByTimeRange(byFilters, sinceTs, untilTs);

    return { pullRequests: byFilters };
  } catch (error) {
    throw new MinskyError(`Failed to list session PRs: ${getErrorMessage(error)}`);
  }
}
