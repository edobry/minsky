/**
 * Session Commands
 *
 * Session operations that accept session parameters.
 */

import { MinskyError, NothingToCommitError } from "../../errors/index";
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
 * Pure domain interface for session approval
 */
export interface SessionApproveParams {
  session: string; // ✅ ALWAYS required
}

/**
 * Pure session approve domain function
 */
export async function pureSessionApprove(
  params: SessionApproveParams,
  sessionProvider: import("./types").SessionProviderInterface
): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session approve command", { session: params.session });

  const { approveSessionPr } = await import("./session-approval-operations.js");

  try {
    const _result = await approveSessionPr(
      {
        session: params.session,
      },
      { sessionDB: sessionProvider }
    );

    return {
      success: true,
      message: "Session approved successfully",
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
export async function sessionCommit(
  params: {
    session: string;
    message: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  },
  sessionProvider: import("./types").SessionProviderInterface
): Promise<{
  success: boolean;
  nothingToCommit?: boolean;
  commitHash: string | null;
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

  // Enforce merged-PR-freeze invariant
  const { assertSessionMutable } = await import("./session-mutability.js");
  const sessionRecordForFreeze = await sessionProvider.getSession(params.session);
  if (sessionRecordForFreeze) {
    assertSessionMutable(sessionRecordForFreeze, "commit changes");
  }

  const { commitChangesFromParams, pushFromParams, createGitService } = await import("../git");

  // Resolve session to repo path at this boundary
  const workdir = await sessionProvider.getSessionWorkdir(params.session);

  try {
    // Commit changes using session-scoped git command
    let commitResult!: { commitHash: string; message: string };
    try {
      commitResult = await commitChangesFromParams({
        message: params.message,
        repo: workdir,
        all: params.all,
        amend: params.amend,
        noStage: params.noStage,
      });
    } catch (commitErr: unknown) {
      // Handle "nothing to commit" gracefully — not an error condition
      if (commitErr instanceof NothingToCommitError) {
        log.debug("Nothing to commit in session", { session: params.session });
        return {
          success: true,
          nothingToCommit: true,
          commitHash: null,
          message: "Nothing to commit, working tree clean",
          pushed: false,
        };
      }
      throw commitErr;
    }

    // Always push changes in session context - commit and push should be atomic
    const pushResult = await pushFromParams({
      repo: workdir,
    });

    // Collect commit metadata and changed files
    const gitService = createGitService();

    // Branch name
    let branch: string | undefined;
    try {
      branch = await gitService.getCurrentBranch(workdir);
    } catch (err) {
      log.debug("Failed to get branch name", {
        error: err instanceof Error ? err.message : String(err),
      });
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
      log.debug("Failed to read commit metadata", {
        error: err instanceof Error ? err.message : String(err),
      });
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
      log.debug("Failed to parse diffstat", {
        error: err instanceof Error ? err.message : String(err),
      });
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
        const status = parts[0] ?? "";
        let path = parts[1] || "";
        if (status.startsWith("R") || status.startsWith("C")) {
          path = parts[2] || parts[1] || "";
        }
        return { status, path };
      });
    } catch (err) {
      log.debug("Failed to list changed files", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update session activity state after successful commit+push
    try {
      const { SessionStatus } = await import("./types");
      const currentSession = await sessionProvider.getSession(params.session);
      const newCommitCount = (currentSession?.commitCount ?? 0) + 1;
      await sessionProvider.updateSession(params.session, {
        lastActivityAt: new Date().toISOString(),
        lastCommitHash: commitResult.commitHash,
        lastCommitMessage: params.message,
        commitCount: newCommitCount,
        status:
          currentSession?.status === SessionStatus.CREATED
            ? SessionStatus.ACTIVE
            : currentSession?.status,
      });
    } catch (e) {
      log.debug("Failed to update session activity state", { error: e });
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
