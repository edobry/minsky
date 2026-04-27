/**
 * Session PR Review Submit Subcommand
 *
 * Posts a GitHub PR review (APPROVE, COMMENT, REQUEST_CHANGES) through Minsky,
 * using the configured bot / service-account identity.
 *
 * Read operations (fetching PR details, diff, CI status) stay on the GitHub MCP
 * server; this subcommand covers only the write path.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackendConfig } from "../../repository/index";
import type { ReviewComment } from "../../repository/github-pr-review";

export interface SessionPrReviewSubmitDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrReviewSubmitParams {
  /** Session UUID or task-based alias (e.g. "mt#847") */
  sessionId?: string;
  /** Task ID — used when no explicit sessionId is provided */
  task?: string;
  /** Repository path filter */
  repo?: string;
  /** Overall review body text */
  body: string;
  /** Review event type */
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  /** Optional inline line-level comments */
  comments?: ReviewComment[];
}

export interface SessionPrReviewSubmitResult {
  /** GitHub review ID */
  reviewId: number;
  /** Web URL of the submitted review */
  htmlUrl: string;
  /** PR number the review was submitted on */
  prNumber: number;
  /** Session that was used to find the PR */
  sessionId: string;
}

/**
 * Submit a review on the pull request associated with a Minsky session.
 *
 * The session is resolved first (by sessionId, task, or auto-detection), then
 * the PR number is read from the session record, and finally the review is
 * posted via the GitHubBackend's submitReview() method.
 */
export async function sessionPrReviewSubmit(
  params: SessionPrReviewSubmitParams,
  deps: SessionPrReviewSubmitDependencies
): Promise<SessionPrReviewSubmitResult> {
  const { sessionDB } = deps;

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

  // Only GitHub-backed sessions are supported for review submission
  if (sessionRecord.backendType !== "github") {
    throw new ValidationError(
      `session.pr.review.submit only supports GitHub-backed sessions. ` +
        `This session uses backend: ${sessionRecord.backendType ?? "unknown"}`
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

  // Build repository backend (picks up TokenProvider with bot token when configured)
  const config: RepositoryBackendConfig = {
    type: RepositoryBackendType.GITHUB,
    repoUrl: sessionRecord.repoUrl,
  };
  const backend = await createRepositoryBackend(config, sessionDB);

  if (!backend.review.submitReview) {
    throw new MinskyError(
      "The repository backend for this session does not support submitReview. " +
        "Only GitHub-backed sessions support PR review submission."
    );
  }

  log.debug("Submitting PR review via Minsky", {
    sessionId: resolvedContext.sessionId,
    prNumber,
    event: params.event,
  });

  const result = await backend.review.submitReview(prNumber, {
    body: params.body,
    event: params.event,
    comments: params.comments,
  });

  return {
    reviewId: result.reviewId,
    htmlUrl: result.htmlUrl,
    prNumber,
    sessionId: resolvedContext.sessionId,
  };
}
