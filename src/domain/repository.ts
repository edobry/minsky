/**
 * Repository backend interface for Minsky.
 * Defines the contract for different repository backends (local, remote, GitHub).
 */
import { normalizeRepoName } from './repo-utils.js';

/**
 * Repository backend types supported by the system.
 */
export enum RepositoryBackendType {
  LOCAL = 'local',
  REMOTE = 'remote',
  GITHUB = 'github',
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
  [key: string]: unknown;
}

/**
 * Base repository configuration.
 */
export interface RepositoryConfig {
  type: RepositoryBackendType | 'local' | 'remote' | 'github';
  path?: string;        // Local repository path
  url?: string;         // Remote repository URL
  branch?: string;      // Branch to checkout
}

/**
 * Remote Git repository configuration.
 */
export interface RemoteGitConfig extends RepositoryConfig {
  type: RepositoryBackendType.REMOTE;
  url: string;          // Required for remote repositories
  branch?: string;      // Branch to checkout
}

/**
 * GitHub repository configuration.
 */
export interface GitHubConfig extends Omit<RemoteGitConfig, 'type'> {
  type: RepositoryBackendType.GITHUB;
  owner?: string;       // GitHub repository owner
  repo?: string;        // GitHub repository name
  token?: string;       // GitHub access token (optional, uses git config if not provided)
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
  workdir: string;      // Local working directory path
  session: string;      // Session identifier
}

/**
 * Branch operation result.
 */
export interface BranchResult {
  workdir: string;      // Local working directory path
  branch: string;       // Created/checked out branch name
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
  getStatus(session?: string): Promise<any>;
  
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
  validate(): Promise<any>;
  
  /**
   * Push changes to the remote repository.
   * @param branch Branch to push (defaults to current branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  push(branch?: string): Promise<any>;
  
  /**
   * Pull changes from the remote repository.
   * @param branch Branch to pull (defaults to current branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  pull(branch?: string): Promise<any>;
  
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
      const { GitService } = await import("./git.js");
      const gitService = new GitService();
      
      // Create an adapter using GitService that conforms to RepositoryBackend interface
      return {
        clone: async (session: string): Promise<CloneResult> => {
          return await gitService.clone({
            repoUrl: config.url || "",
            session,
            backend: "github",
            github: {
              token: (config as GitHubConfig).token,
              owner: (config as GitHubConfig).owner,
              repo: (config as GitHubConfig).repo
            }
          });
        },
        
        getStatus: async (session?: string): Promise<RepositoryStatus> => {
          // If no session is provided, work with the most recent session
          if (!session) {
            const sessionDb = new (await import("./session.js")).SessionDB();
            const sessions = await sessionDb.listSessions();
            const repoName = normalizeRepoName(config.url || "");
            const repoSession = sessions.find(s => s.repoName === repoName);
            if (!repoSession) {
              throw new Error("No session found for this repository");
            }
            session = repoSession.session;
          }
          
          const repoName = normalizeRepoName(config.url || "");
          const workdir = gitService.getSessionWorkdir(repoName, session);
          
          const gitStatus = await gitService.getStatus(workdir);
          
          // Get additional status info directly via Git commands
          const { stdout: branchOutput } = await (await import("util")).promisify(
            (await import("child_process")).exec
          )(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
          
          const branch = branchOutput.trim();
          return {
            clean: gitStatus.modified.length === 0 && gitStatus.untracked.length === 0,
            changes: [
              ...gitStatus.modified.map(file => `M ${file}`),
              ...gitStatus.untracked.map(file => `?? ${file}`),
              ...gitStatus.deleted.map(file => `D ${file}`)
            ],
            branch,
            // Add other required fields from RepositoryStatus
            modifiedFiles: [
              ...gitStatus.modified.map(file => ({ status: "M", file })),
              ...gitStatus.untracked.map(file => ({ status: "??", file })),
              ...gitStatus.deleted.map(file => ({ status: "D", file }))
            ],
            dirty: gitStatus.modified.length > 0 || gitStatus.untracked.length > 0
          };
        },
        
        getPath: async (session?: string): Promise<string> => {
          // If no session is provided, work with the most recent session
          if (!session) {
            const sessionDb = new (await import("./session.js")).SessionDB();
            const sessions = await sessionDb.listSessions();
            const repoName = normalizeRepoName(config.url || "");
            const repoSession = sessions.find(s => s.repoName === repoName);
            if (!repoSession) {
              throw new Error("No session found for this repository");
            }
            session = repoSession.session;
          }
          
          const repoName = normalizeRepoName(config.url || "");
          return gitService.getSessionWorkdir(repoName, session);
        },
        
        validate: async (): Promise<ValidationResult> => {
          // Basic validation of the GitHub configuration
          if (!config.url) {
            return {
              valid: false,
              issues: ["Repository URL is required"],
              success: false,
              message: "Repository URL is required"
            };
          }
          
          return {
            valid: true,
            success: true,
            message: "GitHub configuration is valid"
          };
        },
        
        push: async (branch?: string): Promise<void> => {
          // Find an existing session for this repository
          const sessionDb = new (await import("./session.js")).SessionDB();
          const sessions = await sessionDb.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find(s => s.repoName === repoName);
          
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          
          const session = repoSession.session;
          const workdir = gitService.getSessionWorkdir(repoName, session);
          
          await gitService.push({
            session,
            repoPath: workdir,
            branch
          });
        },
        
        pull: async (branch?: string): Promise<void> => {
          // Find an existing session for this repository
          const sessionDb = new (await import("./session.js")).SessionDB();
          const sessions = await sessionDb.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find(s => s.repoName === repoName);
          
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          
          const workdir = gitService.getSessionWorkdir(repoName, repoSession.session);
          await gitService.pullLatest(workdir);
        },
        
        branch: async (session: string, name: string): Promise<BranchResult> => {
          const repoName = normalizeRepoName(config.url || "");
          const workdir = gitService.getSessionWorkdir(repoName, session);
          
          // Execute branch creation via Git command
          await (await import("util")).promisify(
            (await import("child_process")).exec
          )(`git -C ${workdir} checkout -b ${name}`);
          
          return {
            workdir,
            branch: name
          };
        },
        
        checkout: async (branch: string): Promise<void> => {
          // Find an existing session for this repository
          const sessionDb = new (await import("./session.js")).SessionDB();
          const sessions = await sessionDb.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find(s => s.repoName === repoName);
          
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          
          const workdir = gitService.getSessionWorkdir(repoName, repoSession.session);
          
          // Execute checkout via Git command
          await (await import("util")).promisify(
            (await import("child_process")).exec
          )(`git -C ${workdir} checkout ${branch}`);
        },
        
        getConfig: (): RepositoryConfig => {
          return {
            type: RepositoryBackendType.GITHUB,
            url: config.url,
            owner: (config as GitHubConfig).owner,
            repo: (config as GitHubConfig).repo,
            token: (config as GitHubConfig).token
          } as RepositoryConfig;
        }
      };
    }
    default: {
      throw new Error(`Unsupported repository backend type: ${config.type}`);
    }
  }
} 
