/**
 * Unified Session Context Resolver
 *
 * This module provides a single, unified interface for session auto-detection
 * across all session commands, replacing the inconsistent implementations
 * currently scattered throughout the codebase.
 */

import { log } from "../../utils/logger";
import { ValidationError, ResourceNotFoundError, getErrorMessage } from "../../errors/index";
import { taskIdSchema } from "../../schemas/common";
import { getCurrentSession, getCurrentSessionContext } from "../workspace";
import type { SessionProviderInterface } from "../session";
import { execAsync } from "../../utils/exec";

/**
 * Session context resolution options
 */
export interface SessionContextOptions {
  /** Explicit session ID provided by user */
  sessionId?: string;
  /** Explicit task ID provided by user */
  task?: string;
  /** Repository path for context detection */
  repo?: string;
  /** Working directory for context detection */
  cwd?: string;
  /** Whether to allow auto-detection */
  allowAutoDetection?: boolean;
  /** Session provider — required, must be injected by caller */
  sessionProvider: SessionProviderInterface;
  /** Custom getCurrentSession function (for testing) */
  getCurrentSessionFn?: (cwd: string) => Promise<string | undefined>;
  /** Custom getCurrentSessionContext function (for testing) */
  getCurrentSessionContextFn?: (
    cwd: string,
    dependencies?: { sessionDbOverride?: SessionProviderInterface }
  ) => Promise<{ sessionId: string; taskId?: string } | null>;
}

/**
 * Resolved session context
 */
export interface ResolvedSessionContext {
  /** The resolved session ID */
  sessionId: string;
  /** The task ID associated with the session (if any) */
  taskId?: string;
  /** How the session was resolved */
  resolvedBy: "explicit-session" | "explicit-task" | "auto-detection";
  /** The working directory used for resolution */
  workingDirectory: string;
  /** Auto-detection feedback message for user */
  autoDetectionMessage?: string;
}

/**
 * Unified session context resolver
 *
 * This function consolidates all session auto-detection logic into a single,
 * consistent interface. It handles:
 * - Explicit session IDs
 * - Task ID to session resolution
 * - Auto-detection from working directory
 * - Consistent error handling and feedback
 */
