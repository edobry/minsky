/**
 * Session PR Review Submit Subcommand
 *
 * Posts a GitHub PR review (APPROVE, COMMENT, REQUEST_CHANGES) through Minsky,
 * using the configured bot / service-account identity.
 *
 * Read operations (fetching PR details, diff, CI status) stay on the GitHub MCP
 * server; this subcommand covers only the write path.
 *
 * Identity routing (mt#1510): COMMENT events default to the `minsky-ai`
 * implementer App; APPROVE and REQUEST_CHANGES default to the `minsky-reviewer`
 * App when configured. Callers can pass an explicit `identity` to override.
 * This supersedes the narrower event-type token workaround from mt#1065.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../errors/index";
import { log } from "@minsky/shared/logger";
import type { TokenRole } from "../../auth/token-provider";
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
  /**
   * Optional bot identity override. When omitted, the identity is derived
   * from `event` (COMMENT → implementer, APPROVE/REQUEST_CHANGES → reviewer).
   * APPROVE / REQUEST_CHANGES under the reviewer identity require
   * `github.reviewer.serviceAccount` to be configured; otherwise the
   * underlying `submitReview` raises a typed error rather than silently
   * falling back to the implementer identity.
   *
   * Supersedes the event-type token workaround from mt#1065.
   */
  identity?: TokenRole;
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
    identity: params.identity,
  });

  // mt#1510: identity routing — backend.review.submitReview reads
  // `options.identity` and resolves the role at call time. Default mapping
  // (COMMENT → implementer, APPROVE/REQUEST_CHANGES → reviewer) lives in
  // `resolveReviewerRole` inside the GitHub backend; the typed-error guard
  // for missing reviewer config lives in `assertReviewerRoleAvailable`.
  // This supersedes the event-type token workaround from mt#1065.
  const result = await backend.review.submitReview(prNumber, {
    body: params.body,
    event: params.event,
    comments: params.comments,
    identity: params.identity,
  });

  return {
    reviewId: result.reviewId,
    htmlUrl: result.htmlUrl,
    prNumber,
    sessionId: resolvedContext.sessionId,
  };
}
