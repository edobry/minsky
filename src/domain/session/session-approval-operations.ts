/**
 * Session Approval Operations (Task #358)
 *
 * This module implements session PR approval functionality,
 * enabling standard collaborative review workflows.
 */

import { log } from "../../utils/logger";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import { createRepositoryBackendForSession } from "./repository-backend-detection";
import type { ApprovalInfo } from "../repository/approval-types";

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
  deps?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<SessionApprovalResult> {
  if (!params.json) {
    log.cli("🔍 Starting session approval...");
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

  // Check if already approved
  if (sessionRecord.prApproved) {
    if (!params.json) {
      log.cli("ℹ️  Session PR is already approved");
    }

    return {
      session: sessionNameToUse,
      taskId: sessionRecord.taskId,
      prBranch: sessionRecord.prBranch,
      approvalInfo: {
        reviewId: "already-approved",
        approvedBy: "unknown", // We don't track who approved previously
        approvedAt: new Date().toISOString(),
        prNumber: sessionRecord.prBranch,
      },
      wasAlreadyApproved: true,
    };
  }

  // Create repository backend for this session
  const workingDirectory = params.repo || sessionRecord.repoUrl || process.cwd();
  const repositoryBackend = await createRepositoryBackendForSession(workingDirectory);

  if (!params.json) {
    log.cli(`📦 Using ${repositoryBackend.getType()} backend for approval`);
  }

  // Approve the PR using repository backend
  if (!params.json) {
    log.cli(`✅ Approving PR for branch: ${sessionRecord.prBranch}`);
  }

  const approvalInfo = await repositoryBackend.approvePullRequest(
    sessionRecord.prBranch,
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
    session: sessionNameToUse,
    taskId: sessionRecord.taskId,
    prBranch: sessionRecord.prBranch,
    approvalInfo,
    wasAlreadyApproved: false,
  };
}
