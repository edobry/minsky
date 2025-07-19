import type { TaskServiceInterface } from "../tasks";
import type { GitServiceInterface } from "../git";
import type { WorkspaceUtilsInterface } from "../workspace";

/**
 * Core session record interface
 */
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github"; // Added for repository backend support
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string; // Branch property is already part of the interface
}

/**
 * Session interface for external use
 */
export interface Session {
  session: string;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  createdAt?: string;
  taskId?: string;
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
}

/**
 * Interface for session database operations
 * This defines the contract for session management functionality
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(): Promise<SessionRecord[]>;

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
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord | any): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionName: string): Promise<string>;
}

/**
 * Session review parameters interface
 */
export interface SessionReviewParams {
  session?: string;
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
    setTaskStatus?: (taskId: string, status: string) => Promise<any>;
    getBackendForTask?: (taskId: string) => Promise<any>;
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
} 
