/**
 * Session PR Close Subcommand (mt#1955)
 *
 * Closes a session's pull request WITHOUT merging, optionally posting a
 * comment before the state flip. Closes the gap surfaced by mt#1936 / PR
 * #682 (absorb-and-close pattern), where the Minsky MCP surface had no way
 * to close a PR without merging — `gh pr close` from the operator terminal
 * was the only path.
 *
 * Architectural precedent: this file mirrors `pr-edit-subcommand.ts`. The
 * domain layer resolves session context, delegates to the repository
 * backend's `pr.close` method, and returns the result.
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import type { SessionProviderInterface } from "../types";

export interface SessionPrCloseDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrCloseResult {
  prNumber: number | string;
  url: string;
  state: "open" | "closed" | "merged";
  commentPosted: boolean;
}

/**
 * Close a session's PR without merging. Optionally posts a comment first.
 *
 * Refuses to close already-closed or already-merged PRs (the underlying
 * `closePullRequest` checks the live state via the GitHub API and throws a
 * clear error rather than returning a silent no-op).
 */
export async function sessionPrClose(
  params: {
    sessionId?: string;
    task?: string;
    repo?: string;
    comment?: string;
    debug?: boolean;
  },
  deps: SessionPrCloseDependencies,
  _options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
  }
): Promise<SessionPrCloseResult> {
  const sessionProvider = deps.sessionDB;

  const resolvedContext = await resolveSessionContextWithFeedback({
    sessionId: params.sessionId,
    task: params.task,
    repo: params.repo,
    sessionProvider,
    allowAutoDetection: true,
  });

  const sessionRecord = await sessionProvider.getSession(resolvedContext.sessionId);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
  }

  // Note: we intentionally do NOT call assertSessionMutable here. Closing a
  // merged PR is blocked by the live-state check in closePullRequest itself
  // (which queries the GitHub API), and the session-mutability invariant is
  // about freezing the session post-merge — not about the close operation
  // per se. Closing an unmerged PR on a mutable session is a normal
  // operation.

  // Only GitHub backend is supported for PR close (consistent with the rest
  // of the session_pr_* family).
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";
  if (!hasGitHubPr) {
    throw new ValidationError(
      `No GitHub pull request found for session '${resolvedContext.sessionId}'. ` +
        "Use 'session pr create' to create a PR first."
    );
  }

  log.debug(
    `Closing PR for session ${resolvedContext.sessionId} (comment provided: ${Boolean(params.comment && params.comment.length > 0)})`
  );

  const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
  const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord, deps.sessionDB);

  const prInfo = await repositoryBackend.pr.close({
    session: resolvedContext.sessionId,
    comment: params.comment,
  });

  return {
    prNumber: prInfo.number,
    url: prInfo.url,
    state: prInfo.state,
    commentPosted: Boolean(prInfo.metadata?.commentPosted),
  };
}
