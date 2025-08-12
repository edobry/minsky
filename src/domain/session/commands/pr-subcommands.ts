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
import { createRepositoryBackendFromSession } from "../session-pr-operations";
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
    draft?: boolean;
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
  // Handle draft mode - validate GitHub backend but use normal session PR flow
  if (params.draft) {
    // Validate GitHub backend requirement for draft mode
    const sessionProvider = createSessionProvider();
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider,
      allowAutoDetection: true,
    });

    const sessionRecord = await sessionProvider.getSession(resolvedContext.sessionName);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);
    if (repositoryBackend.constructor.name !== "GitHubBackend") {
      throw new ValidationError(
        "Draft mode is only supported for GitHub repositories. Current session uses a different repository backend."
      );
    }
  }

  // Delegate to existing session pr implementation (works for both draft and regular PRs)
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
      draft: params.draft || false,

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

  console.log(
    `Debug: hasLocalPr=${hasLocalPr}, hasGitHubPr=${hasGitHubPr}, backendType=${sessionRecord.backendType}`
  );

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

    let finalPullRequest = pr;
    let currentBranch = "";

    // If no PR data in session record, try to discover and repair from GitHub API
    if (!pr && sessionRecord.backendType === "github") {
      log.info(
        `No GitHub PR data in session record for ${resolvedContext.sessionName}, querying GitHub API for repair...`
      );

      try {
        // Use the repository backend to query GitHub
        const { createRepositoryBackendFromSession } = await import("../session-pr-operations");
        const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);

        // Query GitHub API to find PR by current branch
        const { GitService } = require("../../git");
        const gitService = new GitService(sessionDB);
        const sessionWorkdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionName);
        currentBranch = (
          await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
        ).trim();

        // Try to find PR using GitHub backend's API
        const { getConfiguration } = require("../../configuration/index");
        const { Octokit } = require("@octokit/rest");

        const config = getConfiguration();
        const githubToken = config.github.token;
        if (!githubToken) {
          throw new Error("GitHub token required");
        }

        const octokit = new Octokit({ auth: githubToken });

        // Extract owner/repo from session record
        const { extractGitHubInfoFromUrl } = require("../repository-backend-detection");
        const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
        if (!githubInfo) {
          throw new Error(`Could not extract GitHub info from URL: ${sessionRecord.repoUrl}`);
        }
        const { owner, repo } = githubInfo;

        // Query GitHub for PRs from this branch
        const { data: pulls } = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${currentBranch}`,
          state: "all", // Include open, closed, merged
        });

        if (pulls.length > 0) {
          // Found a PR! Repair the session record
          const githubPr = pulls[0]; // Take the first (most recent)
          const repairedPrData = {
            number: githubPr.number,
            url: githubPr.html_url,
            state: githubPr.state,
            id: githubPr.id,
            created_at: githubPr.created_at,
            updated_at: githubPr.updated_at,
            title: githubPr.title,
            body: githubPr.body || undefined,
          };

          // Update session record with discovered PR data
          const updatedSession = {
            ...sessionRecord,
            pullRequest: repairedPrData,
          };
          await sessionDB.updateSession(resolvedContext.sessionName, updatedSession);

          log.info(`✅ Repaired session record with PR #${githubPr.number} from GitHub API`);
          finalPullRequest = repairedPrData;
        }
      } catch (repairError) {
        log.debug(`GitHub API repair failed: ${getErrorMessage(repairError)}`);
        // Continue with original no-PR-found logic below
      }
    }

    // If still no PR data after repair attempt, throw error
    if (!finalPullRequest && !prState?.commitHash) {
      throw new ResourceNotFoundError(
        `No pull request found for session '${resolvedContext.sessionName}'. ` +
          `Use 'minsky session pr create' to create a PR first.`
      );
    }

    // For GitHub backend, get the actual git branch if we don't have it yet
    if (!currentBranch && sessionRecord.backendType === "github") {
      try {
        const { GitService } = require("../../git");
        const gitService = new GitService(sessionDB);
        const sessionWorkdir = await sessionDB.getSessionWorkdir(resolvedContext.sessionName);
        currentBranch = (
          await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
        ).trim();
      } catch (error) {
        log.debug(`Could not get current branch: ${getErrorMessage(error)}`);
      }
    }

    // Build PR information from available data (either original or repaired)
    const pullRequest = {
      number: finalPullRequest?.number,
      title: finalPullRequest?.title || `PR for ${sessionRecord.session}`,
      sessionName: sessionRecord.session,
      taskId: sessionRecord.taskId,
      branch:
        sessionRecord.backendType === "github"
          ? currentBranch || finalPullRequest?.headBranch || sessionRecord.session
          : prState?.branchName || `pr/${sessionRecord.session}`,
      status: finalPullRequest?.state || (prState?.commitHash ? "created" : "not_found"),
      url: finalPullRequest?.url,
      createdAt: finalPullRequest?.created_at || prState?.createdAt,
      updatedAt: finalPullRequest?.updated_at || prState?.lastChecked,
      description: finalPullRequest?.body,
      author: finalPullRequest?.github?.author,
      filesChanged: finalPullRequest?.filesChanged,
      commits: finalPullRequest?.commits,
    };

    return { pullRequest };
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof ValidationError) {
      throw error;
    }
    throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
  }
}
