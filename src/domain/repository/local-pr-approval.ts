/**
 * Local Git PR approval operations extracted from LocalGitBackend.
 *
 * Contains: approvePullRequest, getPullRequestApprovalStatus.
 *
 * Approval state is stored in session records (prApproved flag) since there
 * is no external PR platform for local repositories.
 */

import { execGitWithTimeout } from "../../utils/git-exec";
import { log } from "../../utils/logger";
import type { ApprovalInfo, ApprovalStatus } from "./approval-types";
import type { LocalContext } from "./local-pr-operations";

// ── approvePullRequest ───────────────────────────────────────────────────

/**
 * Approve a pull request in the local repository.
 * Updates the session record with prApproved: true and returns an ApprovalInfo.
 */
export async function approvePullRequest(
  ctx: LocalContext,
  prIdentifier: string | number,
  reviewComment?: string
): Promise<ApprovalInfo> {
  const prId = String(prIdentifier);

  const sessionDB = await ctx.getSessionDB();
  const sessions = await sessionDB.listSessions();
  const sessionRecord = sessions.find((s) => s.prBranch === prId);

  if (!sessionRecord) {
    throw new Error(`No session found with PR branch: ${prId}`);
  }

  // Get current git user for the approval record
  let approver = "local-user";
  try {
    const { stdout } = await execGitWithTimeout("get-user-name", "config user.name", {
      workdir: process.cwd(),
      timeout: 5000,
    });
    approver = stdout.trim() || "local-user";
  } catch {
    // Use default if git config fails
  }

  await sessionDB.updateSession(sessionRecord.session, {
    prApproved: true,
  });

  log.info("Local PR approved - session record updated", {
    prIdentifier: prId,
    sessionName: sessionRecord.session,
    approver,
  });

  return {
    reviewId: `local-${prId}-${Date.now()}`,
    approvedBy: approver,
    approvedAt: new Date().toISOString(),
    comment: reviewComment,
    prNumber: prId,
    platformData: {
      platform: "local",
      prIdentifier: prId,
      sessionName: sessionRecord.session,
    },
  };
}

// ── getPullRequestApprovalStatus ─────────────────────────────────────────

/**
 * Get approval status for a pull request in the local repository.
 * Checks the session record's prApproved flag.
 */
export async function getPullRequestApprovalStatus(
  ctx: LocalContext,
  prIdentifier: string | number
): Promise<ApprovalStatus> {
  const prId = String(prIdentifier);

  const sessionDB = await ctx.getSessionDB();
  const sessions = await sessionDB.listSessions();
  const sessionRecord = sessions.find((s) => s.prBranch === prId);

  if (!sessionRecord) {
    log.debug("No session found for PR approval status check", { prIdentifier: prId });
    return {
      isApproved: false,
      approvals: [],
      requiredApprovals: 1,
      canMerge: false,
      platformData: {
        platform: "local",
        prIdentifier: prId,
        error: "No session found with this PR branch",
      },
    };
  }

  const isApproved = !!sessionRecord.prApproved;

  log.debug("Local PR approval status", {
    prIdentifier: prId,
    sessionName: sessionRecord.session,
    isApproved,
  });

  return {
    isApproved,
    approvals: isApproved
      ? [
          {
            reviewId: `local-${sessionRecord.session}`,
            approvedBy: "local-user",
            approvedAt: new Date().toISOString(),
            prNumber: prId,
            platformData: { platform: "local", sessionName: sessionRecord.session },
          },
        ]
      : [],
    requiredApprovals: 1,
    canMerge: isApproved,
    platformData: {
      platform: "local",
      prIdentifier: prId,
      sessionName: sessionRecord.session,
    },
  };
}
