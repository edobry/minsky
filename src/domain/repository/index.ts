/**
 * Repository Backend Interface
 *
 * Defines a common interface for different repository backend implementations.
 * This allows Minsky to support different repository sources (local git, GitHub, etc.)
 * without changing the core session management logic.
 */

export * from "./RepositoryBackend";
export * from "./approval-types";

// Import RepositoryStatus but define our own ValidationResult
import type { RepositoryStatus } from "../repository";

import { DEFAULT_TIMEOUT_MS } from "../../utils/constants";
import { getErrorMessage } from "../../errors/index";
import type { ApprovalInfo, ApprovalStatus } from "./approval-types";
// Re-export RepositoryStatus
export type { RepositoryStatus };

// Define ValidationResult with compatibility for both interfaces
export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  success?: boolean;
  message?: string;
  error?: Error;
}

// Define RepoStatus as extending RepositoryStatus for backward compatibility
export interface RepoStatus extends RepositoryStatus {
  // Additional fields specific to the original RepoStatus interface
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  remotes: string[];
  [key: string]: any;
}

/**
 * Configuration for repository backends
 */
export interface RepositoryBackendConfig {
  /**
   * The type of repository backend to use
   */
  type: "local" | "remote" | "github";

  /**
   * Repository URL or path
   */
  repoUrl: string;

  /**
   * Branch to checkout (for remote repositories)
   */
  branch?: string;

  /**
   * Remote repository-specific options
   */
  remote?: {
    /**
     * Authentication method to use for remote repositories
     */
    authMethod?: "ssh" | "https" | "token";

    /**
     * Clone depth for shallow clones (default: 1)
     */
    depth?: number;

    /**
     * Number of retry attempts for network operations (default: 3)
     */
    retryAttempts?: number;

    /**
     * Timeout in milliseconds for git operations (default: DEFAULT_TIMEOUT_MS)
     */
    timeout?: number;

    /**
     * Whether to follow redirects when cloning (default: true)
     */
    followRedirects?: boolean;
  };

  /**
   * GitHub-specific options for GitHub backend
   */
  github?: {
    /**
     * GitHub access token for authentication
     */
    token?: string;

    /**
     * GitHub repository owner (organization or user)
     */
    owner?: string;

    /**
     * GitHub repository name
     */
    repo?: string;

    /**
     * GitHub API URL (for GitHub Enterprise)
     */
    apiUrl?: string;

    /**
     * GitHub Enterprise domain (for GitHub Enterprise)
     */
    enterpriseDomain?: string;

    /**
     * Whether to use the GitHub API for operations like PR creation
     */
    useApi?: boolean;
  };
}

/**
 * Repository clone result
 */
export interface CloneResult {
  /**
   * Working directory where the repository was cloned
   */
  workdir: string;

  /**
   * Session identifier
   */
  session: string;
}

/**
 * Repository branch result
 */
export interface BranchResult {
  /**
   * Working directory where the branch was created
   */
  workdir: string;

  /**
   * Branch name
   */
  branch: string;
}

/**
 * Pull Request information
 */
export interface PRInfo {
  /**
   * PR number (for platforms that support it) or identifier
   */
  number: number | string;

  /**
   * PR URL (for platforms that support it) or branch name
   */
  url: string;

  /**
   * PR state
   */
  state: "open" | "closed" | "merged";

  /**
   * Additional metadata specific to the repository backend
   */
  metadata?: any;
}

/**
 * Pull Request merge information
 */
export interface MergeInfo {
  /**
   * Commit hash of the merge
   */
  commitHash: string;

  /**
   * Date when the merge occurred
   */
  mergeDate: string;

  /**
   * User who performed the merge
   */
  mergedBy: string;

  /**
   * Additional metadata specific to the repository backend
   */
  metadata?: any;
}

