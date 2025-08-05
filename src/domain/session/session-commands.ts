/**
 * Session Commands
 *
 * Session operations that accept session parameters.
 */

import { z } from "zod";
import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Session PR creation parameters
 */
export interface SessionPrParams {
  session: string;
  title?: string;
  body?: string;
  bodyPath?: string;
  noStatusUpdate?: boolean;

  skipConflictCheck?: boolean;
  autoResolveDeleteConflicts?: boolean;
  debug?: boolean;
}

// ❌ DELETED: sessionPr() wrapper function - redundant duplicate
// This function was a wrapper around sessionPrFromParams (legacy implementation).
// All callers should use the modern sessionPr() from ./commands/pr-command.ts instead.

/**
 * Session update interface with explicit parameters
 */
export interface SessionUpdateParams {
  session: string; // ✅ ALWAYS required
  branch?: string;
  force?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
  noPush?: boolean;
  skipConflictCheck?: boolean;
  skipIfAlreadyMerged?: boolean;
  autoResolveDeleteConflicts?: boolean;
}

/**
 * Pure session update domain function
 */
export async function pureSessionUpdate(params: SessionUpdateParams): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session update command", { session: params.session });

  const { updateSessionFromParams } = await import("../session.js");

  try {
    const result = await updateSessionFromParams({
      name: params.session,
      branch: params.branch,
      force: params.force,
      dryRun: params.dryRun,
      noStash: params.noStash,
      noPush: params.noPush,
      skipConflictCheck: params.skipConflictCheck,
      skipIfAlreadyMerged: params.skipIfAlreadyMerged,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
    });

    return {
      success: true,
      message: result.message || "Session updated successfully",
    };
  } catch (error) {
    log.debug("Pure session update failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session,
    });
    throw error;
  }
}

/**
 * Pure domain interface for session approval
 */
export interface SessionApproveParams {
  session: string; // ✅ ALWAYS required
}

/**
 * Pure session approve domain function
 */
export async function pureSessionApprove(params: SessionApproveParams): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session approve command", { session: params.session });

  const { sessionApprove } = await import("./index.js");

  try {
    const result = await sessionApprove({
      name: params.session,
    });

    return {
      success: true,
      message: result.message || "Session approved successfully",
    };
  } catch (error) {
    log.debug("Pure session approve failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session,
    });
    throw error;
  }
}

/**
 * Session commit command - commits and pushes changes within a specific session
 *
 * Note: Always pushes after commit - in session context these operations should be atomic
 */
export async function sessionCommit(params: {
  session: string;
  message: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{
  success: boolean;
  commitHash: string;
  message: string;
  pushed: boolean;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session commit command", {
    session: params.session,
    message: params.message,
  });

  const { commitChangesFromParams, pushFromParams } = await import("../git");

  try {
    // Commit changes using session-scoped git command
    const commitResult = await commitChangesFromParams({
      message: params.message,
      session: params.session, // Always use session context
      all: params.all,
      amend: params.amend,
      noStage: params.noStage,
    });

    // Always push changes in session context - commit and push should be atomic
    const pushResult = await pushFromParams({
      session: params.session, // Always use session context
    });

    return {
      success: true,
      commitHash: commitResult.commitHash,
      message: commitResult.message,
      pushed: pushResult.pushed,
    };
  } catch (error) {
    log.debug("Session commit failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session,
    });
    throw error;
  }
}
