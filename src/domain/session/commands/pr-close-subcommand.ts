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
 * domain layer resolves session context (when available), delegates to the
 * repository backend's `pr.close` method, persists the new closed state
 * back to the session DB (when a session record exists), and returns the
 * result.
 *
 * Three addressing modes supported per SC #1:
 *  - `task` or `sessionId`: close the session's recorded PR
 *  - `prNumber`: close a specific PR by number (uses session backend when
 *    a session is also resolvable, otherwise falls back to repo-config-
 *    derived backend so operators can close ad-hoc PRs from outside any
 *    session — the absorb-and-close case where the closing actor is in a
 *    different session than the closed PR)
 *  - Both `task`/`sessionId` AND `prNumber`: `prNumber` wins as the
 *    address; the session is still used as backend source and for the
 *    post-close DB update IF the closed PR matches the session's
 *    recorded PR (otherwise the DB update is skipped to avoid corrupting
 *    the session record).
 */

import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import type { SessionProviderInterface, SessionRecord } from "../types";
import type { RepositoryBackend } from "../../repository/index";

export interface SessionPrCloseDependencies {
  sessionDB: SessionProviderInterface;
}

export interface SessionPrCloseResult {
  prNumber: number | string;
  url: string;
  state: "open" | "closed" | "merged";
  commentPosted: boolean;
  sessionRecordUpdated: boolean;
}

export async function sessionPrClose(
  params: {
    sessionId?: string;
    task?: string;
    repo?: string;
    prNumber?: string | number;
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

  // SC #1: require either a session identifier (task/sessionId) OR an
  // explicit PR number. Calling with none of these has no target.
  if (!params.sessionId && !params.task && params.prNumber === undefined) {
    throw new ValidationError(
      "session_pr_close requires one of: `task`, `sessionId`, or `prNumber`."
    );
  }

  // Resolve session when task/sessionId is provided. When only prNumber is
  // provided we skip session resolution (operator-mode ad-hoc close).
  let sessionRecord: SessionRecord | null = null;
  let resolvedSessionId: string | null = null;
  if (params.sessionId || params.task) {
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: params.sessionId,
      task: params.task,
      repo: params.repo,
      sessionProvider,
      allowAutoDetection: true,
    });
    resolvedSessionId = resolvedContext.sessionId;
    sessionRecord = (await sessionProvider.getSession(resolvedSessionId)) ?? null;
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedSessionId}' not found`);
    }
  }

  // Validate session backend when a session is resolved. Only GitHub is
  // supported for PR operations.
  if (sessionRecord && sessionRecord.backendType !== "github") {
    throw new ValidationError(
      `Session '${resolvedSessionId}' uses backend '${sessionRecord.backendType}'. ` +
        "Only GitHub-backed sessions are supported for session_pr_close."
    );
  }

  // If a session was resolved AND no prNumber override was given, the
  // session must have a recorded PR to close.
  if (sessionRecord && params.prNumber === undefined && !sessionRecord.pullRequest) {
    throw new ValidationError(
      `No GitHub pull request found for session '${resolvedSessionId}'. ` +
        "Use 'session pr create' to create a PR first, or pass `prNumber` to close a specific PR."
    );
  }

  log.debug(
    `Closing PR (sessionResolved=${Boolean(sessionRecord)}, prNumber=${params.prNumber ?? "from-session"}, commentProvided=${Boolean(params.comment && params.comment.length > 0)})`
  );

  // Construct the repository backend:
  //  - Prefer the session's backend (config baked into the session record).
  //  - Fall back to repo-config-derived backend when no session is available
  //    (prNumber-only mode).
  const repositoryBackend = await buildRepositoryBackend(sessionRecord, sessionProvider);

  // Compose ClosePROptions. If prNumber is provided it wins as the
  // address; otherwise the backend resolves the PR from the session record.
  const closeOptions: {
    prIdentifier?: string | number;
    session?: string;
    comment?: string;
  } = { comment: params.comment };
  if (params.prNumber !== undefined) {
    closeOptions.prIdentifier = params.prNumber;
  } else if (resolvedSessionId) {
    closeOptions.session = resolvedSessionId;
  }

  const prInfo = await repositoryBackend.pr.close(closeOptions);

  // Persist the new closed state back to the session DB ONLY when:
  //  (a) a session was resolved, AND
  //  (b) the closed PR matches the session's recorded PR (avoid corrupting
  //      the session record when the operator closed a different PR from
  //      within this session's context).
  let sessionRecordUpdated = false;
  if (sessionRecord && resolvedSessionId && sessionRecord.pullRequest) {
    const sessionPrNumber = Number(sessionRecord.pullRequest.number);
    const closedPrNumber = Number(prInfo.number);
    if (sessionPrNumber === closedPrNumber) {
      try {
        const closedAt =
          typeof prInfo.metadata?.closedAt === "string"
            ? prInfo.metadata.closedAt
            : new Date().toISOString();
        await sessionProvider.updateSession(resolvedSessionId, {
          lastActivityAt: new Date().toISOString(),
          pullRequest: {
            ...sessionRecord.pullRequest,
            state: "closed",
            lastSynced: closedAt,
          },
        });
        sessionRecordUpdated = true;
        log.debug(`Persisted closed state to session DB for ${resolvedSessionId}`);
      } catch (dbError) {
        // Non-fatal: the PR is already closed on GitHub. Surface as warn so
        // operators can investigate session-DB drift if it recurs.
        log.warn(
          `Failed to persist closed PR state to session DB for ${resolvedSessionId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`
        );
      }
    } else {
      log.debug(
        `Skipping session DB update — closed PR #${closedPrNumber} does not match session's recorded PR #${sessionPrNumber}`
      );
    }
  }

  return {
    prNumber: prInfo.number,
    url: prInfo.url,
    state: prInfo.state,
    commentPosted: Boolean(prInfo.metadata?.commentPosted),
    sessionRecordUpdated,
  };
}

/**
 * Build a repository backend for the close operation. When a session is
 * available, derive the backend from the session record (same path as
 * sessionPrEdit). Otherwise fall back to the repo-config-derived backend
 * (`getRepositoryBackendFromConfig`) so prNumber-only addressing works for
 * operators closing PRs from outside any session context.
 */
async function buildRepositoryBackend(
  sessionRecord: SessionRecord | null,
  sessionProvider: SessionProviderInterface
): Promise<RepositoryBackend> {
  if (sessionRecord) {
    const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
    return createRepositoryBackendFromSession(sessionRecord, sessionProvider);
  }

  // No session — construct backend from current Minsky configuration.
  const { getRepositoryBackendFromConfig } = await import("../repository-backend-detection");
  const { createRepositoryBackend, RepositoryBackendType } = await import("../../repository/index");
  const detected = await getRepositoryBackendFromConfig();
  if (detected.backendType !== RepositoryBackendType.GITHUB) {
    throw new MinskyError(
      `session_pr_close requires a GitHub-backed repository; detected backend is '${detected.backendType}'.`
    );
  }
  return createRepositoryBackend(
    {
      type: detected.backendType,
      repoUrl: detected.repoUrl,
      github: detected.github,
    },
    sessionProvider
  );
}
