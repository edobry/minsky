/**
 * Session Approval Operations (Task #358)
 *
 * This module implements session PR approval functionality,
 * enabling standard collaborative review workflows.
 */

import { log } from "../../utils/logger";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { type SessionProviderInterface } from "./session-db-adapter";
import { extractGitHubInfoFromUrl } from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";
import type { SessionRecord } from "./types";
import { assertSessionMutable } from "./session-mutability";
import type { ApprovalInfo } from "../repository/approval-types";
import type { GitServiceInterface } from "../git/types";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { WorkspaceUtilsInterface } from "../workspace";

/**
 * Create repository backend from session record's stored configuration
 * instead of auto-detecting from git remote
 */
async function createRepositoryBackendFromSession(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepositoryBackend> {
  // Determine backend type from session configuration
  let backendType: RepositoryBackendType;

  if (sessionRecord.backendType) {
    // Use explicitly set backend type
    switch (sessionRecord.backendType) {
      case "github":
        backendType = RepositoryBackendType.GITHUB;
        break;
      case "remote":
        backendType = RepositoryBackendType.REMOTE;
        break;
      case "local":
      default:
        backendType = RepositoryBackendType.LOCAL;
        break;
    }
  } else {
    // Infer backend type from repoUrl format for backward compatibility
    if (sessionRecord.repoUrl.startsWith("/") || sessionRecord.repoUrl.startsWith("file://")) {
      backendType = RepositoryBackendType.LOCAL;
    } else if (sessionRecord.repoUrl.includes("github.com")) {
      backendType = RepositoryBackendType.GITHUB;
    } else {
      backendType = RepositoryBackendType.REMOTE;
    }
  }

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: sessionRecord.repoUrl,
  };

  // Add GitHub-specific configuration by parsing from URL
  if (backendType === RepositoryBackendType.GITHUB) {
    const githubInfo = extractGitHubInfoFromUrl(sessionRecord.repoUrl);
    if (githubInfo) {
      config.github = {
        owner: githubInfo.owner,
        repo: githubInfo.repo,
      };
    }
  }

  return await createRepositoryBackend(config, sessionDB);
}

/**
 * Parameters for session approval operation
 */
export interface SessionApprovalParams {
  session?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  reviewComment?: string;
}

/**
 * Result of session approval operation
 */
export interface SessionApprovalResult {
  session: string;
  taskId?: string;
  prBranch: string;
  approvalInfo: ApprovalInfo;
  wasAlreadyApproved: boolean;
}

/**
 * Dependencies required by approveSessionPr.
 * sessionDB, gitService, taskService, and workspaceUtils are required.
 * createRepositoryBackendForSession is optional (used for testing/legacy compat).
 */
export interface SessionApprovalDependencies {
  sessionDB: SessionProviderInterface;
  gitService?: GitServiceInterface;
  taskService?: TaskServiceInterface;
  workspaceUtils?: WorkspaceUtilsInterface;
  resolveRepoPath?: (path: string) => string;
  persistenceProvider?: import("../persistence/types").BasePersistenceProvider;
  /** @deprecated Use createRepositoryBackend instead */
  createRepositoryBackendForSession?: (...args: unknown[]) => Promise<RepositoryBackend>;
}

/**
 * Approve a session's pull request (Task #358)
 *
 * This function:
 * 1. Validates the session has a PR branch
 * 2. Checks if already approved
 * 3. Calls repositoryBackend.approvePullRequest()
 * 4. Updates session record with prApproved: true
 */
export async function approveSessionPr(
  params: SessionApprovalParams,
  deps: SessionApprovalDependencies
): Promise<SessionApprovalResult> {
  if (!params.json) {
    log.cli("🔍 Starting session approval...");
  }

  const sessionDB = deps.sessionDB;

  // Resolve session ID
  let sessionIdToUse = params.session;

  if (params.task && !sessionIdToUse) {
    const sessionByTask = await sessionDB.getSessionByTaskId(params.task);
    if (!sessionByTask) {
      throw new ResourceNotFoundError(
        `No session found for task ${params.task}`,
        "session",
        params.task
      );
    }
    sessionIdToUse = sessionByTask.session;
  }

  if (!sessionIdToUse) {
    throw new ValidationError("No session detected. Please provide a session ID or task ID");
  }

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionIdToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionIdToUse}" not found`,
      "session",
      sessionIdToUse
    );
  }

  // Enforce merged-PR-freeze invariant
  assertSessionMutable(sessionRecord, "approve a pull request");

  // Validate session has a PR (either local prBranch or GitHub pullRequest)
  const hasLocalPr = sessionRecord.prBranch;
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";

  if (!hasLocalPr && !hasGitHubPr) {
    throw new ValidationError(
      `Session "${sessionIdToUse}" has no PR branch. Create a PR first with 'minsky session pr'`
    );
  }

  // Check if already approved (local backend only)
  // For GitHub backend, we delegate approval checking to the repository backend
  if (hasLocalPr && sessionRecord.prApproved) {
    if (!params.json) {
      log.cli("ℹ️  Session PR is already approved");
    }

    return {
      session: sessionIdToUse,
      taskId: sessionRecord.taskId,
      prBranch: sessionRecord.prBranch ?? "",
      approvalInfo: {
        reviewId: "already-approved",
        approvedBy: "unknown", // We don't track who approved previously
        approvedAt: new Date().toISOString(),
        prNumber: sessionRecord.prBranch ?? "",
      },
      wasAlreadyApproved: true,
    };
  }

  // Create repository backend for this session using stored configuration
  // Prefer injected factory (for testing), fall back to session record config
  const repositoryBackend = deps?.createRepositoryBackendForSession
    ? await deps.createRepositoryBackendForSession("/test/workdir")
    : await createRepositoryBackendFromSession(sessionRecord, deps!.sessionDB);

  if (!params.json) {
    log.cli(`📦 Using ${repositoryBackend.getType()} backend for approval`);
  }

  // Determine PR identifier for approval based on backend type
  let prIdentifier: string | number;
  let displayName: string;
  if (hasGitHubPr && sessionRecord.pullRequest) {
    prIdentifier = sessionRecord.pullRequest.number;
    displayName = `PR #${prIdentifier}`;
  } else if (hasLocalPr && sessionRecord.prBranch) {
    prIdentifier = sessionRecord.prBranch;
    displayName = `branch: ${prIdentifier}`;
  } else {
    throw new ValidationError("Invalid session state: no valid PR identifier found");
  }

  // Approve the PR using repository backend
  if (!params.json) {
    log.cli(`✅ Approving ${displayName}`);
  }

  const approvalInfo = await repositoryBackend.approvePullRequest(
    prIdentifier,
    params.reviewComment
  );

  // Note: Repository backend handles approval storage:
  // - GitHub backend: stores approval in GitHub
  // - Local backend: updates session record with prApproved: true

  if (!params.json) {
    log.cli("✅ Session PR approved successfully!");
    log.cli("💡 Use 'minsky session merge' to merge when ready");
  }

  return {
    session: sessionIdToUse,
    taskId: sessionRecord.taskId,
    prBranch:
      (hasLocalPr && sessionRecord.prBranch) ||
      (hasGitHubPr && sessionRecord.pullRequest?.headBranch) ||
      (typeof prIdentifier === "string" ? prIdentifier : String(prIdentifier)),
    approvalInfo,
    wasAlreadyApproved: false,
  };
}
