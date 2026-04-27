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
  /** Optional — when provided, task status is advanced to IN-REVIEW on successful PR creation. */
  taskService?: import("../../tasks/taskService").TaskServiceInterface;
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
  const { sessionDB, persistenceProvider, askRepository, taskService } = deps;

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
    { sessionDB, gitService, persistenceProvider, taskService },
    options
  );

  // Best-effort: file a quality.review Ask on successful PR creation.
  // Failure here must NOT fail the PR creation response.
  if (askRepository) {
    try {
      const sessionId = result.sessionId ?? params.sessionId;
      const taskId = result.session?.taskId ?? params.task;
      await fileQualityReviewAsk(askRepository, {
        prUrl: result.url,
        sessionId,
        taskId,
        body: params.body,
      });
      log.debug("Filed quality.review Ask for PR", {
        prUrl: result.url,
        sessionId,
        taskId,
      });
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
 * Parse a GitHub pull request URL into its `{owner, repo, prNumber}` parts.
 *
 * Canonical form: `https://github.com/<owner>/<repo>/pull/<number>`. Returns
 * `undefined` when the URL does not match.
 */
export function parseGithubPrUrl(
  url: string
): { owner: string; repo: string; prNumber: number } | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return undefined;
  const owner = match[1];
  const repo = match[2];
  const numStr = match[3];
  if (!owner || !repo || !numStr) return undefined;
  const prNumber = parseInt(numStr, 10);
  if (isNaN(prNumber)) return undefined;
  return { owner, repo, prNumber };
}

/**
 * Extract the PR number from a GitHub pull request URL.
 *
 * Returns `undefined` for non-matching or malformed URLs.
 */
export function parsePrNumber(url: string): number | undefined {
  return parseGithubPrUrl(url)?.prNumber;
}

/**
 * File a `quality.review` Ask for a successfully-created PR.
 *
 * The contextRef is written in canonical form (`github-pr:<owner>/<repo>/<n>`)
 * so the reconciler's `parsePrRef` can route it. The full PR URL is preserved
 * in the contextRef `description` for click-through and notification surfaces.
 *
 * Non-fatal — callers should wrap in try/catch and swallow errors so that
 * PR creation never fails on Ask-insert failure.
 */
export async function fileQualityReviewAsk(
  askRepository: AskRepository,
  params: {
    prUrl?: string;
    sessionId?: string;
    taskId?: string;
    body?: string;
  }
): Promise<void> {
  const parsed = params.prUrl ? parseGithubPrUrl(params.prUrl) : undefined;
  const prNumber = parsed?.prNumber;
  const canonicalRef = parsed
    ? `github-pr:${parsed.owner}/${parsed.repo}/${parsed.prNumber}`
    : undefined;

  const contextRefs =
    canonicalRef && params.prUrl
      ? [
          {
            kind: "github-pr",
            ref: canonicalRef,
            description:
              prNumber != null ? `PR #${prNumber} (${params.prUrl})` : `PR (${params.prUrl})`,
          },
        ]
      : [];

  await askRepository.create({
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    requestor: params.sessionId ?? "minsky.session:unknown",
    parentSessionId: params.sessionId,
    parentTaskId: params.taskId,
    title: prNumber != null ? `Review PR #${prNumber}` : "Review PR",
    question: params.body ?? "Review the changes in this PR.",
    contextRefs,
    metadata: {},
  });
}
