/**
 * Session PR Review Dismiss Subcommand
 *
 * Dismisses a stale or superseded GitHub PR review through Minsky, using the
 * configured bot / service-account identity. Typical use: after addressing a
 * reviewer's CHANGES_REQUESTED finding in a follow-up commit, dismiss the
 * stale review so the PR's aggregate state no longer blocks merge.
 *
 * Read operations stay on the GitHub MCP server; this subcommand covers the
 * dismissal write path.
 *
 * @see mt#1142 — the structural gap this fills (prior to this tool, stale
 *     adversarial reviews could only be dismissed via the GitHub UI because
 *     the GitHub MCP `pull_request_review_write` tool is banned by mt#1030).
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackendConfig } from "../../repository/index";

export interface SessionPrReviewDismissDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrReviewDismissParams {
  /** Session UUID or task-based alias (e.g. "mt#847") */
  sessionId?: string;
  /** Convenience alias — same as sessionId */
  name?: string;
  /** Task ID — used when no explicit sessionId is provided */
  task?: string;
  /** Repository path filter */
  repo?: string;
  /** GitHub review ID to dismiss (numeric) */
  reviewId: number;
  /** Dismissal message — required by the GitHub API and shown on the dismissed review */
  message: string;
}

export interface SessionPrReviewDismissResult {
  /** GitHub review ID that was dismissed */
  reviewId: number;
  /** Web URL of the dismissed review */
  htmlUrl: string;
  /** Final review state after dismissal (expected: "DISMISSED") */
  state: string;
  /** PR number the dismissal applied to */
  prNumber: number;
  /** Session that was used to find the PR */
  sessionId: string;
}

/**
 * Dismiss a review on the pull request associated with a Minsky session.
 */
export async function sessionPrReviewDismiss(
  params: SessionPrReviewDismissParams,
  deps: SessionPrReviewDismissDependencies
): Promise<SessionPrReviewDismissResult> {
  const { sessionDB } = deps;

  if (!params.message || params.message.trim().length === 0) {
    throw new ValidationError(
      "session.pr.review.dismiss requires a non-empty message explaining the dismissal."
    );
  }
  if (!Number.isInteger(params.reviewId) || params.reviewId <= 0) {
    throw new ValidationError(
      `session.pr.review.dismiss requires a positive integer reviewId (got: ${params.reviewId}).`
    );
  }

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

  if (sessionRecord.backendType !== "github") {
    throw new ValidationError(
      `session.pr.review.dismiss only supports GitHub-backed sessions. ` +
        `This session uses backend: ${sessionRecord.backendType ?? "unknown"}`
    );
  }

  const prNumber = sessionRecord.pullRequest?.number;
  if (!prNumber) {
    throw new ResourceNotFoundError(
      `No pull request found for session '${resolvedContext.sessionId}'. ` +
        `Use 'minsky session pr create' to create a PR first.`
    );
  }

  const config: RepositoryBackendConfig = {
    type: RepositoryBackendType.GITHUB,
    repoUrl: sessionRecord.repoUrl,
  };
  const backend = await createRepositoryBackend(config, sessionDB);

  if (!backend.review.dismissReview) {
    throw new MinskyError(
      "The repository backend for this session does not support dismissReview. " +
        "Only GitHub-backed sessions support PR review dismissal."
    );
  }

  log.debug("Dismissing PR review via Minsky", {
    sessionId: resolvedContext.sessionId,
    prNumber,
    reviewId: params.reviewId,
  });

  const result = await backend.review.dismissReview(prNumber, params.reviewId, {
    message: params.message,
  });

  return {
    reviewId: result.reviewId,
    htmlUrl: result.htmlUrl,
    state: result.state,
    prNumber,
    sessionId: resolvedContext.sessionId,
  };
}
