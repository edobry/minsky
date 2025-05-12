/**
 * Repository Backend Interface
 * 
 * Defines a common interface for different repository backend implementations.
 * This allows Minsky to support different repository sources (local git, GitHub, etc.)
 * without changing the core session management logic.
 */

export * from './RepositoryBackend.ts';

/**
 * Configuration for repository backends
 */
export interface RepositoryBackendConfig {
  /**
   * The type of repository backend to use
   */
  type: 'local' | 'remote' | 'github';
  
  /**
   * Repository URL or path
   */
  repoUrl: string;
  
  /**
   * Branch to checkout (for remote repositories)
   */
  branch?: string;
  
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
  LOCAL = 'local',
  REMOTE = 'remote',
  GITHUB = 'github',
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
export async function createRepositoryBackend(config: RepositoryBackendConfig): Promise<RepositoryBackend> {
  // Dynamic import to avoid circular dependencies
  if (config.type === RepositoryBackendType.GITHUB) {
    const { GitHubBackend } = await import('./github.ts');
    return new GitHubBackend(config);
  } else if (config.type === RepositoryBackendType.REMOTE) {
    const { RemoteGitBackend } = await import('./remote.ts');
    return new RemoteGitBackend(config);
  } else {
    // Default to local git backend
    const { LocalGitBackend } = await import('./local.ts');
    return new LocalGitBackend(config);
  }
} 
