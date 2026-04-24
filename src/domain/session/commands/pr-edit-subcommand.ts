/**
 * Session PR Edit Subcommand
 */

import type { PullRequestInfo } from "../session-db";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { ResourceNotFoundError, ValidationError } from "../../../errors/index";
import { log } from "../../../utils/logger";
import { readTextFile } from "../../../utils/fs";
import type { SessionProviderInterface } from "../types";
import { assertSessionMutable } from "../session-mutability";

export interface SessionPrEditDependencies {
  sessionDB: SessionProviderInterface;
}

/**
 * Session PR Edit implementation
 * Updates an existing PR for a session
 */
export async function sessionPrEdit(
  params: {
    title?: string;
    body?: string;
    bodyPath?: string;
    sessionId?: string;
    task?: string;
    repo?: string;
    debug?: boolean;
  },
  deps: SessionPrEditDependencies,
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
  updated: boolean;
}> {
  const sessionProvider = deps.sessionDB;

  // Resolve session context
  const resolvedContext = await resolveSessionContextWithFeedback({
    sessionId: params.sessionId,
    task: params.task,
    repo: params.repo,
    sessionProvider,
    allowAutoDetection: true,
  });

  // Check if session has an existing PR
  const sessionRecord = await sessionProvider.getSession(resolvedContext.sessionId);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(`Session '${resolvedContext.sessionId}' not found`);
  }

  // Enforce merged-PR-freeze invariant
  assertSessionMutable(sessionRecord, "edit a pull request");

  // Check for PR existence based on backend type
  const hasLocalPr = sessionRecord.prState && sessionRecord.prBranch;
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";

  log.debug(
    `Debug: hasLocalPr=${hasLocalPr}, hasGitHubPr=${hasGitHubPr}, backendType=${sessionRecord.backendType}`
  );

  if (!hasLocalPr && !hasGitHubPr) {
    throw new ValidationError(
      `No pull request found for session '${resolvedContext.sessionId}'. Use 'session pr create' to create a new PR.`
    );
  }

  // If no updates are provided, error
  if (!params.title && !params.body && !params.bodyPath) {
    throw new ValidationError(
      "At least one field must be provided to update: --title, --body, or --body-path"
    );
  }

  // For editing, delegate to the repository backend; conflicts are not relevant for edits

  // Import the function from the correct location
  const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
  const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord, deps.sessionDB);

  // Read body from file if bodyPath is provided but body is not
  let finalBody = params.body;
  if (params.bodyPath && !params.body) {
    try {
      finalBody = await readTextFile(params.bodyPath);
    } catch (error) {
      throw new ValidationError(`Failed to read PR body from file: ${params.bodyPath}`);
    }
  }

  // Use the repository backend's pr.update method
  const _prInfo = await repositoryBackend.pr.update({
    session: resolvedContext.sessionId,
    title: params.title,
    body: finalBody,
  });

  const result = {
    prBranch: sessionRecord.prBranch ?? "",
    baseBranch: "main",
    title: params.title,
    body: finalBody,
  };

  return {
    ...result,
    pullRequest: undefined, // Will be populated when GitHub API integration is added
    updated: true,
  };
}
