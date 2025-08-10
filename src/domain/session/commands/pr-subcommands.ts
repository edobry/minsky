/**
 * Session PR Subcommands Implementation
 * Restructure session pr command with explicit subcommands
 */

import type { SessionRecord, PullRequestInfo } from "../session-db";
import type { SessionProviderInterface } from "../types";
import { createSessionProvider } from "../";
import { createGitService } from "../../git";
import { sessionPr } from "./pr-command"; // Use modern implementation
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Session PR Create implementation
 * Replaces the current session pr command behavior
 */
export async function sessionPrCreate(
  params: {
    title?: string;
    body?: string;
    bodyPath?: string;
    name?: string;
    task?: string;
    repo?: string;
    noStatusUpdate?: boolean;
    debug?: boolean;

    autoResolveDeleteConflicts?: boolean;
    skipConflictCheck?: boolean;
  },
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
  // Delegate to existing session pr implementation
  const result = await sessionPr(
    {
      session: params.name,
      task: params.task,
      repo: params.repo,
      title: params.title || "",
      body: params.body,
      bodyPath: params.bodyPath,
      debug: params.debug || false,
      noStatusUpdate: params.noStatusUpdate || false,
      skipConflictCheck: params.skipConflictCheck || false,

      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts || false,
    },
    options
  );

  // TODO: In future implementation, also update session record with pullRequest info
  // For now, return the basic result with placeholder for pullRequest
  return {
    ...result,
    pullRequest: undefined, // Will be populated when GitHub API integration is added
  };
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
    name?: string;
    task?: string;
    repo?: string;
    debug?: boolean;
  },
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
  const sessionProvider = createSessionProvider();

  // Resolve session context
  const resolvedContext = await resolveSessionContextWithFeedback({
    session: params.name,
    task: params.task,
    repo: params.repo,
    sessionProvider,
    allowAutoDetection: true,
  });

  // Check if session has an existing PR
  const sessionRecord = await sessionProvider.getSession(resolvedContext.sessionName);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
  }

  // Check for PR existence based on backend type
  const hasLocalPr = sessionRecord.prState && sessionRecord.prBranch;
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";

  if (!hasLocalPr && !hasGitHubPr) {
    throw new ValidationError(
      `No pull request found for session '${resolvedContext.sessionName}'. Use 'session pr create' to create a new PR.`
    );
  }

  // If no updates are provided, error
  if (!params.title && !params.body && !params.bodyPath) {
    throw new ValidationError(
      "At least one field must be provided to update: --title, --body, or --body-path"
    );
  }

  // For editing, delegate to the repository backend which knows whether conflicts are relevant
  // GitHub backend: no conflicts needed (server handles it)
  // Local/Remote backends: may need conflict checking depending on implementation

  // Import the function from the correct location
  const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
  const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);

  // Read body from file if bodyPath is provided but body is not
  let finalBody = params.body;
  if (params.bodyPath && !params.body) {
    const fs = await import("fs/promises");
    try {
      finalBody = await fs.readFile(params.bodyPath, "utf-8");
    } catch (error) {
      throw new ValidationError(`Failed to read PR body from file: ${params.bodyPath}`);
    }
  }

  // Use the repository backend's updatePullRequest method
  const prInfo = await repositoryBackend.updatePullRequest({
    session: resolvedContext.sessionName,
    title: params.title,
    body: finalBody,
  });

  const result = {
    prBranch: sessionRecord.prBranch,
    baseBranch: sessionRecord.baseBranch || "main",
    title: params.title || sessionRecord.prState?.title,
    body: finalBody || sessionRecord.prState?.body,
  };

  return {
    ...result,
    pullRequest: undefined, // Will be populated when GitHub API integration is added
    updated: true,
  };
}

/**
 * Session PR List implementation
 * Lists all PRs associated with sessions
 */
