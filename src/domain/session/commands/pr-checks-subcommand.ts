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
import type { ChecksResult } from "../../repository/index";
import { createRepositoryBackendFromSession } from "../session-pr-operations";

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
      sessionId: params.sessionId ?? params.name,
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

    // Create repository backend from session record
    const backend = await createRepositoryBackendFromSession(sessionRecord, deps.sessionDB);

    /**
     * Inner helper: fetch checks via the backend's CI sub-interface.
     */
    async function fetchChecks(): Promise<ChecksResult> {
      log.debug(`Fetching checks for PR #${prNumber}`);
      return backend.ci.getChecksForPR(prNumber as number);
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
