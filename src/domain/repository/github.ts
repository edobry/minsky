import { join } from "path";
import { mkdir } from "fs/promises";
import { promisify } from "util";
import { exec } from "child_process";
import { SessionDB } from "../session.js";
import { normalizeRepoName } from "../repo-utils.js";
import { GitService } from "../git.js";
import type { RepositoryStatus } from "../repository.js";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index.js";

// Define a global for process to avoid linting errors
declare const process: {
  env: {
    XDG_STATE_HOME?: string;
    HOME?: string;
  };
};

const execAsync = promisify(exec);

/**
 * GitHub Repository Backend implementation
 * Handles cloning, branching and other operations for GitHub repositories
 */
export class GitHubBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl: string;
  private readonly repoName: string;
  private readonly owner?: string;
  private readonly repo?: string;
  private sessionDb: SessionDB;
  private gitService: GitService;

  /**
   * Create a new GitHubBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky", "git");

    // Extract GitHub-specific options
    this.owner = config.github?.owner;
    this.repo = config.github?.repo;

    // Set the repo URL using the provided URL or construct from owner/repo if available
    // Note: We don't embed tokens in the URL, letting Git use the system's credentials
    this.repoUrl =
      config.repoUrl ||
      (this.owner && this.repo ? `https://github.com/${this.owner}/${this.repo}.git` : "");

    if (!this.repoUrl) {
      throw new Error("Repository URL is required for GitHub backend");
    }

    this.repoName = normalizeRepoName(this.repoUrl);
    this.sessionDb = new SessionDB();
    this.gitService = new GitService(this.baseDir);
  }

  /**
   * Get the backend type
   * @returns Backend type identifier
   */
  getType(): string {
    return "github";
  }

  /**
   * Ensure the base directory exists
   */
  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the session working directory path
   * @param session Session identifier
   * @returns Full path to the session working directory
   */
  private getSessionWorkdir(session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, this.repoName, "sessions", session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, this.repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(session);

    try {
      // Use GitService's clone method to delegate credential handling to Git
      const result = await this.gitService.clone({
        repoUrl: this.repoUrl,
        session,
        backend: "github"
      });

      return {
        workdir,
        session,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Provide more informative error messages for common GitHub issues
      if (error.message.includes("Authentication failed")) {
        throw new Error("GitHub authentication failed. Check your Git credentials.");
      } else if (error.message.includes("not found")) {
        throw new Error(
          `GitHub repository not found: ${this.owner}/${this.repo}. Check the owner and repo names.`
        );
      } else if (error.message.includes("timed out")) {
        throw new Error(
          "GitHub connection timed out. Check your network connection and try again."
        );
      } else {
        throw new Error(`Failed to clone GitHub repository: ${error.message}`);
      }
    }
  }

  /**
   * Create a branch in the repository
   * @param session Session identifier
   * @param branch Branch name
   * @returns Branch result with workdir and branch
   */
  async branch(session: string, branch: string): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = this.getSessionWorkdir(session);

    try {
      // Create branch using direct Git command since GitService doesn't have createBranch
      await execAsync(`git -C ${workdir} checkout -b ${branch}`);

      return {
        workdir,
        branch,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to create branch in GitHub repository: ${error.message}`);
    }
  }

  /**
   * Get repository status
   * This implementation gets the status for the most recently accessed session
   * to comply with the RepositoryBackend interface that doesn't take a session parameter
   * @returns Object with repository status information
   */
  async getStatus(): Promise<RepositoryStatus> {
    try {
      // Find a session for this repository
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find(session => session.repoName === this.repoName);
      
      if (!repoSession) {
        throw new Error("No session found for this repository");
      }
      
      // Get status for the session and convert to RepositoryStatus
      const repoStatus = await this.getStatusForSession(repoSession.session);
      return this.convertToRepositoryStatus(repoStatus);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to get GitHub repository status: ${error.message}`);
    }
  }

  /**
   * Get repository status for a specific session
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatusForSession(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);

    try {
      // Use GitService to get repository status
      const gitStatus = await this.gitService.getStatus(workdir);
      
      // Get additional information directly since GitStatus doesn't have it
      const { stdout: branchOutput } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      const branch = branchOutput.trim();
      
      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: revListOutput } = await execAsync(
          `git -C ${workdir} rev-list --left-right --count @{upstream}...HEAD`
        );
        const counts = revListOutput.trim().split(/\s+/);
        if (counts && counts.length === 2) {
          behind = parseInt(counts[0] || "0", 10);
          ahead = parseInt(counts[1] || "0", 10);
        }
      } catch {
        // If no upstream branch is set, this will fail - that's okay
      }
      
      // Get remote information
      const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote -v`);
      const remotes = remoteOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => line.split("\t")[0] || "")
        .filter((name, index, self) => name && self.indexOf(name) === index);
      
      // Convert GitService status to our RepoStatus format
      return {
        branch,
        ahead,
        behind,
        dirty: gitStatus.modified.length > 0 || gitStatus.untracked.length > 0 || gitStatus.deleted.length > 0,
        remotes,
        // Include GitHub specific information
        workdir,
        gitHubOwner: this.owner,
        gitHubRepo: this.repo,
        modifiedFiles: [
          ...gitStatus.modified.map(file => ({ status: "M", file })),
          ...gitStatus.untracked.map(file => ({ status: "??", file })),
          ...gitStatus.deleted.map(file => ({ status: "D", file }))
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to get GitHub repository status: ${error.message}`);
    }
  }

  /**
   * Get the repository path
   * This method is overloaded to work with both interface versions:
   * 1. Without parameters (repository.ts and RepositoryBackend.ts)
   * 2. With session parameter (index.ts)
   * @param session Optional session identifier
   * @returns Path to the repository
   */
  async getPath(session?: string): Promise<string> {
    if (session) {
      return this.getSessionWorkdir(session);
    }
    
    // If no session is provided, find one for this repository
    try {
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find(s => s.repoName === this.repoName);
      
      if (repoSession) {
        return this.getSessionWorkdir(repoSession.session);
      }
    } catch (err) {
      // If we can't find a session, just return the base directory
    }
    
    return this.baseDir;
  }

  /**
   * Validate the repository configuration
   * @returns Promise that resolves with result if the repository is valid
   */
  async validate(): Promise<Result> {
    try {
      // Validate required fields
      if (!this.repoUrl) {
        return {
          success: false,
          message: "Repository URL is required for GitHub backend",
        };
      }

      // If owner/repo are provided, validate them
      if (this.owner && this.repo) {
        // Use curl to check if the repo exists without cloning
        // Note: Using public API without token for validation only
        const command = `curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/${this.owner}/${this.repo}`;

        const { stdout } = await execAsync(command);
        const statusCode = parseInt(stdout.trim(), 10);

        if (statusCode === 404) {
          return {
            success: false,
            message: `GitHub repository not found: ${this.owner}/${this.repo}`,
          };
        } else if (statusCode === 401 || statusCode === 403) {
          return {
            success: false,
            message: "GitHub API rate limit or permissions issue. The repo may still be valid.",
          };
        } else if (statusCode !== 200) {
          return {
            success: false,
            message: `Failed to validate GitHub repository: HTTP ${statusCode}`,
          };
        }
      }

      return {
        success: true,
        message: "GitHub repository validated successfully",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to validate GitHub repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Push changes to GitHub repository
   * @returns Result of the push operation
   */
  async push(): Promise<Result> {
    try {
      // Find a session for this repository
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find(session => session.repoName === this.repoName);
      
      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }
      
      const sessionName = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionName);
      
      // Use GitService for pushing changes
      const pushResult = await this.gitService.push({
        session: sessionName,
        repoPath: workdir,
        remote: "origin"
      });
      
      return {
        success: pushResult.pushed,
        message: pushResult.pushed 
          ? "Successfully pushed to repository" 
          : "No changes to push or push failed",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to push to repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Pull changes from GitHub repository
   * @returns Result of the pull operation
   */
  async pull(): Promise<Result> {
    try {
      // Find a session for this repository
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find(session => session.repoName === this.repoName);
      
      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }
      
      const sessionName = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionName);
      
      // Use GitService for pulling changes
      const pullResult = await this.gitService.pullLatest(workdir);
      
      return {
        success: true,
        message: pullResult.updated 
          ? "Successfully pulled changes from repository" 
          : "Already up-to-date. No changes pulled.",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to pull from repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Checkout an existing branch
   * @param branch Branch name to checkout
   * @returns Promise resolving to void
   */
  async checkout(branch: string): Promise<void> {
    try {
      // Find a session for this repository
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find(session => session.repoName === this.repoName);
      
      if (!repoSession) {
        throw new Error("No session found for this repository");
      }
      
      const sessionName = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionName);
      
      // Use GitService method if available, otherwise use direct command
      // This depends on GitService having a checkout method
      await execAsync(`git -C ${workdir} checkout ${branch}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to checkout branch: ${error.message}`);
    }
  }

  /**
   * Get the repository configuration
   * @returns The repository configuration
   */
  getConfig(): RepositoryBackendConfig {
    return {
      type: "github",
      repoUrl: this.repoUrl,
      github: {
        owner: this.owner,
        repo: this.repo
      }
    };
  }

  /**
   * Convert RepoStatus to RepositoryStatus
   * This handles the interface mismatch between the two status types
   */
  private convertToRepositoryStatus(status: RepoStatus): RepositoryStatus {
    // Extract modified file names from the modifiedFiles objects
    const modifiedFiles = status.modifiedFiles || [];
    const changes = modifiedFiles.map((m: { status: string; file: string }) => `${m.status} ${m.file}`);
    
    return {
      clean: !status.dirty,
      changes,
      branch: status.branch,
      tracking: status.remotes && status.remotes.length > 0 ? status.remotes[0] : undefined
    };
  }
}