// Completely rewritten repository backend interface with flexible types
export interface RepositoryBackend {
  getType(): string;
  clone(session: string): Promise<CloneResult>;
  branch(session: string, branch: string): Promise<BranchResult>;
  getStatus(session?: string): Promise<any>;
  getPath(session?: string): string | Promise<string>;
  validate(): Promise<any>;
  push(branch?: string): Promise<any>;
  pull(branch?: string): Promise<any>;
  checkout?(branch: string): Promise<void>;
  getConfig?(): RepositoryBackendConfig;

  // New PR workflow methods
  /**
   * Create a pull request from the source branch to the base branch
   *
   * @param title - PR title
   * @param body - PR body/description
   * @param sourceBranch - Source branch name (session branch)
   * @param baseBranch - Target branch name (usually main/master)
   * @param session - Session identifier for workspace context
   * @param draft - Whether to create as draft PR (GitHub only)
   * @returns Promise<PRInfo> - Information about the created PR
   */
  createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string,
    session?: string,
    draft?: boolean
  ): Promise<PRInfo>;

  /**
   * Update an existing pull request
   *
   * @param options - Update options including prIdentifier, title, body, session
   * @returns Promise<PRInfo> - Information about the updated PR
   */
  updatePullRequest(options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }): Promise<PRInfo>;

  /**
   * Merge a pull request into the base branch
   *
   * @param prIdentifier - PR number/ID or branch name depending on backend
   * @param session - Session identifier for workspace context
   * @returns Promise<MergeInfo> - Information about the merge operation
   */
  mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo>;

  /**
   * NEW: Approve a pull request without merging (Task #358)
   *
   * Performs approval operation on the specified pull request. This separates
   * the approval action from the merge action, enabling standard PR workflows
   * where approval and merging are distinct operations.
   *
   * @param prIdentifier - PR number/ID or branch name depending on backend
   * @param reviewComment - Optional review comment to include with approval
   * @returns Promise<ApprovalInfo> - Information about the approval operation
   */
  approvePullRequest(prIdentifier: string | number, reviewComment?: string): Promise<ApprovalInfo>;

  /**
   * NEW: Check approval status of a pull request (Task #358)
   *
   * Retrieves the current approval state of a pull request, including
   * whether it has sufficient approvals to be merged, approval count,
   * and platform-specific requirements.
   *
   * @param prIdentifier - PR number/ID or branch name depending on backend
   * @returns Promise<ApprovalStatus> - Current approval state and merge eligibility
   */
  getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus>;

  /**
   * Get PR details for review rendering (backend-agnostic)
   * If prIdentifier is omitted, implementation should infer from session when possible
   */
  getPullRequestDetails(options: { prIdentifier?: string | number; session?: string }): Promise<{
    number?: number | string;
    url?: string;
    state?: string;
    title?: string;
    body?: string;
    headBranch?: string;
    baseBranch?: string;
    author?: string;
    createdAt?: string;
    updatedAt?: string;
    mergedAt?: string;
  }>;

  /**
   * Get PR diff and optional stats (backend-agnostic)
   * If prIdentifier is omitted, implementation should infer from session when possible
   */
  getPullRequestDiff(options: { prIdentifier?: string | number; session?: string }): Promise<{
    diff: string;
    stats?: { filesChanged: number; insertions: number; deletions: number };
  }>;

  /**
   * Post-session-update hook for backend-specific operations
   * Called after a session is updated to allow backends to perform additional work
   *
   * This is designed to be extensible for future event-driven automation:
   * - Current: Simple PR branch updates for local repos
   * - Future: Full work item generation and AI-powered sync orchestration
   *
   * @param event - Session update event with context
   * @returns Promise<void>
   */
  onSessionUpdated?(event: SessionUpdateEvent): Promise<void>;
}

/**
 * Session update event - designed for future extensibility with work item system
 * Currently simple, but structured to support AI-powered automation from task #361
 */
export interface SessionUpdateEvent {
  /** Basic session and context info */
  session: any;
  workdir: string;