export async function sessionPrList(params: {
  session?: string;
  task?: string;
  status?: "open" | "closed" | "merged" | "draft";
  repo?: string;
  json?: boolean;
  verbose?: boolean;
}): Promise<{
  pullRequests: Array<{
    sessionName: string;
    taskId?: string;
    prNumber?: number;
    status: string;
    title: string;
    url?: string;
    updatedAt?: string;
    branch?: string;
  }>;
}> {
  const sessionDB = createSessionProvider();

  try {
    // Get all sessions
    const sessions = await sessionDB.listSessions();

    // Filter sessions that have PR information
    let filteredSessions = sessions.filter((session) => {
      // Include sessions that have prState or pullRequest info
      return !!session.prState?.commitHash || session.pullRequest;
    });

    // Apply filters
    if (params.session) {
      filteredSessions = filteredSessions.filter((s) => s.session === params.session);
    }

    if (params.task) {
      const normalizedTask = params.task.replace(/^#/, "");
      filteredSessions = filteredSessions.filter(
        (s) => s.taskId?.replace(/^#/, "") === normalizedTask
      );
    }

    // Convert sessions to PR list format
    const pullRequests = filteredSessions.map((session) => {
      const pr = session.pullRequest;
      const prState = session.prState;

      return {
        sessionName: session.session,
        taskId: session.taskId,
        prNumber: pr?.number,
        status: pr?.state || (prState?.commitHash ? "created" : "not_found"),
        title: pr?.title || `PR for ${session.session}`,
        url: pr?.url,
        updatedAt: pr?.updatedAt || prState?.lastChecked,
        branch: prState?.branchName || pr?.headBranch || `pr/${session.session}`,
      };
    });

    // Apply status filter if specified
    if (params.status) {
      // Note: This filter may not work well until we have GitHub API integration
      // For now, only filter exact matches
      return {
        pullRequests: pullRequests.filter((pr) => pr.status === params.status),
      };
    }

    return { pullRequests };
  } catch (error) {
    throw new MinskyError(`Failed to list session PRs: ${getErrorMessage(error)}`);
  }
}

/**
 * Session PR Get implementation
 * Gets detailed information about a specific PR
 */
export async function sessionPrGet(params: {
  sessionName?: string;
  name?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  content?: boolean;
}): Promise<{
  pullRequest: {
    number?: number;
    title: string;
    sessionName: string;
    taskId?: string;
    branch: string;
    status: string;
    url?: string;
    createdAt?: string;
    updatedAt?: string;
    description?: string;
    author?: string;
    filesChanged?: string[];
    commits?: Array<{
      sha: string;
      message: string;
      date: string;
    }>;
  };
}> {
  const sessionDB = createSessionProvider();

  try {
    // Resolve session context using existing resolver
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.sessionName || params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    // Get the session record
    const sessionRecord = await sessionDB.getSession(resolvedContext.sessionName);

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Check if session has PR information
    const pr = sessionRecord.pullRequest;
    const prState = sessionRecord.prState;

    if (!pr && !prState?.commitHash) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionName}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    // Build PR information from available data
    const pullRequest = {
      number: pr?.number,
      title: pr?.title || `PR for ${sessionRecord.session}`,
      sessionName: sessionRecord.session,
      taskId: sessionRecord.taskId,
      branch: prState?.branchName || pr?.headBranch || `pr/${sessionRecord.session}`,
      status: pr?.state || (prState?.commitHash ? "created" : "not_found"),
      url: pr?.url,
      createdAt: pr?.createdAt || prState?.createdAt,
      updatedAt: pr?.updatedAt || prState?.lastChecked,
      description: pr?.body,
      author: pr?.github?.author,
      filesChanged: pr?.filesChanged,
      commits: pr?.commits,
    };

    // TODO: If content is requested and we don't have cached data,
    // we should fetch from GitHub API in future implementation
    if (params.content && !pullRequest.description) {
      log.info("Content requested but not available in cache. GitHub API integration needed.");
    }

    return { pullRequest };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof ValidationError) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
  }
}
