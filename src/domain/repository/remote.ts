import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { SessionDB } from "../session.js";
import { normalizeRepositoryURI } from "../repository-uri.js";
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

    this.repoName = normalizeRepositoryURI(this.repoUrl);
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
        workdir,
        defaultBranch: this.defaultBranch,
        clean: !dirty,
        changes: [],
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

  /**
   * Push changes to remote repository
   * @returns Result of the push operation
   */
  async push(): Promise<Result> {
    try {
      // Validate repository configuration
      const validation = await this.validate();
      if (!validation.success) {
        return validation;
      }

      // Implementation of git push for remote repositories
      // 1. Get the current session path
      // 2. Determine the current branch
      // 3. Push to remote repository

      // This is a more complete implementation that would work with actual repositories
      const sessions = await this.sessionDb.listSessions();
      const currentSessions = sessions.filter((s) => s.repoUrl === this.repoUrl);

      if (currentSessions.length === 0) {
        return {
          success: false,
          message: "No active sessions found for this repository",
        };
      }

      // For each session with this repository, push changes
      for (const session of currentSessions) {
        const workdir = this.getSessionWorkdir(session.session);

        try {
          // Determine current branch
          const { stdout: branchOutput } = await execAsync(
            `git -C ${workdir} rev-parse --abbrev-ref HEAD`
          );
          const branch = branchOutput.trim();

          // Push to remote
          await execAsync(`git -C ${workdir} push origin ${branch}`);
        } catch (pushError) {
          const error = pushError instanceof Error ? pushError : new Error(String(pushError));
          if (error.message.includes("Authentication failed")) {
            return {
              success: false,
              message: "Git authentication failed. Check your credentials or SSH key.",
              error,
            };
          } else if (error.message.includes("[rejected]")) {
            return {
              success: false,
              message: "Push rejected. Try pulling changes first or use force push if appropriate.",
              error,
            };
          } else {
            return {
              success: false,
              message: `Failed to push to remote repository: ${error.message}`,
              error,
            };
          }
        }
      }

      return {
        success: true,
        message: "Successfully pushed changes to remote repository",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to push to remote repository: ${error.message}`,
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
      // Validate repository configuration
      const validation = await this.validate();
      if (!validation.success) {
        return validation;
      }

      // Implementation of git pull for remote repositories
      // 1. Get the current session path
      // 2. Determine the current branch
      // 3. Pull from remote repository

      const sessions = await this.sessionDb.listSessions();
      const currentSessions = sessions.filter((s) => s.repoUrl === this.repoUrl);

      if (currentSessions.length === 0) {
        return {
          success: false,
          message: "No active sessions found for this repository",
        };
      }

      // For each session with this repository, pull changes
      for (const session of currentSessions) {
        const workdir = this.getSessionWorkdir(session.session);

        try {
          // Determine current branch
          const { stdout: branchOutput } = await execAsync(
            `git -C ${workdir} rev-parse --abbrev-ref HEAD`
          );
          const branch = branchOutput.trim();

          // Pull from remote
          await execAsync(`git -C ${workdir} pull origin ${branch}`);
        } catch (pullError) {
          const error = pullError instanceof Error ? pullError : new Error(String(pullError));
          if (error.message.includes("Authentication failed")) {
            return {
              success: false,
              message: "Git authentication failed. Check your credentials or SSH key.",
              error,
            };
          } else if (error.message.includes("conflict")) {
            return {
              success: false,
              message: "Pull failed due to conflicts. Resolve conflicts manually.",
              error,
            };
          } else {
            return {
              success: false,
              message: `Failed to pull from remote repository: ${error.message}`,
              error,
            };
          }
        }
      }

      return {
        success: true,
        message: "Successfully pulled changes from remote repository",
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        success: false,
        message: `Failed to pull from remote repository: ${error.message}`,
        error,
      };
    }
  }
}
