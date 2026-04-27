import type { TaskServiceInterface } from "../tasks";
import type { GitServiceInterface } from "../git";
import type { WorkspaceUtilsInterface } from "../workspace";
import type { PullRequestInfo } from "./session-db";
import type { DatabaseQueryOptions } from "../storage/database-storage";

export enum SessionStatus {
  CREATED = "CREATED",
  ACTIVE = "ACTIVE",
  PR_OPEN = "PR_OPEN",
  PR_APPROVED = "PR_APPROVED",
  MERGED = "MERGED",
  CLOSED = "CLOSED",
}

/**
 * Core session record interface
 *
 * TASK 283: Task IDs are stored in plain format (e.g., "283") without # prefix.
 * Use formatTaskIdForDisplay() from task-id-utils.ts when displaying to users.
 */
export interface SessionRecord {
  sessionId: string;
  repoName: string;
  repoUrl: string;
  repoPath?: string; // Local path to the repository
  createdAt: string;
  /** Task ID in storage format (plain number string, e.g., "283") */
  taskId?: string;
  backendType?: "github" | "gitlab" | "bitbucket"; // Repository backend type
  lastActivityAt?: string;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  commitCount?: number;
  status?: SessionStatus;
  agentId?: string;
  /** Git branch name created for this session */
  branch?: string;
  prState?: {
    branchName: string;
    exists?: boolean; // Whether the PR branch exists
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
  /** @deprecated Use `createdAt` instead */
  created?: string;
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
}

export type SessionLiveness = "healthy" | "idle" | "stale" | "orphaned";

export function deriveSessionLiveness(
  record: Pick<SessionRecord, "lastActivityAt" | "status" | "createdAt">,
  options?: { idleThresholdMs?: number; staleThresholdMs?: number }
): SessionLiveness {
  const idleMs = options?.idleThresholdMs ?? 30 * 60 * 1000; // 30 min
  const staleMs = options?.staleThresholdMs ?? 2 * 60 * 60 * 1000; // 2 hours

  const activityTime = record.lastActivityAt || record.createdAt;
  if (!activityTime) return "stale";

  const elapsed = Date.now() - new Date(activityTime).getTime();

  if (record.status === SessionStatus.MERGED || record.status === SessionStatus.CLOSED) {
    return "healthy"; // terminal states are always "healthy" — they're done
  }

  if (elapsed > staleMs) return "stale";
  if (elapsed > idleMs) return "idle";
  return "healthy";
}

/**
 * Session interface for external use
 *
 * TASK 283: Task IDs are stored in plain format (e.g., "283") without # prefix.
 * Use formatTaskIdForDisplay() from task-id-utils.ts when displaying to users.
 */
export interface Session {
  sessionId: string;
  repoUrl?: string;
  repoName?: string;
  /** @deprecated No longer stored persistently; kept for compatibility with code that still reads it */
  branch?: string;
  createdAt?: string;
  /** Task ID in storage format (plain number string, e.g., "283") */
  taskId?: string;
  /** Computed liveness status derived from lastActivityAt and session status */
  liveness?: SessionLiveness;
  backendType?: "github" | "gitlab" | "bitbucket";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  prState?: {
    branchName: string;
    exists?: boolean;
    lastChecked: string;
    createdAt?: string;
    mergedAt?: string;
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-id")
  prApproved?: boolean; // Whether this session's PR is approved
}

/**
 * Options for listing sessions, applied at the storage layer.
 *
 * Extends DatabaseQueryOptions so a SessionListOptions value can be passed
 * straight to a storage backend's getEntities() without an unsafe cast.
 */
export interface SessionListOptions extends DatabaseQueryOptions {
  // All fields are inherited from DatabaseQueryOptions:
  //   taskId, repoName, createdAfter, createdBefore, limit, offset, orderBy
  // Kept as a named alias here for domain-layer clarity.
}

/**
 * Interface for session database operations
 * This defines the contract for session management functionality
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(options?: SessionListOptions): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "sessionId">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord | Record<string, unknown>): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionId: string): Promise<string>;
}

/**
 * Session review parameters interface
 */
export interface SessionReviewParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  output?: string;
  json?: boolean;
  prBranch?: string;
}

/**
 * Session review result interface
 */
export interface SessionReviewResult {
  session: string;
  taskId?: string;
  taskSpec?: string;
  prDescription?: string;
  prBranch: string;
  baseBranch: string;
  diff?: string;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  /** Warnings from data-gathering steps that failed non-fatally */
  warnings?: string[];
}

/**
 * Session dependencies for testing and dependency injection
 */
export interface SessionDependencies {
  sessionDB?: SessionProviderInterface;
  gitService?: GitServiceInterface;
  taskService?: TaskServiceInterface & {
    getTaskSpecData?: (taskId: string) => Promise<string>;
  };
  workspaceUtils?: WorkspaceUtilsInterface;
  getCurrentSession?: (repoPath: string) => Promise<string | null>;
}

/**
 * Session creation dependencies
 */
export interface SessionCreateDependencies extends SessionDependencies {
  resolveRepoPath?: (repoName: string) => Promise<string>;
}

/**
 * Session approval dependencies
 */
export interface SessionApprovalDependencies {
  sessionDB?: SessionProviderInterface;
  gitService?: GitServiceInterface;
  taskService?: {
    setTaskStatus?: (taskId: string, status: string) => Promise<void>;
    getBackendForTask?: (taskId: string) => Promise<string>;
  };
  workspaceUtils?: WorkspaceUtilsInterface;
  getCurrentSession?: (repoPath: string) => Promise<string | null>;
}

/**
 * Session approval result interface
 */
export interface SessionApprovalResult {
  session: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
  baseBranch: string;
  prBranch: string;
  taskId?: string;
  isNewlyApproved: boolean;
}

/**
 * Session prepare PR result interface
 */
export interface SessionPrResult {
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
  url?: string; // PR URL from repository backend
  // Session information for CLI formatting
  session?: {
    sessionId: string;
    taskId?: string;
    repoName?: string;
  };
  sessionId?: string; // Alternative property name for formatter compatibility
}
