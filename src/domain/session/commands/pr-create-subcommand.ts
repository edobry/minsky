/**
 * Session PR Create Subcommand
 */

import type { PullRequestInfo } from "../session-db";
import { createGitService } from "../../git";
import { sessionPr } from "./pr-command";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import { ResourceNotFoundError, ValidationError } from "../../../errors/index";
import type { SessionProviderInterface } from "../types";
import type { AskRepository } from "../../ask/repository";
import { log } from "../../../utils/logger";

export interface SessionPrCreateDependencies {
  sessionDB: SessionProviderInterface;
  persistenceProvider?: import("../../persistence/types").PersistenceProvider;
  /** Optional — when provided, a quality.review Ask row is filed on successful PR creation. */
  askRepository?: AskRepository;
}

/**
 * Session PR Create implementation
 * Replaces the current session pr command behavior
 */
export async function sessionPrCreate(
  params: {
    title?: string;
    body?: string;
    bodyPath?: string;
    sessionId?: string;
    task?: string;
    repo?: string;
    noStatusUpdate?: boolean;
    debug?: boolean;

    autoResolveDeleteConflicts?: boolean;
    skipConflictCheck?: boolean;
    draft?: boolean;
  },
  deps: SessionPrCreateDependencies,
  options?: {
    interface?: "cli" | "mcp";
    workingDirectory?: string;
  }
): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
  url?: string;
  pullRequest?: PullRequestInfo;
}> {
  const { sessionDB, persistenceProvider, askRepository } = deps;

  // Validate draft mode requirements
  if (params.draft) {
    // Validate backend type for draft mode
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

    const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord, sessionDB);
    if (repositoryBackend.constructor.name !== "GitHubBackend") {
      throw new ValidationError(
        "Draft mode is only supported for GitHub repositories. Current session uses a different repository backend."
      );
    }
  }

  // Create gitService for the sessionPr call
  const gitService = createGitService();

  // Delegate to existing session pr implementation (handles both draft and regular PRs)
  const result = await sessionPr(
    {
      session: params.sessionId,
      task: params.task,
      repo: params.repo,
      title: params.title || "",
      body: params.body,
      bodyPath: params.bodyPath,
      debug: params.debug || false,
      noStatusUpdate: params.noStatusUpdate || false,
      skipConflictCheck: params.skipConflictCheck || false,
      draft: params.draft || false,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts || false,
    },
    { sessionDB, gitService, persistenceProvider },
    options
  );

  // Best-effort: file a quality.review Ask on successful PR creation.
  // Failure here must NOT fail the PR creation response.
  if (askRepository) {
    try {
      const prUrl = result.url;
      const prNumber = prUrl ? parsePrNumber(prUrl) : undefined;
      const sessionId = result.sessionId ?? params.sessionId;
      const taskId = result.session?.taskId ?? params.task;

      await askRepository.create({
        kind: "quality.review",
        classifierVersion: "v1.0.0",
        requestor: sessionId ?? "minsky.session:unknown",
        parentSessionId: sessionId,
        parentTaskId: taskId,
        title: prNumber != null ? `Review PR #${prNumber}` : "Review PR",
        question: params.body ?? "Review the changes in this PR.",
        contextRefs: prUrl
          ? [
              {
                kind: "github-pr",
                ref: prUrl,
                description: prNumber != null ? `PR #${prNumber}` : "PR",
              },
            ]
          : [],
        metadata: {},
      });
      log.debug("Filed quality.review Ask for PR", { prUrl, prNumber, sessionId, taskId });
    } catch (askError) {
      // Non-fatal: log and continue so PR creation always succeeds.
      log.warn(`Failed to file quality.review Ask after PR creation: ${askError}`);
    }
  }

  return {
    ...result, // Includes url field from sessionPrImpl
    pullRequest: undefined, // Will be populated from session record if needed
  };
}

/**
 * Extract the PR number from a GitHub pull request URL.
 *
 * Handles the canonical form: https://github.com/<owner>/<repo>/pull/<number>
 * Returns `undefined` for non-matching or malformed URLs.
 */
export function parsePrNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match || !match[1]) return undefined;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? undefined : n;
}
