/**
 * Repository backend interface for Minsky.
 * Defines the contract for different repository backends (local, remote, GitHub).
 */

/**
 * Repository backend types supported by the system.
 */
export enum RepositoryBackendType {
  LOCAL = "local",
  REMOTE = "remote",
  GITHUB = "github",
}

/**
 * Status information about a repository.
 */
export interface RepositoryStatus {
  clean: boolean;
  changes: string[];
  branch: string;
  tracking?: string;
}

/**
 * Base repository configuration.
 */
export interface RepositoryConfig {
  type: RepositoryBackendType;
  path?: string; // Local repository path
  url?: string; // Remote repository URL
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
   * @returns RepositoryStatus with clean state, changes, and branch information
   */
  getStatus(): Promise<RepositoryStatus>;

  /**
   * Get the local path of the repository.
   * @returns The local repository path
   */
  getPath(): string;

  /**
   * Validate the repository configuration.
   * @returns ValidationResult indicating if the repository is valid
   */
  validate(): Promise<ValidationResult>;

  /**
   * Push changes to the remote repository.
   * @param branch Branch to push (defaults to current branch)
   * @returns void
   */
  push(branch?: string): Promise<void>;

  /**
   * Pull changes from the remote repository.
   * @param branch Branch to pull (defaults to current branch)
   * @returns void
   */
  pull(branch?: string): Promise<void>;

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

/**
 * Create a repository backend instance based on the provided configuration.
 *
 * @param config Repository configuration
 * @returns RepositoryBackend instance
 */
export async function createRepositoryBackend(
  config: RepositoryConfig
): Promise<RepositoryBackend> {
  switch (config.type) {
  case RepositoryBackendType.LOCAL: {
    const { LocalGitBackend } = await import("./localGitBackend.js");
    return new LocalGitBackend(config);
  }
  case RepositoryBackendType.REMOTE: {
    const { RemoteGitBackend } = await import("./remoteGitBackend.js");
    return new RemoteGitBackend(config);
  }
  case RepositoryBackendType.GITHUB: {
    // Will be implemented in later phase
    throw new Error("GitHub backend not implemented yet");
  }
  default: {
    throw new Error(`Unsupported repository backend type: ${config.type}`);
  }
  }
}