  /** Update details - extensible for future event enrichment */
  updateType: "pull" | "merge" | "rebase" | "checkout";

  /** Future extensibility hooks */
  context?: {
    /** For future: PR merge events that triggered this */
    triggerEvent?: any;
    /** For future: AI analysis and work item generation */
    automationConfig?: any;
    /** For future: Related sessions and dependency tracking */
    relatedSessions?: string[];
  };
}

/**
 * Repository backend types
 */
export enum RepositoryBackendType {
  LOCAL = "local",
  REMOTE = "remote",
  GITHUB = "github",
}

/**
 * Operation result
 */
export interface Result {
  /**
   * Whether the operation was successful
   */
  success: boolean;

  /**
   * Optional message
   */
  message?: string;

  /**
   * Optional error
   */
  error?: Error;
}

/**
 * Factory function to create a repository backend
 * @param config Repository backend configuration
 * @returns Repository backend instance
 */
export async function createRepositoryBackend(
  config: RepositoryBackendConfig
): Promise<RepositoryBackend> {
  // Validate common configuration
  if (!config.type) {
    throw new Error("Repository backend type is required");
  }

  if (!config.repoUrl) {
    throw new Error("Repository URL is required");
  }

  // Backend-specific validation
  switch (config.type) {
    case RepositoryBackendType.LOCAL: {
      // For local repositories, validate the path exists (if it's a local path)
      if (!config.repoUrl.includes("://") && !config.repoUrl.includes("@")) {
        try {
          const { exec } = await import("child_process");
          const { promisify } = await import("util");
          const execAsync = promisify(exec);
          const { stdout } = await execAsync(
            `test -d "${config.repoUrl}" && echo "exists" || echo "not exists"`
          );
          if (stdout.trim() === "not exists") {
            throw new Error(`Repository path does not exist: ${config.repoUrl}`);
          }
        } catch (error) {
          throw new Error(
            `Failed to validate local repository _path: ${getErrorMessage(error as any)}`
          );
        }
      }

      const { LocalGitBackend } = await import("./local");
      return new LocalGitBackend(config);
    }

    case RepositoryBackendType.REMOTE: {
      // For remote repositories, validate URL format and required options
      if (
        !config.repoUrl.startsWith("http://") &&
        !config.repoUrl.startsWith("https://") &&
        !config.repoUrl.startsWith("git@") &&
        !config.repoUrl.startsWith("ssh://")
      ) {
        throw new Error(`Invalid remote repository URL format: ${config.repoUrl}`);
      }

      // Validate remote options if provided
      if (config.remote) {
        if (
          config.remote.authMethod &&
          !["ssh", "https", "token"].includes(config.remote.authMethod)
        ) {
          throw new Error(
            `Invalid auth method: ${config.remote.authMethod}. Must be one of: ssh, https, token`
          );
        }

        if (
          config.remote.depth &&
          (typeof config.remote.depth !== "number" || config.remote.depth < 1)
        ) {
          throw new Error("Clone depth must be a positive number");
        }
      }

      const { RemoteGitBackend } = await import("./remote");
      return new RemoteGitBackend(config);
    }

    case RepositoryBackendType.GITHUB: {
      // For GitHub repositories, validate GitHub-specific options
      if (config.github) {
        // If owner and repo are provided, validate them
        if (
          (config.github.owner && !config.github.repo) ||
          (!config.github.owner && config.github.repo)
        ) {
          throw new Error("Both owner and repo must be provided for GitHub repositories");
        }

        // Validate GitHub Enterprise settings if provided
        if (config.github.enterpriseDomain && !config.github.apiUrl) {
          throw new Error("API URL must be provided when using GitHub Enterprise");
        }
      }

      const { GitHubBackend } = await import("./github");
      return new GitHubBackend(config);
    }

    default:
      throw new Error(`Unsupported repository backend type: ${config.type}`);
  }
}
