/**
 * Repository Backend Interface
 *
 * Defines a common interface for different repository backend implementations.
 * This allows Minsky to support different repository sources (local git, GitHub, etc.)
 * without changing the core session management logic.
 */

export * from "./RepositoryBackend";

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
     * Timeout in milliseconds for git operations (default: 30000)
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
 * Common interface for all repository backends
 */
export interface RepositoryBackend {
  /**
   * Get the backend identifier
   */
  getType(): string;

  /**
   * Clone the repository
   * @param session Session identifier
   * @returns Clone result
   */
  clone(session: string): Promise<CloneResult>;

  /**
   * Create a branch in the repository
   * @param session Session identifier
   * @param branch Branch name
   * @returns Branch result
   */
  branch(session: string, branch: string): Promise<BranchResult>;

  /**
   * Get the repository status
   * @param session Session identifier
   * @returns Object containing repository status information
   */
  getStatus(session: string): Promise<RepoStatus>;

  /**
   * Get the repository path
   * @param session Session identifier
   * @returns Full path to the repository
   */
  getPath(session: string): Promise<string>;

  /**
   * Validate the repository configuration
   * @returns Promise that resolves with result if the repository is valid, or rejects with an error
   */
  validate(): Promise<Result>;

  /**
   * Push changes to remote repository
   * @returns Result of the push operation
   */
  push(): Promise<Result>;

  /**
   * Pull changes from remote repository
   * @returns Result of the pull operation
   */
  pull(): Promise<Result>;
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
 * Repository status
 */
export interface RepoStatus {
  /**
   * Current branch
   */
  branch: string;

  /**
   * Number of commits ahead of remote
   */
  ahead: number;

  /**
   * Number of commits behind remote
   */
  behind: number;

  /**
   * Whether the working directory is dirty
   */
  dirty: boolean;

  /**
   * List of remotes
   */
  remotes: string[];

  /**
   * Additional properties
   */
  [key: string]: unknown;
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
    case RepositoryBackendType.LOCAL:
      // For local repositories, validate the path exists (if it's a local path)
      if (!config.repoUrl.includes("://") && !config.repoUrl.includes("@")) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          const { stdout } = await execAsync(`test -d "${config.repoUrl}" && echo "exists" || echo "not exists"`);
          if (stdout.trim() === "not exists") {
            throw new Error(`Repository path does not exist: ${config.repoUrl}`);
          }
        } catch (err) {
          throw new Error(`Failed to validate local repository path: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }

      const { LocalGitBackend } = await import('./local');
      return new LocalGitBackend(config);

    case RepositoryBackendType.REMOTE:
      // For remote repositories, validate URL format and required options
      if (!config.repoUrl.startsWith("http://") && 
          !config.repoUrl.startsWith("https://") && 
          !config.repoUrl.startsWith("git@") &&
          !config.repoUrl.startsWith("ssh://")) {
        throw new Error(`Invalid remote repository URL format: ${config.repoUrl}`);
      }

      // Validate remote options if provided
      if (config.remote) {
        if (config.remote.authMethod && 
            !["ssh", "https", "token"].includes(config.remote.authMethod)) {
          throw new Error(`Invalid auth method: ${config.remote.authMethod}. Must be one of: ssh, https, token`);
        }

        if (config.remote.depth && (typeof config.remote.depth !== 'number' || config.remote.depth < 1)) {
          throw new Error("Clone depth must be a positive number");
        }
      }

      const { RemoteGitBackend } = await import('./remote');
      return new RemoteGitBackend(config);

    case RepositoryBackendType.GITHUB:
      // For GitHub repositories, validate GitHub-specific options
      if (config.github) {
        // If owner and repo are provided, validate them
        if ((config.github.owner && !config.github.repo) || 
            (!config.github.owner && config.github.repo)) {
          throw new Error("Both owner and repo must be provided for GitHub repositories");
        }

        // Validate GitHub Enterprise settings if provided
        if (config.github.enterpriseDomain && !config.github.apiUrl) {
          throw new Error("API URL must be provided when using GitHub Enterprise");
        }
      }

      const { GitHubBackend } = await import('./github');
      return new GitHubBackend(config);

    default:
      throw new Error(`Unsupported repository backend type: ${config.type}`);
  }
}
