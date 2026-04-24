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

export interface SessionPrCreateDependencies {
  sessionDB: SessionProviderInterface;
  persistenceProvider?: import("../../persistence/types").PersistenceProvider;
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
  pullRequest?: PullRequestInfo;
}> {
  const { sessionDB, persistenceProvider } = deps;

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

  return {
    ...result, // Includes url field from sessionPrImpl
    pullRequest: undefined, // Will be populated from session record if needed
  };
}
