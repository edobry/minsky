/**
 * Legacy Repository Types
 *
 * Type definitions originally from the parent repository.ts file.
 * These are the types used by the old-style createRepositoryBackend factory,
 * resolveRepository functions, and legacy backend implementations
 * (localGitBackend.ts, remoteGitBackend.ts).
 */
import type { UriFormat } from "../uri-utils";

/**
 * Repository backend types supported by the system.
 */
export enum RepositoryBackendType {
  LOCAL = "local",
  REMOTE = "remote",
  GITHUB = "github",
}

/**
 * Repository resolution options.
 */
export interface RepositoryResolutionOptions {
  /**
   * Explicit repository URI or path
   */
  uri?: string;

  /**
   * Session name to resolve the repository from
   */
  session?: string;

  /**
   * Task ID to resolve the repository from
   */
  taskId?: string;

  /**
   * Whether to auto-detect the repository from the current directory
   * Default: true if no other options are provided
   */
  autoDetect?: boolean;

  /**
   * Current working directory for auto-detection
   * Default: process.cwd()
   */
  cwd?: string;
}

/**
 * Resolved repository information.
 */
export interface ResolvedRepository {
  /**
   * The repository URI
   */
  uri: string;

  /**
   * The normalized repository name (org/repo or local/repo)
   */
  name: string;

  /**
   * Whether this is a local repository
   */
  isLocal: boolean;

  /**
   * The repository path for local repositories
   */
  path?: string;

  /**
   * The repository backend type
   */
  backendType: RepositoryBackendType;

  /**
   * Repository format (HTTPS, SSH, etc.)
   */
  format: UriFormat;
}

/**
 * Status information about a repository.
 */
export interface RepositoryStatus {
  clean: boolean;
  changes: string[];
  branch: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  remotes?: string[];
  modifiedFiles?: Array<{ status: string; file: string }>;
  [key: string]: any;
}

/**
 * Base repository configuration.
 */
export interface RepositoryConfig {
  type: RepositoryBackendType | "local" | "remote" | "github";
  path?: string; // Local repository path
  url?: string; // Remote repository URL
  repoUrl?: string; // Alias for url - repository URL
  branch?: string; // Branch to checkout
}

/**
 * Remote Git repository configuration.
 */
export interface RemoteGitConfig extends RepositoryConfig {
  type: RepositoryBackendType.REMOTE;
  url: string; // Required for remote repositories
  branch?: string; // Branch to checkout
}

/**
 * GitHub repository configuration.
 */
export interface GitHubConfig extends Omit<RemoteGitConfig, "type"> {
  type: RepositoryBackendType.GITHUB;
  owner?: string; // GitHub repository owner
  repo?: string; // GitHub repository name
  token?: string; // GitHub access token (optional, uses git config if not provided)
}

/**
 * Repository validation result.
 */
export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  // Additional fields to align with Result interface
  success?: boolean;
  message?: string;
  error?: Error;
}

/**
 * Repository clone result.
 */
export interface CloneResult {
  workdir: string; // Local working directory path
  session: string; // Session identifier
}

/**
 * Branch operation result.
 */
export interface BranchResult {
  workdir: string; // Local working directory path
  branch: string; // Created/checked out branch name
}

/**
 * Repository backend interface.
 * All repository operations should be implemented by backend classes.
 */
export interface RepositoryBackend {
  /**
   * Clone the repository to the specified destination.
   * @param session Session identifier
   * @returns CloneResult with working directory information
   */
  clone(session: string): Promise<CloneResult>;

  /**
   * Get the status of the repository.
   * @param session Optional session identifier
   * @returns RepositoryStatus with clean state, changes, and branch information
   */
  getStatus(session?: string): Promise<RepositoryStatus>;

  /**
   * Get the local path of the repository.
   * @param session Optional session identifier
   * @returns The local repository path (or Promise resolving to path)
   */
  getPath(session?: string): string | Promise<string>;

  /**
   * Validate the repository configuration.
   * @returns ValidationResult indicating if the repository is valid
   */
  validate(): Promise<ValidationResult>;

  /**
   * Push changes to the remote repository.
   * @param branch Branch to push (defaults to current _branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  push(branch?: string): Promise<{ success: boolean; message: string }>;

  /**
   * Pull changes from the remote repository.
   * @param branch Branch to pull (defaults to current _branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  pull(branch?: string): Promise<{ success: boolean; message: string }>;

  /**
   * Create a new branch and switch to it.
   * @param session Session identifier
   * @param name Branch name to create
   * @returns BranchResult with working directory and branch information
   */
  branch(session: string, name: string): Promise<BranchResult>;

  /**
   * Checkout an existing branch.
   * @param branch Branch name to checkout
   * @returns void
   */
  checkout(branch: string): Promise<void>;

  /**
   * Get the repository configuration.
   * @returns The repository configuration
   */
  getConfig(): RepositoryConfig;
}

/**
 * Alias for backward compatibility with existing code.
 */
export type RepositoryBackendConfig = RepositoryConfig;
