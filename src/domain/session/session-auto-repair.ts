import { join } from "path";
import { existsSync } from "fs";
import { log } from "../../utils/logger";
import type { SessionRecord, SessionProviderInterface } from "./types";
import type { GitServiceInterface } from "../git";
import { validateQualifiedTaskId } from "../tasks/task-id-utils";
import { isUuidSessionId, taskIdToBranchName } from "../tasks/task-id";

export interface SessionAutoRepairDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  getSessionsBaseDir: () => string;
}

/**
 * Auto-repair logic for reconstructing session records from existing workspace directories
 *
 * When a user runs `session start` or `session dir` with a `--task` parameter and no session
 * record is found in the database, this function checks for existing session workspace
 * directories with legacy naming patterns and reconstructs the session record.
 *
 * Supported legacy naming patterns:
 * 1. legacy1: `task<id>` (e.g., "task123")
 * 2. legacy2: `task#<id>` (e.g., "task#123")
 * 3. new: `task-md#<id>` (e.g., "task-md#123")
 */
export async function attemptSessionAutoRepair(
  taskId: string,
  deps: SessionAutoRepairDependencies
): Promise<SessionRecord | null> {
  const baseDir = deps.getSessionsBaseDir();

  log.debug("Attempting session auto-repair for task", { taskId, baseDir });

  // Generate possible session directory names based on task ID
  const possibleSessionIds = generatePossibleSessionIds(taskId);

  log.debug("Generated possible session IDs", { taskId, possibleSessionIds });

  // Check each possible session ID for existing directory
  for (const sessionId of possibleSessionIds) {
    const sessionDir = join(baseDir, sessionId);

    if (existsSync(sessionDir)) {
      log.debug("Found existing session directory", { sessionId, sessionDir });

      try {
        // Attempt to reconstruct session record from the workspace
        const reconstructedSession = await reconstructSessionRecord(
          sessionId,
          sessionDir,
          taskId,
          deps
        );

        if (reconstructedSession) {
          // Add the reconstructed session to the database
          await deps.sessionDB.addSession(reconstructedSession);

          log.cli(`🔧 Auto-repair: Reconstructed session '${sessionId}' from existing workspace`);

          return reconstructedSession;
        }
      } catch (error) {
        log.warn("Failed to reconstruct session from directory", {
          sessionId,
          sessionDir,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue to next possible session ID
      }
    }
  }

  log.debug("No existing session directories found for auto-repair", { taskId });
  return null;
}

/**
 * Generate possible session directory names based on task ID
 * Handles both qualified (md#123) and unqualified (123) task IDs
 */
export function generatePossibleSessionIds(taskId: string): string[] {
  const names: string[] = [];

  // UUID session IDs are used directly as directory names — add as first candidate
  if (isUuidSessionId(taskId)) {
    names.push(taskId);
    return names;
  }

  // Normalize the task ID first
  const validated = validateQualifiedTaskId(taskId);
  if (!validated) {
    return names;
  }

  // Extract just the numeric/ID part for legacy formats
  const idPart = extractIdPart(validated);

  if (idPart) {
    // Legacy format 1: task<id> (e.g., "task123")
    names.push(`task${idPart}`);

    // Legacy format 2: task#<id> (e.g., "task#123")
    names.push(`task#${idPart}`);
  }

  // New format: task-<full-qualified-id> (e.g., "task-md#123")
  names.push(`task-${validated}`);

  // Also try the exact task ID as session ID (for edge cases)
  names.push(validated);

  // Remove duplicates while preserving order
  return [...new Set(names)];
}

/**
 * Extract the ID part from a task ID for legacy naming patterns
 * Examples:
 * - "md#123" -> "123"
 * - "123" -> "123"
 * - "#123" -> "123"
 */
function extractIdPart(taskId: string): string | null {
  // Handle qualified IDs like "md#123"
  const qualifiedMatch = taskId.match(/^[a-zA-Z]+#(.+)$/);
  if (qualifiedMatch) {
    return qualifiedMatch[1] || null;
  }

  // Handle simple #123 format
  if (taskId.startsWith("#")) {
    return taskId.substring(1);
  }

  // Handle plain numeric IDs
  if (/^\d+$/.test(taskId)) {
    return taskId;
  }

  return null;
}

/**
 * Reconstruct a session record from an existing workspace directory
 */
async function reconstructSessionRecord(
  sessionId: string,
  sessionDir: string,
  taskId: string,
  deps: SessionAutoRepairDependencies
): Promise<SessionRecord | null> {
  try {
    // Get repository URL from git remote
    const remoteOutput = await deps.gitService.execInRepository(
      sessionDir,
      "git remote get-url origin"
    );
    const repoUrl = remoteOutput.trim();

    // Extract repo name from URL or path
    const repoName = extractRepoName(repoUrl);

    // Determine default branch name from task ID if possible, otherwise fall back to session ID
    const validatedTaskId = validateQualifiedTaskId(taskId);
    const defaultBranch = validatedTaskId ? taskIdToBranchName(validatedTaskId) : sessionId; // UUID with no taskId — unavoidable fallback

    // Get current branch
    let branch = defaultBranch;
    try {
      const branchOutput = await deps.gitService.execInRepository(
        sessionDir,
        "git branch --show-current"
      );
      branch = branchOutput.trim() || defaultBranch;
    } catch (branchError) {
      log.debug("Could not determine current branch, using default branch name", {
        sessionId,
        defaultBranch,
        branchError,
      });
    }

    // Try to get creation date from git log
    let createdAt = new Date().toISOString(); // Default to current time
    try {
      const firstCommitOutput = await deps.gitService.execInRepository(
        sessionDir,
        "git log --reverse --format=%ai | head -1"
      );
      if (firstCommitOutput.trim()) {
        createdAt = new Date(firstCommitOutput.trim()).toISOString();
      }
    } catch (commitError) {
      log.debug("Could not determine creation date from git log", {
        sessionId,
        commitError,
      });
    }

    // Create session record
    const sessionRecord: SessionRecord = {
      sessionId: sessionId,
      repoName,
      repoUrl,
      createdAt,
      taskId: validateQualifiedTaskId(taskId) ?? undefined,
      branch,
    };

    log.debug("Reconstructed session record", { sessionRecord });

    return sessionRecord;
  } catch (error) {
    log.debug("Failed to reconstruct session record", {
      sessionId,
      sessionDir,
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  }
}

/**
 * Extract repository name from URL or path
 */
function extractRepoName(repoUrl: string): string {
  if (repoUrl.includes("/")) {
    // Handle URLs like "https://github.com/user/repo.git" or "/path/to/repo"
    const parts = repoUrl.split("/");
    const lastPart = parts[parts.length - 1] ?? "";
    return lastPart.replace(".git", "") || "unknown";
  }

  // Fallback for local repositories
  return "local-minsky";
}
