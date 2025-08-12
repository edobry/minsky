/**
 * Functional implementation of the SessionDB
 * This module contains pure functions for session management
 */

import { join } from "path";
import { getMinskyStateDir } from "../../utils/paths";

/**
 * PR commit information
 */
export interface PullRequestCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * GitHub-specific PR information
 */
export interface PullRequestGitHubInfo {
  id: number; // GitHub PR ID
  nodeId: string; // GitHub GraphQL node ID
  htmlUrl: string; // Web URL
  author: string; // GitHub username
  assignees?: string[]; // GitHub usernames
  reviewers?: string[]; // GitHub usernames
  labels?: string[]; // Label names
  milestone?: string; // Milestone title
}

/**
 * Pull request information for session records
 * Added to support pr list/get subcommands
 */
export interface PullRequestInfo {
  // Core PR Information
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged" | "draft";

  // Timestamps
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  mergedAt?: string; // ISO timestamp when merged

  // GitHub-specific information
  github?: PullRequestGitHubInfo;

  // Content information (for pr get command)
  body?: string; // PR description
  commits?: PullRequestCommit[];
  filesChanged?: string[]; // List of file paths

  // Branch information
  headBranch: string; // Source branch (e.g., "pr/task359")
  baseBranch: string; // Target branch (e.g., "main")

  // Metadata
  lastSynced: string; // When this info was last updated from GitHub API
}

/**
 * Session record structure
 */
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github"; // Added for repository backend support
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-name")
  prApproved?: boolean; // Whether this session's PR is approved
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
  return [...state.sessions];
}

/**
 * Get a specific session by name
 */
export function getSessionFn(state: SessionDbState, sessionName: string): SessionRecord | null {
  return state.sessions.find((s) => s.session === sessionName) || null;
}

/**
 * Get a specific session by task ID
 */
export function getSessionByTaskIdFn(state: SessionDbState, taskId: string): SessionRecord | null {
  // Normalize taskId by removing # prefix if present
  const normalizedTaskId = taskId.replace(/^#/, "");
  return state.sessions.find((s) => s.taskId?.replace(/^#/, "") === normalizedTaskId) || null;
}

/**
 * Add a new session to the state
 */
export function addSessionFn(state: SessionDbState, record: SessionRecord): SessionDbState {
  return {
    ...state,
    sessions: [...state.sessions, record],
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
export function deleteSessionFn(state: SessionDbState, sessionName: string): SessionDbState {
  const index = state.sessions.findIndex((s) => s.session === sessionName);
  if (index === -1) {
    return state;
  }

  const updatedSessions = [...state.sessions];
  updatedSessions.splice(index, 1);

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

  // Use simplified session-based path structure: /sessions/{sessionId}/
  return join(state.baseDir, "sessions", record.session);
}

/**
 * Get the working directory for a session
 */
export function getSessionWorkdirFn(state: SessionDbState, sessionName: string): string | null {
  const session = getSessionFn(state, sessionName);
  if (!session) {
    return null;
  }

  return getRepoPathFn(state, session);
}
