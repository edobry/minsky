/**
 * Session Merge Operations (Task #358)
 *
 * This module implements session PR merge functionality that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 */

import { log } from "../../utils/logger";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import {
  detectRepositoryBackendTypeFromUrl,
  extractGitHubInfoFromUrl,
} from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackendConfig,
  type MergeInfo,
} from "../repository/index";
import type { SessionRecord } from "./types";

/**
 * CRITICAL: Validate that a session is approved before allowing merge
 *
 * This function enforces the approval requirement across all merge operations.
 * NO MERGE SHOULD EVER BYPASS THIS VALIDATION.
 */
export function validateSessionApprovedForMerge(
  sessionRecord: SessionRecord,
  sessionName: string
): void {
  // Check 1: PR branch must exist
  if (!sessionRecord.prBranch) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Session "${sessionName}" has no PR branch.\n` +
        `   Create a PR first with 'minsky session pr create'`
    );
  }

  // Check 2: PR must be explicitly approved
  if (!sessionRecord.prApproved) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Session "${sessionName}" PR must be approved before merging.\n` +
        `   Use 'minsky session pr approve' first to approve the PR.\n` +
        `   This validation prevents unauthorized merges and ensures proper code review.`
    );
  }

  // Check 3: Explicit boolean check (not just truthy)
  if (sessionRecord.prApproved !== true) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Invalid approval state for session "${sessionName}".\n` +
        `   prApproved value: ${sessionRecord.prApproved} (type: ${typeof sessionRecord.prApproved})\n` +
        `   Expected: true (boolean)\n` +
        `   The approval state must be explicitly set to true.`
    );
  }

  log.debug("Session approval validation passed", {
    sessionName,
    prBranch: sessionRecord.prBranch,
    prApproved: sessionRecord.prApproved,
  });
}

/**
 * Parameters for session merge operation
 */
export interface SessionMergeParams {
  session?: string;
  task?: string;
  repo?: string;
  json?: boolean;
}

/**
 * Result of session merge operation
 */
export interface SessionMergeResult {
  session: string;
  taskId?: string;
  prBranch: string;
  mergeInfo: MergeInfo;
}

/**
 * Merge a session's approved pull request (Task #358)
 *
 * This function:
 * 1. Validates the session has a PR branch
 * 2. Validates the PR is approved (prApproved: true)
 * 3. Calls repositoryBackend.mergePullRequest()
 * 4. Updates session record
 *
 * Requires the PR to be approved first.
 */
export async function mergeSessionPr(
  params: SessionMergeParams,
  deps?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<SessionMergeResult> {
  if (!params.json) {
    log.cli("🔄 Starting session merge...");
  }

  // Set up session provider
  const sessionDB = deps?.sessionDB || createSessionProvider();

  // Resolve session name
  let sessionNameToUse = params.session;

  if (params.task && !sessionNameToUse) {
    const sessionByTask = await sessionDB.getSessionByTaskId(params.task);
    if (!sessionByTask) {
      throw new ResourceNotFoundError(
        `No session found for task ${params.task}`,
        "session",
        params.task
      );
    }
    sessionNameToUse = sessionByTask.session;
  }

  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // CRITICAL SECURITY VALIDATION: Use centralized approval validation
  // This ensures consistent security enforcement across all merge operations
  validateSessionApprovedForMerge(sessionRecord, sessionNameToUse);

  // Create repository backend for this session
  // Use stored repoUrl for backend detection to avoid redundant git commands
  const repoUrl = params.repo || sessionRecord.repoUrl || process.cwd();
  const backendType = detectRepositoryBackendTypeFromUrl(repoUrl);

  // For merge operations, we still need a working directory (session workspace)
  const workingDirectory = await sessionDB.getSessionWorkdir(sessionNameToUse);

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: repoUrl,
  };

  // Add GitHub-specific configuration if detected
  if (backendType === RepositoryBackendType.GITHUB) {
    const githubInfo = extractGitHubInfoFromUrl(repoUrl);
    if (githubInfo) {
      config.github = {
        owner: githubInfo.owner,
        repo: githubInfo.repo,
      };
    }
  }

  const repositoryBackend = await createRepositoryBackend(config);

  if (!params.json) {
    log.cli(`📦 Using ${repositoryBackend.getType()} backend for merge`);
  }

  // Merge the approved PR using repository backend
  if (!params.json) {
    log.cli(`🔀 Merging approved PR for branch: ${sessionRecord.prBranch}`);
  }

  const mergeInfo = await repositoryBackend.mergePullRequest(
    sessionRecord.prBranch,
    sessionNameToUse
  );

  if (!params.json) {
    log.cli("✅ Session PR merged successfully!");
    log.cli(`📝 Merge commit: ${mergeInfo.commitHash.substring(0, 8)}...`);
  }

  return {
    session: sessionNameToUse,
    taskId: sessionRecord.taskId,
    prBranch: sessionRecord.prBranch,
    mergeInfo,
  };
}
