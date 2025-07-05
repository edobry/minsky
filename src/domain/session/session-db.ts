/**
 * Functional implementation of the SessionDB
 * This module contains pure functions for session management
 */

import { join } from "path";
import { getMinskyStateDir } from "../../utils/paths.js";

/**
 * Session record structure
 */
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId: string;
  branch: string;
}

/**
 * State structure for the SessionDB
 */
export interface SessionDbState {
  sessions: SessionRecord[];
  baseDir: string;
}

/**
 * Initialize a new SessionDB state object
 */
export function initializeSessionDbState(options: { baseDir?: string } = {}): SessionDbState {
  const baseDir = options?.baseDir || getMinskyStateDir();

  return {
    sessions: [],
    baseDir,
  };
}

/**
 * List all sessions
 */
export function listSessionsFn(state: SessionDbState): SessionRecord[] {
  return [...(state as any).sessions];
}

/**
 * Get a specific session by name
 */
export function getSessionFn(state: SessionDbState, sessionName: string): SessionRecord | null {
  return (state.sessions as any).find((s) => (s as any).session === sessionName) || null;
}

/**
 * Get a specific session by task ID
 */
export function getSessionByTaskIdFn(state: SessionDbState, taskId: string): SessionRecord | null {
  // Normalize taskId by removing # prefix if present
  const normalizedTaskId = (taskId as any).replace(/^#/, "");
  return (
    (state.sessions as any).find((s) => (s.taskId as any).replace(/^#/, "") === normalizedTaskId) ||
    null
  );
}

/**
 * Add a new session to the state
 */
export function addSessionFn(state: SessionDbState, record: SessionRecord): SessionDbState {
  return {
    ...state,
    sessions: [...(state as any).sessions, record],
  };
}

/**
 * Update an existing session
 */
export function updateSessionFn(
  state: SessionDbState,
  sessionName: string,
  updates: Partial<Omit<SessionRecord, "session">>
): SessionDbState {
  const index = (state.sessions as any).findIndex((s) => (s as any).session === sessionName);
  if (index === -1) {
    return state;
  }

  const { session: _, ...safeUpdates } = updates as any;
  const updatedSessions = [...(state as any).sessions];
  updatedSessions[index] = { ...updatedSessions[index], ...safeUpdates };

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Delete a session by name
 */
export function deleteSessionFn(state: SessionDbState, sessionName: string): SessionDbState {
  const index = (state.sessions as any).findIndex((s) => (s as any).session === sessionName);
  if (index === -1) {
    return state;
  }

  const updatedSessions = [...(state as any).sessions];
  (updatedSessions as any).splice(index, 1);

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Get the repository path for a session
 */
export function getRepoPathFn(state: SessionDbState, record: SessionRecord): string {
  if (!record) {
    throw new Error("Session record is required");
  }

  // Use simplified session-ID-based path structure: /sessions/{sessionId}/
  return join((state as any).baseDir, "sessions", (record as any).session);
}

/**
 * Get the working directory for a session
 */
export function getSessionWorkdirFn(
  state: SessionDbState,
  sessionName: string
): string | undefined {
  const session = getSessionFn(state, sessionName);
  if (!session) {
    return null as any;
  }

  return getRepoPathFn(state, session);
}