export async function resolveSessionContext(
  options: SessionContextOptions
): Promise<ResolvedSessionContext> {
  const {
    sessionId,
    task,
    repo,
    cwd = process.cwd(),
    allowAutoDetection = true,
    sessionProvider: sessionProviderInput,
    getCurrentSessionFn,
    getCurrentSessionContextFn,
  } = options;

  const sessionProvider = sessionProviderInput;

  // Wrap workspace functions to inject sessionProvider when no custom fn is provided
  const resolvedGetCurrentSessionFn =
    getCurrentSessionFn ?? (async (p: string) => getCurrentSession(p, execAsync, sessionProvider));
  const resolvedGetCurrentSessionContextFn =
    getCurrentSessionContextFn ??
    (async (p: string, deps?: { sessionDbOverride?: SessionProviderInterface }) =>
      getCurrentSessionContext(p, {
        sessionDbOverride: deps?.sessionDbOverride ?? sessionProvider,
      }));

  log.debug("Resolving session context", {
    task,
    sessionId,
    repo,
    sessionProviderType: sessionProvider.constructor.name,
  });

  const workingDirectory = repo || cwd;

  // Option 1: Explicit session ID provided
  if (sessionId) {
    log.debug("Using explicit session ID", { sessionId });

    // Validate session exists
    const sessionRecord = await sessionProvider.getSession(sessionId);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionId}' not found`, "session", sessionId);
    }

    return {
      sessionId,
      taskId: sessionRecord.taskId,
      resolvedBy: "explicit-session",
      workingDirectory,
    };
  }

  // Option 2: Task ID provided - resolve to session
  if (task) {
    log.debug("Resolving session from task ID", { task });

    const validatedTaskId = taskIdSchema.parse(task);
    const sessionRecord = await sessionProvider.getSessionByTaskId(validatedTaskId);

    if (!sessionRecord) {
      // Provide a more helpful error message with available sessions
      const allSessions = await sessionProvider.listSessions();
      const sessionIds = allSessions
        .map((s) => (s.taskId ? `${s.taskId} (${s.session})` : s.session))
        .join(", ");

      throw new ResourceNotFoundError(
        `No session found for task ID "${validatedTaskId}"\n\n` +
          `💡 Available sessions: ${sessionIds}`,
        "task",
        validatedTaskId
      );
    }

    return {
      sessionId: sessionRecord.session,
      taskId: task, // ✅ BACKWARD COMPATIBILITY: Return original task ID format
      resolvedBy: "explicit-task",
      workingDirectory,
    };
  }

  // Option 3: Auto-detection from working directory
  if (allowAutoDetection) {
    log.debug("Attempting session auto-detection", { workingDirectory });

    try {
      // Try to get full session context (session + task)
      const sessionContext = await resolvedGetCurrentSessionContextFn(workingDirectory, {
        sessionDbOverride: sessionProvider,
      });

      if (sessionContext?.sessionId) {
        const taskLabel = sessionContext.taskId
          ? `for task ${sessionContext.taskId}`
          : `(session ${sessionContext.sessionId})`;
        const autoDetectionMessage = `Auto-detected session ${taskLabel}`;
        log.debug("Session auto-detection successful", {
          sessionId: sessionContext.sessionId,
          taskId: sessionContext.taskId,
          workingDirectory,
        });

        return {
          sessionId: sessionContext.sessionId,
          taskId: sessionContext.taskId,
          resolvedBy: "auto-detection",
          workingDirectory,
          autoDetectionMessage,
        };
      }

      // Fallback to basic session detection
      const sessionId = await resolvedGetCurrentSessionFn(workingDirectory);
      if (sessionId) {
        // Get task ID from session record to show human-friendly message
        const sessionRecord = await sessionProvider.getSession(sessionId);
        const taskLabel = sessionRecord?.taskId
          ? `for task ${sessionRecord.taskId}`
          : `(session ${sessionId})`;
        const autoDetectionMessage = `Auto-detected session ${taskLabel}`;
        log.debug("Basic session auto-detection successful", {
          sessionId,
          workingDirectory,
        });

        return {
          sessionId,
          taskId: sessionRecord?.taskId,
          resolvedBy: "auto-detection",
          workingDirectory,
          autoDetectionMessage,
        };
      }
    } catch (error) {
      log.debug("Session auto-detection failed", {
        error: getErrorMessage(error as Error),
        workingDirectory,
      });
    }
  }

  // No session could be resolved
  throw new ValidationError(
    "No session detected. Please provide a session ID or task ID, or run this command from within a session workspace."
  );
}

/**
 * Simplified session resolution for commands that only need the session ID
 */
export async function resolveSessionId(options: SessionContextOptions): Promise<string> {
  const context = await resolveSessionContext(options);
  return context.sessionId;
}

/**
 * Session resolution with user feedback
 *
 * This function resolves the session context and provides user feedback
 * when auto-detection is used.
 */
export async function resolveSessionContextWithFeedback(
  options: SessionContextOptions
): Promise<ResolvedSessionContext> {
  const context = await resolveSessionContext(options);

  // Provide user feedback for auto-detection
  if (context?.autoDetectionMessage) {
    // Only call log.cli if it exists (may not be available in test environments)
    if (typeof log.cli === "function") {
      log.cli(context.autoDetectionMessage);
    } else {
      log.debug(context.autoDetectionMessage);
    }
  }

  return context;
}

/**
 * Validate that a session context can be resolved
 *
 * This function checks if session resolution would succeed without
 * actually performing the resolution. Useful for command validation.
 */
export async function validateSessionContext(options: SessionContextOptions): Promise<boolean> {
  try {
    await resolveSessionContext(options);
    return true;
  } catch (error) {
    return false;
  }
}
