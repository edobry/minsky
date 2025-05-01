/**
 * Repository Backend Interface
 * 
 * Defines a common interface for different repository backend implementations.
 * This allows Minsky to support different repository sources (local git, GitHub, etc.)
 * without changing the core session management logic.
 */

/**
 * Configuration for repository backends
 */
export interface RepositoryBackendConfig {
  /**
   * The type of repository backend to use
   */
  type: 'local' | 'github';
  
  /**
   * Repository URL or path
   */
  repoUrl: string;
  
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
  getStatus(session: string): Promise<Record<string, any>>;
  
  /**
   * Get the repository path
   * @param session Session identifier
   * @returns Full path to the repository
   */
  getPath(session: string): Promise<string>;
  
  /**
   * Validate the repository configuration
   * @returns Promise that resolves if the repository is valid
   */
  validate(): Promise<void>;
}

/**
 * Factory function to create a repository backend
 * @param config Repository backend configuration
 * @returns Repository backend instance
 */
export async function createRepositoryBackend(config: RepositoryBackendConfig): Promise<RepositoryBackend> {
  // Dynamic import to avoid circular dependencies
  if (config.type === 'github') {
    const { GitHubBackend } = await import('./github');
    return new GitHubBackend(config);
  } else {
    // Default to local git backend
    const { LocalGitBackend } = await import('./local');
    return new LocalGitBackend(config);
  }
} 
