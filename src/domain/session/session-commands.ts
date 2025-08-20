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
  shortHash?: string;
  subject?: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;
  message: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  files?: Array<{ path: string; status: string }>;
  pushed: boolean;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session commit command", {
    session: params.session,
    message: params.message,
  });

  const { commitChangesFromParams, pushFromParams, createGitService } = await import("../git");

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

    // Collect commit metadata and changed files
    const gitService = createGitService();
    const workdir = gitService.getSessionWorkdir(params.session);

    // Branch name
    let branch: string | undefined;
    try {
      branch = await gitService.getCurrentBranch(workdir);
    } catch (err) {
      log.debug("Failed to get branch name", { error: (err as any)?.message });
    }

    // Author, subject, timestamp, short hash
    let shortHash: string | undefined;
    let subject: string | undefined;
    let authorName: string | undefined;
    let authorEmail: string | undefined;
    let timestamp: string | undefined;
    try {
      const pretty = await gitService.execInRepository(
        workdir,
        "git log -1 --pretty=format:%h|%s|%an|%ae|%aI"
      );
      const parts = pretty.trim().split("|");
      if (parts.length >= 5) {
        shortHash = parts[0];
        subject = parts[1];
        authorName = parts[2];
        authorEmail = parts[3];
        timestamp = parts[4];
      }
    } catch (err) {
      log.debug("Failed to read commit metadata", { error: (err as any)?.message });
    }

    // Diffstat summary
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    try {
      const shortstat = await gitService.execInRepository(
        workdir,
        "git show -1 --shortstat --pretty=format:"
      );
      const line = shortstat
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) {
        const match =
          /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/.exec(
            line
          );
        if (match) {
          filesChanged = parseInt(match[1] || "0", 10);
          insertions = parseInt(match[2] || "0", 10);
          deletions = parseInt(match[3] || "0", 10);
        }
      }
    } catch (err) {
      log.debug("Failed to parse diffstat", { error: (err as any)?.message });
    }

    // Changed files list with status
    let files: Array<{ path: string; status: string }> | undefined;
    try {
      const nameStatus = await gitService.execInRepository(
        workdir,
        "git show -1 -M -C --name-status --pretty=format:"
      );
      const lines = nameStatus
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      files = lines.map((line) => {
        const parts = line.split("\t");
        const status = parts[0];
        let path = parts[1] || "";
        if (status.startsWith("R") || status.startsWith("C")) {
          path = parts[2] || parts[1] || "";
        }
        return { status, path };
      });
    } catch (err) {
      log.debug("Failed to list changed files", { error: (err as any)?.message });
    }

    return {
      success: true,
      commitHash: commitResult.commitHash,
      shortHash,
      subject,
      branch,
      authorName,
      authorEmail,
      timestamp,
      message: commitResult.message,
      filesChanged,
      insertions,
      deletions,
      files,
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
