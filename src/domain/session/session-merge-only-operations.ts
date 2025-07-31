/**
 * Session Merge-Only Operations (Task #358)
 * 
 * This module implements the new merge-only workflow that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 */

import { log } from "../../utils/logger";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import { createRepositoryBackendForSession } from "./repository-backend-detection";
import type { MergeInfo } from "../repository/index";

/**
 * Parameters for session merge operation
 */
export interface SessionMergeOnlyParams {
  session?: string;
  task?: string;
  repo?: string;
  json?: boolean;
}

/**
 * Result of session merge operation
 */
export interface SessionMergeOnlyResult {
  session: string;
  taskId?: string;
  prBranch: string;
  mergeInfo: MergeInfo;
}

/**
 * Merge a session's approved PR (Task #358)
 * 
 * This function:
 * 1. Validates the session has a PR branch
 * 2. Validates the PR is approved (prApproved: true)
 * 3. Calls repositoryBackend.mergePullRequest()
 * 4. Updates session record (could add prMerged: true if needed)
 * 
 * Requires the PR to be approved first via session approve.
 */
export async function mergeSessionOnly(
  params: SessionMergeOnlyParams,
  deps?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<SessionMergeOnlyResult> {
  
  if (!params.json) {
    log.cli("🔄 Starting session merge (merge-only mode)...");
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

  // Validate session has a PR branch
  if (!sessionRecord.prBranch) {
    throw new ValidationError(
      `Session "${sessionNameToUse}" has no PR branch. Create a PR first with 'minsky session pr'`
    );
  }

  // Validate PR is approved
  if (!sessionRecord.prApproved) {
    throw new ValidationError(
      `Session "${sessionNameToUse}" PR must be approved before merging. Use 'minsky session approve' first`
    );
  }

  // Create repository backend for this session
  const workingDirectory = params.repo || sessionRecord.repoUrl || process.cwd();
  const repositoryBackend = await createRepositoryBackendForSession(workingDirectory);

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
    mergeInfo
  };
}