/**
 * Functional implementation of the SessionDB
 * This module contains pure functions for session management
 */

import { join } from "path";
import { normalizeRepoName } from "../repository-uri";

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
  repoPath?: string;
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
export function initializeSessionDbState(__options: { baseDir?: string } = {}): SessionDbState {
  const xdgStateHome = process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state");
  const baseDir = options.baseDir || join(_xdgStateHome, "minsky", "git");

  return {
    sessions: [],
    baseDir,
  };
}

/**
 * List all sessions
 */
export function listSessionsFn(_state: SessionDbState): SessionRecord[] {
  return [...state.sessions];
}

/**
 * Get a specific session by name
 */
export function getSessionFn(_state: SessionDbState, _sessionName: string): SessionRecord | null {
  return state.sessions.find((s) => s.session === sessionName) || null;
}

/**
 * Get a specific session by task ID
 */
export function getSessionByTaskIdFn(_state: SessionDbState, _taskId: string): SessionRecord | null {
  // Normalize taskId by removing # prefix if present
  const normalizedTaskId = taskId.replace(/^#/, "");
  return state.sessions.find((s) => s.taskId.replace(/^#/, "") === normalizedTaskId) || null;
}

/**
 * Add a new session to the state
 */
export function addSessionFn(_state: SessionDbState, _record: SessionRecord): SessionDbState {
  return {
    ...state,
    sessions: [...state.sessions, record],
  };
}

/**
 * Update an existing session
 */
export function updateSessionFn(_state: SessionDbState,
  _sessionName: string,
  _updates: Partial<Omit<"session">>
): SessionDbState {
  const index = state.sessions.findIndex((s) => s.session === sessionName);
  if (index === -1) {
    return state;
  }

  const { session: _, ...safeUpdates } = updates as any;
  const updatedSessions = [...state.sessions];
  updatedSessions[index] = { ...updatedSessions[index], ...safeUpdates };

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Delete a session by name
 */
export function deleteSessionFn(_state: SessionDbState, _sessionName: string): SessionDbState {
  const index = state.sessions.findIndex((s) => s.session === sessionName);
  if (index === -1) {
    return state;
  }

  const updatedSessions = [...state.sessions];
  updatedSessions.splice(_index, 1);

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Get the repository path for a session
 */
export function getRepoPathFn(_state: SessionDbState, _record: SessionRecord): string {
  if (!record) {
    throw new Error("Session record is required");
  }

  if (record.repoPath) {
    return record.repoPath;
  }

  const repoName = normalizeRepoName(record.repoName || record.repoUrl);
  return join(state.baseDir, repoName, "sessions", record._session);
}

/**
 * Get the working directory for a session
 */
export function getSessionWorkdirFn(_state: SessionDbState, _sessionName: string): string | null {
  const _session = getSessionFn(_state, _sessionName);
  if (!session) {
    return null;
  }

  return getRepoPathFn(_state, _session);
}
