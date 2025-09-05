/**
 * Session Task Association Management
 *
 * Provides utilities for updating session task associations,
 * particularly during task migrations between backends.
 */

import { log } from "../../utils/logger";
import { createSessionProvider } from "../session";
import type { SessionProviderInterface } from "./types";
import { extractLocalId, isQualifiedTaskId } from "../tasks/task-id";

export interface SessionAssociationUpdateOptions {
  /** Whether to run in dry-run mode (show what would be updated without making changes) */
  dryRun?: boolean;
  /** Session provider to use (defaults to the default provider) */
  sessionProvider?: SessionProviderInterface;
}

export interface SessionAssociationUpdateResult {
  /** Number of sessions found with the old task ID */
  sessionsFound: number;
  /** Number of sessions successfully updated */
  sessionsUpdated: number;
  /** List of session names that were updated */
  updatedSessions: string[];
  /** Any errors that occurred during the update */
  errors: string[];
}

/**
 * Updates session task associations when a task is migrated to a new ID
 *
 * @param oldTaskId Original task ID (e.g., "md#123")
 * @param newTaskId New task ID (e.g., "mt#123")
 * @param options Update options
 * @returns Result of the update operation
 */
export async function updateSessionTaskAssociation(
  oldTaskId: string,
  newTaskId: string,
  options: SessionAssociationUpdateOptions = {}
): Promise<SessionAssociationUpdateResult> {
  const { dryRun = false, sessionProvider = await createSessionProvider() } = options;

  const result: SessionAssociationUpdateResult = {
    sessionsFound: 0,
    sessionsUpdated: 0,
    updatedSessions: [],
    errors: [],
  };

  log.debug("Updating session task associations", {
    oldTaskId,
    newTaskId,
    dryRun,
  });

  try {
    // Extract the local ID from the old task ID for session lookup
    // Sessions store task IDs in plain format (e.g., "123" not "md#123")
    const oldLocalId = extractLocalId(oldTaskId);
    const newLocalId = extractLocalId(newTaskId);

    if (!oldLocalId || !newLocalId) {
      result.errors.push(`Invalid task ID format: ${oldTaskId} or ${newTaskId}`);
      return result;
    }

    log.debug("Extracted local IDs", { oldLocalId, newLocalId });

    // Get all sessions to find ones associated with the old task ID
    const allSessions = await sessionProvider.listSessions();

    // Find sessions associated with the old task ID
    const matchingSessions = allSessions.filter((session) => session.taskId === oldLocalId);

    result.sessionsFound = matchingSessions.length;

    log.debug("Found matching sessions", {
      count: matchingSessions.length,
      sessions: matchingSessions.map((s) => s.session),
    });

    if (matchingSessions.length === 0) {
      log.debug("No sessions found associated with old task ID", { oldTaskId, oldLocalId });
      return result;
    }

    // Update each matching session
    for (const session of matchingSessions) {
      try {
        log.debug("Updating session", {
          sessionName: session.session,
          oldTaskId: session.taskId,
          newTaskId: newLocalId,
          dryRun,
        });

        if (!dryRun) {
          await sessionProvider.updateSession(session.session, {
            taskId: newLocalId,
          });
        }

        result.sessionsUpdated++;
        result.updatedSessions.push(session.session);

        log.debug("Session updated successfully", {
          sessionName: session.session,
          newTaskId: newLocalId,
        });
      } catch (error) {
        const errorMessage = `Failed to update session ${session.session}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMessage);
        log.error("Failed to update session", {
          sessionName: session.session,
          error: errorMessage,
        });
      }
    }

    log.info("Session task association update completed", {
      oldTaskId,
      newTaskId,
      sessionsFound: result.sessionsFound,
      sessionsUpdated: result.sessionsUpdated,
      errors: result.errors.length,
      dryRun,
    });
  } catch (error) {
    const errorMessage = `Failed to update session associations: ${error instanceof Error ? error.message : String(error)}`;
    result.errors.push(errorMessage);
    log.error("Session association update failed", { error: errorMessage });
  }

  return result;
}

/**
 * Finds all sessions associated with a given task ID
 *
 * @param taskId Task ID to search for (can be qualified like "md#123" or plain like "123")
 * @param sessionProvider Session provider to use
 * @returns List of session names associated with the task
 */
export async function findSessionsByTaskId(
  taskId: string,
  sessionProvider?: SessionProviderInterface
): Promise<string[]> {
  // Lazy-initialize session provider if not provided
  const provider = sessionProvider || (await createSessionProvider());
  const localId = isQualifiedTaskId(taskId) ? extractLocalId(taskId) : taskId;

  if (!localId) {
    log.warn("Invalid task ID format", { taskId });
    return [];
  }

  const allSessions = await sessionProvider.listSessions();
  return allSessions
    .filter((session) => session.taskId === localId)
    .map((session) => session.session);
}

/**
 * Checks if any sessions are associated with a given task ID
 *
 * @param taskId Task ID to check for
 * @param sessionProvider Session provider to use
 * @returns True if any sessions are found, false otherwise
 */
export async function hasSessionsForTask(
  taskId: string,
  sessionProvider?: SessionProviderInterface
): Promise<boolean> {
  const sessions = await findSessionsByTaskId(taskId, sessionProvider);
  return sessions.length > 0;
}
