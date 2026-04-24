/**
 * Session PR Review Context Subcommand
 *
 * Composes all PR review data into a single call, fetching PR metadata,
 * CI checks, diff, and task spec in parallel.
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
import { createRepositoryBackendFromSession } from "../session-pr-operations";

export interface SessionPrReviewContextDependencies {
  sessionDB: SessionProviderInterface;
  taskService?: {
    getTaskSpecContent(
      taskId: string,
      section?: string
    ): Promise<{ task: unknown; specPath: string; content: string; section?: string }>;
  };
}

export interface SessionPrReviewContextParams {
  sessionId?: string;
  task?: string;
  repo?: string;
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  author: string | null;
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
  url: string | null;
  headBranch: string | null;
  baseBranch: string | null;
}

export interface ChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  details: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
  }>;
}

export interface SessionPrReviewContextResult {
  pr: PrSummary;
  checks: ChecksSummary;
  diff: string;
  taskSpec: string | null;
  taskId: string | null;
}

/**
 * Get all PR review data in a single composed call.
 * Runs PR metadata, CI checks, diff, and task spec fetches in parallel.
 */
export async function sessionPrReviewContext(
  params: SessionPrReviewContextParams,
  deps: SessionPrReviewContextDependencies
): Promise<SessionPrReviewContextResult> {
  const { sessionDB, taskService } = deps;

  try {
    // Resolve session
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: params.sessionId,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionId);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
    }

    // Require an existing PR
    const prNumber = sessionRecord.pullRequest?.number;
    if (!prNumber) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionId}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    const taskId = sessionRecord.taskId ?? null;

    // Create repository backend from session record
    const backend = await createRepositoryBackendFromSession(sessionRecord, sessionDB);

    log.debug(`Fetching PR review context for PR #${prNumber}`);

    // Fetch PR metadata, checks, and diff in parallel; task spec is independent
    const [prData, checksResult, diffResult, taskSpecContent] = await Promise.all([
      backend.pr.get({ prIdentifier: prNumber }),
      backend.ci.getChecksForPR(prNumber),
      backend.pr.getDiff({ prIdentifier: prNumber }),
      fetchTaskSpec(taskId, taskService),
    ]);

    // Normalise PR metadata into the flat return shape
    const pr: PrSummary = {
      number: typeof prData.number === "number" ? prData.number : prNumber,
      title: prData.title ?? "",
      state: prData.state ?? "unknown",
      author: prData.author ?? null,
      additions: null, // not provided by backend.pr.get()
      deletions: null,
      filesChanged: null,
      url: prData.url ?? null,
      headBranch: prData.headBranch ?? null,
      baseBranch: prData.baseBranch ?? null,
    };

    // Normalise checks
    const checks: ChecksSummary = {
      total: checksResult.summary.total,
      passed: checksResult.summary.passed,
      failed: checksResult.summary.failed,
      pending: checksResult.summary.pending,
      details: checksResult.checks.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.url,
      })),
    };

    return {
      pr,
      checks,
      diff: diffResult.diff,
      taskSpec: taskSpecContent,
      taskId,
    };
  } catch (error) {
    if (
      error instanceof ResourceNotFoundError ||
      error instanceof ValidationError ||
      error instanceof MinskyError
    ) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR review context: ${getErrorMessage(error)}`);
  }
}

/**
 * Fetch task spec content, returning null if unavailable.
 */
async function fetchTaskSpec(
  taskId: string | null,
  taskService?: SessionPrReviewContextDependencies["taskService"]
): Promise<string | null> {
  if (!taskId || !taskService) {
    return null;
  }
  try {
    const result = await taskService.getTaskSpecContent(taskId);
    return result.content;
  } catch (error) {
    log.debug(`Could not fetch task spec for ${taskId}: ${getErrorMessage(error)}`);
    return null;
  }
}
