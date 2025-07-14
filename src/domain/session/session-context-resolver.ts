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
import { createSessionProvider } from "../session";

/**
 * Session context resolution options
 */
export interface SessionContextOptions {
  /** Explicit session name provided by user */
  session?: string;
  /** Explicit task ID provided by user */
  task?: string;
  /** Repository path for context detection */
  repo?: string;
  /** Working directory for context detection */
  cwd?: string;
  /** Whether to allow auto-detection */
  allowAutoDetection?: boolean;
  /** Custom session provider (for testing) */
  sessionProvider?: SessionProviderInterface;
  /** Custom getCurrentSession function (for testing) */
  getCurrentSessionFn?: typeof getCurrentSession;
  /** Custom getCurrentSessionContext function (for testing) */
  getCurrentSessionContextFn?: typeof getCurrentSessionContext;
}

/**
 * Resolved session context
 */
export interface ResolvedSessionContext {
  /** The resolved session name */
  sessionName: string;
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
 * - Explicit session names
 * - Task ID to session resolution
 * - Auto-detection from working directory
 * - Consistent error handling and feedback
 */
export async function resolveSessionContext(
  options: SessionContextOptions = {}
): Promise<ResolvedSessionContext> {
  const {
    session,
    task,
    repo,
    cwd = process.cwd(),
    allowAutoDetection = true,
    sessionProvider = createSessionProvider(),
    getCurrentSessionFn = getCurrentSession,
    getCurrentSessionContextFn = getCurrentSessionContext,
  } = options;

  const workingDirectory = repo || cwd;

  // Option 1: Explicit session name provided
  if (session) {
    log.debug("Using explicit session name", { session });
    
    // Validate session exists
    const sessionRecord = await sessionProvider!.getSession(session);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(
        `Session '${session}' not found`,
        "session",
        session
      );
    }

    return {
      sessionName: session,
      taskId: sessionRecord!.taskId,
      resolvedBy: "explicit-session",
      workingDirectory,
    };
  }

  // Option 2: Task ID provided - resolve to session
  if (task) {
    log.debug("Resolving session from task ID", { task });
    
    const normalizedTaskId = taskIdSchema!.parse(task);
    const sessionRecord = await sessionProvider!.getSessionByTaskId(normalizedTaskId);
    
    if (!sessionRecord) {
      throw new ResourceNotFoundError(
        `No session found for task ${normalizedTaskId}`,
        "task",
        normalizedTaskId
      );
    }

    return {
      sessionName: sessionRecord!.session,
      taskId: normalizedTaskId,
      resolvedBy: "explicit-task",
      workingDirectory,
    };
  }

  // Option 3: Auto-detection from working directory
  if (allowAutoDetection) {
    log.debug("Attempting session auto-detection", { workingDirectory });
    
    try {
      // Try to get full session context (session + task)
      const sessionContext = await getCurrentSessionContextFn(workingDirectory, {
        sessionDbOverride: sessionProvider,
      });
      
      if (sessionContext!?.sessionId) {
        const autoDetectionMessage = `Auto-detected session: ${sessionContext!.sessionId}`;
        log.debug("Session auto-detection successful", { 
          sessionId: sessionContext!.sessionId,
          taskId: sessionContext!.taskId,
          workingDirectory 
        });
        
        return {
          sessionName: sessionContext!.sessionId,
          taskId: sessionContext!.taskId,
          resolvedBy: "auto-detection",
          workingDirectory,
          autoDetectionMessage,
        };
      }
      
      // Fallback to basic session detection
      const sessionName = await getCurrentSessionFn(workingDirectory);
      if (sessionName) {
        const autoDetectionMessage = `Auto-detected session: ${sessionName}`;
        log.debug("Basic session auto-detection successful", { 
          sessionName,
          workingDirectory 
        });
        
        // Get task ID from session record
        const sessionRecord = await sessionProvider!.getSession(sessionName);
        
        return {
          sessionName,
          taskId: sessionRecord!?.taskId,
          resolvedBy: "auto-detection",
          workingDirectory,
          autoDetectionMessage,
        };
      }
    } catch (error) {
      log.debug("Session auto-detection failed", { 
        error: getErrorMessage(error as Error),
        workingDirectory 
      });
    }
  }

  // No session could be resolved
  throw new ValidationError(
    "No session detected. Please provide a session name or task ID, or run this command from within a session workspace."
  );
}

/**
 * Simplified session resolution for commands that only need the session name
 */
export async function resolveSessionName(
  options: SessionContextOptions = {}
): Promise<string> {
  const context = await resolveSessionContext(options);
  return context!.sessionName;
}

/**
 * Session resolution with user feedback
 * 
 * This function resolves the session context and provides user feedback
 * when auto-detection is used.
 */
export async function resolveSessionContextWithFeedback(
  options: SessionContextOptions = {}
): Promise<ResolvedSessionContext> {
  const context = await resolveSessionContext(options);
  
  // Provide user feedback for auto-detection
  if (context?.autoDetectionMessage) {
    log.cli(context.autoDetectionMessage);
  }
  
  return context;
}

/**
 * Validate that a session context can be resolved
 * 
 * This function checks if session resolution would succeed without
 * actually performing the resolution. Useful for command validation.
 */
export async function validateSessionContext(
  options: SessionContextOptions = {}
): Promise<boolean> {
  try {
    await resolveSessionContext(options);
    return true;
  } catch (error) {
    return false;
  }
} 
