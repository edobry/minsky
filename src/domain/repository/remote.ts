import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { SessionDB } from "../session.js";
import { normalizeRepoName } from "../repo-utils.js";
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
    [key: string]: string | undefined;
  };
};

const execAsync = promisify(exec);

/**
 * Remote Git Repository Backend implementation
 * Handles operations for any remote Git repository
 */
export class RemoteGitBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl: string;
  private readonly repoName: string;
  private readonly defaultBranch?: string;
  private sessionDb: SessionDB;

  /**
   * Create a new RemoteGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky", "git");

    // Extract configuration options
    this.repoUrl = config.repoUrl;
    this.defaultBranch = config.branch;

    if (!this.repoUrl) {
      throw new Error("Repository URL is required for Remote Git backend");
    }

    this.repoName = normalizeRepoName(this.repoUrl);
    this.sessionDb = new SessionDB();
  }

  /**
   * Get the backend type
   * @returns Backend type identifier
   */
  getType(): string {
    return "remote";
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
      // Clone the repository
      let cloneCmd = `git clone ${this.repoUrl} ${workdir}`;

      // Add branch if specified
      if (this.defaultBranch) {
        cloneCmd += ` --branch ${this.defaultBranch}`;
      }

      await execAsync(cloneCmd);

      return {
        workdir,
        session,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Provide more informative error messages for common Git issues
      if (error.message.includes("Authentication failed")) {
        throw new Error("Git authentication failed. Check your credentials or SSH key.");
      } else if (error.message.includes("not found") || error.message.includes("does not exist")) {
        throw new Error(`Git repository not found: ${this.repoUrl}. Check the URL.`);
      } else if (error.message.includes("timed out")) {
        throw new Error("Git connection timed out. Check your network connection and try again.");
      } else {
        throw new Error(`Failed to clone Git repository: ${error.message}`);
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
      // Create the branch in the specified session's repo
      await execAsync(`git -C ${workdir} checkout -b ${branch}`);

      return {
        workdir,
        branch,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to create branch in Git repository: ${error.message}`);
    }
  }

  /**
   * Get repository status
   * @param session Session identifier
   * @returns Repository status information
   */
  async getStatus(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);

    try {
      // Get current branch
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

      // Check for unstaged changes
      const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
      const dirty = statusOutput.trim().length > 0;

      // Get remotes
      const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote`);
      const remotes = remoteOutput.trim().split("\n").filter(Boolean);

      return {
        branch,
        ahead,
        behind,
        dirty,
        remotes,
        // Include any additional information as needed
        workdir,
        defaultBranch: this.defaultBranch,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`Failed to get Git repository status: ${error.message}`);
    }
  }

  /**
   * Get the repository path for a session
   * @param session Session identifier
   * @returns Full path to the repository
   */
  async getPath(session: string): Promise<string> {
    return this.getSessionWorkdir(session);
  }

  /**
   * Push changes to remote repository
   * @returns Result of the push operation
   */
  async push(): Promise<Result> {
    try {
      // Implementation of git push
      // For a real implementation, you would need:
      // - Get the current branch
      // - Push to the remote
      // - Handle authentication and errors
      // This is a placeholder
      return {
        success: false,
        message: "Push operation not fully implemented for Remote Git backend yet",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to push to Git repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Pull changes from remote repository
   * @returns Result of the pull operation
   */
  async pull(): Promise<Result> {
    try {
      // Implementation of git pull
      // For a real implementation, you would need:
      // - Pull from the remote
      // - Handle merge conflicts
      // - Handle authentication and errors
      // This is a placeholder
      return {
        success: false,
        message: "Pull operation not fully implemented for Remote Git backend yet",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to pull from Git repository: ${error.message}`,
        error,
      };
    }
  }

  /**
   * Validate the repository configuration
   * @returns Promise that resolves with result if the repository is valid
   */
  async validate(): Promise<Result> {
    try {
      // Basic validation - check if URL looks like a git repository
      if (!this.repoUrl) {
        return {
          success: false,
          message: "Repository URL is required for Remote Git backend",
        };
      }

      // Check if the URL has a git protocol, or ends with .git
      const isGitUrl =
        this.repoUrl.startsWith("git@") ||
        this.repoUrl.startsWith("git://") ||
        this.repoUrl.startsWith("http://") ||
        this.repoUrl.startsWith("https://") ||
        this.repoUrl.endsWith(".git");

      if (!isGitUrl) {
        return {
          success: false,
          message: `URL "${this.repoUrl}" doesn't appear to be a valid Git repository URL`,
        };
      }

      // For a comprehensive check, you could try to connect to the repository
      // but that would slow down validation and may trigger authentication prompts
      // This is a basic check only

      return {
        success: true,
        message: "Git repository URL validated successfully",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to validate Git repository: ${error.message}`,
        error,
      };
    }
  }
}
