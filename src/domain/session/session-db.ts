/**
 * Pure functional implementation of SessionDB operations
 * This module contains pure functions that operate on SessionDB state
 * No side effects (file I/O, external state) should be present in these functions
 */

import { join } from "path";
import { MinskyError } from "../../errors/index.js";
import { normalizeRepoName } from "../repository-uri.js";

/**
 * Interface for a session record in the database
 */
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  repoPath?: string;
  backendType?: "local" | "remote" | "github";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string;
}

/**
 * Interface for session database state
 */
export interface SessionDbState {
  sessions: SessionRecord[];
  baseDir: string;
}

/**
 * Configuration for SessionDB
 */
export interface SessionDbConfig {
  dbPath?: string;
  baseDir?: string;
}

/**
 * Lists all sessions in the database
 * @param state Current session database state
 * @returns Array of session records
 */
export function listSessionsFn(state: SessionDbState): SessionRecord[] {
  return [...state.sessions];
}

/**
 * Gets a session by name
 * @param state Current session database state
 * @param sessionName Name of the session to find
 * @returns SessionRecord if found, null otherwise
 */
export function getSessionFn(state: SessionDbState, sessionName: string): SessionRecord | null {
  return state.sessions.find((s) => s.session === sessionName) || null;
}

/**
 * Gets a session by task ID
 * @param state Current session database state
 * @param taskId Task ID to search for
 * @returns SessionRecord if found, null otherwise
 */
export function getSessionByTaskIdFn(state: SessionDbState, taskId: string): SessionRecord | null {
  // Normalize both stored and input task IDs to allow matching with or without #
  const normalize = (id: string | undefined) => {
    if (!id) return undefined;
    return id.startsWith("#") ? id : `#${id}`;
  };
  const normalizedInput = normalize(taskId);
  return state.sessions.find((s) => normalize(s.taskId) === normalizedInput) || null;
}

/**
 * Adds a new session to the database
 * @param state Current session database state
 * @param newSession Session record to add
 * @returns Updated session database state
 */
export function addSessionFn(state: SessionDbState, newSession: SessionRecord): SessionDbState {
  return {
    ...state,
    sessions: [...state.sessions, newSession],
  };
}

/**
 * Updates an existing session in the database
 * @param state Current session database state
 * @param sessionName Name of the session to update
 * @param updates Partial session record with updates
 * @returns Updated session database state
 */
export function updateSessionFn(
  state: SessionDbState,
  sessionName: string,
  updates: Partial<Omit<SessionRecord, "session">>
): SessionDbState {
  const sessionIndex = state.sessions.findIndex((s) => s.session === sessionName);
  if (sessionIndex === -1) return state;

  const { session: _, ...safeUpdates } = updates as any;
  const updatedSessions = [...state.sessions];
  updatedSessions[sessionIndex] = { ...updatedSessions[sessionIndex], ...safeUpdates };

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Deletes a session from the database
 * @param state Current session database state
 * @param sessionName Name of the session to delete
 * @returns Updated session database state
 */
export function deleteSessionFn(state: SessionDbState, sessionName: string): SessionDbState {
  const sessionIndex = state.sessions.findIndex((s) => s.session === sessionName);
  if (sessionIndex === -1) return state;

  const updatedSessions = [...state.sessions];
  updatedSessions.splice(sessionIndex, 1);

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Gets the repository path for a session
 * @param state Current session database state
 * @param record Session record or other object containing session info
 * @returns Repository path for the session
 */
export function getRepoPathFn(state: SessionDbState, record: SessionRecord | any): string {
  // Add defensive checks for the input
  if (!record) {
    throw new Error("Session record is required");
  }

  // Special handling for SessionResult type returned by startSessionFromParams
  if (record.sessionRecord) {
    return getRepoPathFn(state, record.sessionRecord);
  }

  // Special handling for CloneResult
  if (record.cloneResult && record.cloneResult.workdir) {
    return record.cloneResult.workdir;
  }

  // Handle case when repoName or session is missing
  if (!record.repoName || !record.session) {
    // If we have repoPath, use it directly
    if (record.repoPath) {
      return record.repoPath;
    }
    // For workdir in some objects
    if (record.workdir) {
      return record.workdir;
    }
    throw new Error("Invalid session record: missing repoName or session");
  }

  // If the record already has a repoPath, use that
  if (record.repoPath) {
    return record.repoPath;
  }

  // Fix for local repository paths: handle the case where repoName contains slashes
  // GitService.clone normalizes slashes to dashes, so we need to do the same here
  let normalizedRepoName = record.repoName;
  if (normalizedRepoName.startsWith("local/")) {
    // Replace slashes with dashes in the path segments after "local/"
    const parts = normalizedRepoName.split("/");
    if (parts.length > 1) {
      // Keep "local" as is, but normalize the rest
      normalizedRepoName = parts[0] + "-" + parts.slice(1).join("-");
    }
  }

  // Default to new path structure
  return join(state.baseDir, normalizedRepoName, "sessions", record.session);
}

/**
 * Gets the working directory for a session
 * @param state Current session database state
 * @param sessionName Name of the session
 * @returns Session working directory path or null if session not found
 */
export function getSessionWorkdirFn(state: SessionDbState, sessionName: string): string | null {
  const session = getSessionFn(state, sessionName);
  if (!session) return null;

  return getRepoPathFn(state, session);
}

/**
 * Gets the new repository path with sessions subdirectory for a session
 * @param state Current session database state
 * @param repoName The repository name
 * @param sessionId The session ID
 * @returns The new repository path
 */
export function getNewSessionRepoPathFn(
  state: SessionDbState,
  repoName: string,
  sessionId: string
): string {
  return join(state.baseDir, repoName, "sessions", sessionId);
}

/**
 * Initializes session database state
 * @param config SessionDB configuration
 * @returns Initialized session database state with empty sessions array
 */
export function initializeSessionDbState(config: SessionDbConfig = {}): SessionDbState {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  const baseDir = config.baseDir || join(xdgStateHome, "minsky", "git");

  return {
    sessions: [],
    baseDir,
  };
}
