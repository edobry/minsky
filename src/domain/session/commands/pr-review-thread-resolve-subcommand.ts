/**
 * Session PR Review Thread Resolve Subcommand
 *
 * Resolves or unresolves a GitHub PR review thread through Minsky, using
 * the configured bot / service-account identity.
 *
 * GitHub REST API does not support review-thread resolution; the mutations
 * `resolveReviewThread` / `unresolveReviewThread` are GraphQL-only. This
 * subcommand wraps both in a single action-parameterised call so callers do
 * not need to know which mutation to invoke.
 *
 * Thread IDs are the GraphQL node IDs surfaced as `node_id` on individual
 * review comments (from `GET /repos/{owner}/{repo}/pulls/{n}/comments`) or
 * as `id` on `PullRequestReviewThread` nodes in the GitHub GraphQL API.
 *
 * @see mt#1342 — the task that introduced this primitive.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import type { SessionProviderInterface } from "../types";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { createRepositoryBackend, RepositoryBackendType } from "../../repository/index";
import type { RepositoryBackendConfig } from "../../repository/index";

export interface SessionPrReviewThreadResolveDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrReviewThreadResolveParams {
  /** Session UUID or task-based alias (e.g. "mt#847") */
  sessionId?: string;
  /** Task ID — used when no explicit sessionId is provided */
  task?: string;
  /** Repository path filter */
  repo?: string;
  /**
   * GraphQL node ID of the `PullRequestReviewThread` to act on.
   *
   * Surfaced as `node_id` on individual review comments from the REST API
   * (`GET /repos/{owner}/{repo}/pulls/{n}/comments`) or as `id` on
   * `PullRequestReviewThread` nodes in the GraphQL API.
   */
  threadId: string;
  /** Whether to resolve or unresolve the thread */
  action: "resolve" | "unresolve";
}

export interface SessionPrReviewThreadResolveResult {
  /** The thread ID that was acted on */
  threadId: string;
  /** The action that was performed */
  action: "resolve" | "unresolve";
  /** Session that was used to find the PR */
  sessionId: string;
}

/**
 * Resolve or unresolve a review thread on the pull request associated with a
 * Minsky session.
 *
 * The session is resolved first (by sessionId, task, or auto-detection), then
 * the backend's `resolveReviewThread` / `unresolveReviewThread` method is called
 * via the GitHubBackend which routes through `octokit.graphql`.
 */
export async function sessionPrReviewThreadResolve(
  params: SessionPrReviewThreadResolveParams,
  deps: SessionPrReviewThreadResolveDependencies
): Promise<SessionPrReviewThreadResolveResult> {
  const { sessionDB } = deps;

  if (!params.threadId || params.threadId.trim().length === 0) {
    throw new ValidationError(
      "session.pr.review.thread.resolve requires a non-empty threadId " +
        "(the GraphQL node ID of the review thread — see PR review comment node_id)."
    );
  }

  if (params.action !== "resolve" && params.action !== "unresolve") {
    throw new ValidationError(
      `session.pr.review.thread.resolve requires action to be "resolve" or "unresolve" ` +
        `(got: "${params.action}").`
    );
  }

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

  // Only GitHub-backed sessions are supported — thread resolution is GraphQL-only
  if (sessionRecord.backendType !== "github") {
    throw new ValidationError(
      `session.pr.review.thread.resolve only supports GitHub-backed sessions. ` +
        `This session uses backend: ${sessionRecord.backendType ?? "unknown"}`
    );
  }

  // Require an existing PR so callers know the context is correct
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

  if (params.action === "resolve") {
    if (!backend.review.resolveReviewThread) {
      throw new MinskyError(
        "The repository backend for this session does not support resolveReviewThread. " +
          "Only GitHub-backed sessions support PR review thread resolution."
      );
    }

    log.debug("Resolving PR review thread via Minsky", {
      sessionId: resolvedContext.sessionId,
      prNumber,
      threadId: params.threadId,
    });

    await backend.review.resolveReviewThread(params.threadId);
  } else {
    if (!backend.review.unresolveReviewThread) {
      throw new MinskyError(
        "The repository backend for this session does not support unresolveReviewThread. " +
          "Only GitHub-backed sessions support PR review thread resolution."
      );
    }

    log.debug("Unresolving PR review thread via Minsky", {
      sessionId: resolvedContext.sessionId,
      prNumber,
      threadId: params.threadId,
    });

    await backend.review.unresolveReviewThread(params.threadId);
  }

  return {
    threadId: params.threadId,
    action: params.action,
    sessionId: resolvedContext.sessionId,
  };
}
