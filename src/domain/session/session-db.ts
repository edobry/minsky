/**
 * Functional implementation of the SessionDB
 * This module contains pure functions for session management
 */

import { join } from "path";
import { getMinskyStateDir } from "../../utils/paths";
import { elementAt } from "../../utils/array-safety";
import type { SessionStatus } from "./types";

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
  // Core PR Information (minimal workflow state only)
  number: number;
  url: string;
  state: "open" | "closed" | "merged" | "draft";

  // Timestamps (essential for workflow automation)
  createdAt: string; // ISO timestamp
  mergedAt?: string; // ISO timestamp when merged

  // GitHub-specific information
  github?: PullRequestGitHubInfo;

  // Branch information (essential for git operations)
  headBranch: string; // Source branch (e.g., "pr/task359")
  baseBranch: string; // Target branch (e.g., "main")

  // Metadata
  lastSynced: string; // When this info was last updated from GitHub API

  // Live-fetch fields: not stored persistently but may appear on objects built at runtime
  // (e.g. enrichment pass in pr-get-subcommand.ts)
  updatedAt?: string; // ISO timestamp – populated from live GitHub API response
  title?: string; // PR title – fetched live, not cached
  body?: string; // PR description – fetched live, not cached
  filesChanged?: number; // Count of changed files – fetched live, not cached
  commits?: number; // Count of commits – fetched live, not cached
}

/**
 * Session record structure
 */
export interface SessionRecord {
  sessionId: string;
  repoName: string;
  repoUrl: string;
  repoPath?: string; // Local path to the repository
  createdAt: string;
  taskId?: string;
  backendType?: "github" | "gitlab" | "bitbucket"; // Repository backend type
  lastActivityAt?: string;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  commitCount?: number;
  status?: SessionStatus;
  agentId?: string;
  prState?: {
    branchName: string;
    exists?: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-id")
  prApproved?: boolean; // Whether this session's PR is approved

  // Legacy / compatibility fields
  /** @deprecated Use `sessionId` instead */
  name?: string;
  workspacePath?: string;
  sessionPath?: string;
  /** Branch name - removed from persistent schema but kept for test compatibility */
  branch?: string;
  /** @deprecated Use `createdAt` instead */
  created?: string;
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
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
export function getSessionFn(state: SessionDbState, sessionId: string): SessionRecord | null {
  return state.sessions.find((s) => s.sessionId === sessionId) || null;
}

/**
 * Get a specific session by task ID
 */
export function getSessionByTaskIdFn(state: SessionDbState, taskId: string): SessionRecord | null {
  // Normalize taskId by removing # prefix if present
  const validatedTaskId = taskId.replace(/^#/, "");
  return state.sessions.find((s) => s.taskId?.replace(/^#/, "") === validatedTaskId) || null;
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
 * Update an existing session.
 *
 * Merge contract: `{ ...existing, ...updates }`. Fields with `undefined` values clear the
 * column. Nested objects (e.g. `prState`, `pullRequest`) replace wholesale (shallow, not deep).
 */
export function updateSessionFn(
  state: SessionDbState,
  sessionId: string,
  updates: Partial<Omit<SessionRecord, "sessionId">>
): SessionDbState {
  const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
  if (index === -1) {
    return state;
  }

  // Strip 'sessionId' key if present (prevents renaming the primary key)
  const { sessionId: _sessionKey, ...safeUpdates } = updates as Partial<SessionRecord> & {
    sessionId?: string;
  };
  const updatedSessions = [...state.sessions];
  updatedSessions[index] = {
    ...elementAt(updatedSessions, index, "session-db updateSession"),
    ...safeUpdates,
  } as SessionRecord;

  return {
    ...state,
    sessions: updatedSessions,
  };
}

/**
 * Delete a session by name
 */
export function deleteSessionFn(state: SessionDbState, sessionId: string): SessionDbState {
  const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
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
  return join(state.baseDir, "sessions", record.sessionId);
}

/**
 * Get the working directory for a session
 */
export function getSessionWorkdirFn(state: SessionDbState, sessionId: string): string | null {
  const session = getSessionFn(state, sessionId);
  if (!session) {
    return null;
  }

  return getRepoPathFn(state, session);
}
