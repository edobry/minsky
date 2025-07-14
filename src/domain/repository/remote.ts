import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index";

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
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private readonly defaultBranch?: string;
  private sessionDb: SessionProviderInterface;

  /**
   * Create a new RemoteGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");

    // Extract configuration options
    this.repoUrl = (config as unknown).repoUrl;
    this.defaultBranch = (config as unknown).branch;

    if (!this.repoUrl) {
      throw new Error("Repository URL is required for Remote Git backend");
    }

    this.repoName = normalizeRepositoryURI(this.repoUrl);
    this.sessionDb = createSessionProvider();
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
    return join(this.baseDir, "sessions", session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    const sessionsDir = join(this.baseDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));

      // Provide more informative error messages for common Git issues
      if ((normalizedError?.message as unknown).includes("Authentication failed")) {
        throw new Error(`
🔐 Git Authentication Failed

Unable to authenticate with the Git repository.

💡 Quick fixes:
   • Verify you have access to this repository: ${this.repoUrl}
   • Check your Git credentials are configured
   • Ensure SSH keys or tokens are set up for your Git provider

Repository: ${this.repoUrl}
`);
      } else if (
        (normalizedError?.message as unknown).includes("not found") ||
        (normalizedError?.message as unknown).includes("does not exist")
      ) {
        throw new Error(`Git repository not found: ${this.repoUrl}. Check the URL.`);
      } else if ((normalizedError?.message as unknown).includes("timed out")) {
        throw new Error("Git connection timed out. Check your network connection and try again.");
      } else {
        throw new Error(`Failed to clone Git repository: ${(normalizedError as unknown).message}`);
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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to create branch in Git repository: ${(normalizedError as unknown).message}`);
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
        const counts = (revListOutput.trim() as unknown).split(/\s+/);
        if (counts && counts.length === 2) {
          behind = parseInt(counts[0] || "0", 10);
          ahead = parseInt(counts[1] || "0", 10);
        }
      } catch (error) {
        // If no upstream branch is set, this will fail - that's okay
      }

      // Check for unstaged changes
      const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
      const dirty = statusOutput.trim().length > 0;

      // Get remotes
      const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote`);
      const remotes = (remoteOutput.trim() as unknown).split("\n").filter(Boolean);

      return {
        branch,
        ahead,
        behind,
        dirty,
        remotes,
        defaultBranch: this.defaultBranch,
        clean: !dirty,
        changes: [],
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to get Git repository status: ${(normalizedError as unknown).message}`);
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
        (this.repoUrl as unknown).startsWith("git@") ||
        (this.repoUrl as unknown).startsWith("git://") ||
        (this.repoUrl as unknown).startsWith("http://") ||
        (this.repoUrl as unknown).startsWith("https://") ||
        (this.repoUrl as unknown).endsWith(".git");

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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to validate Git repository: ${(normalizedError as unknown).message}`,
        error: normalizedError,
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
      const sessions = await (this.sessionDb as unknown).listSessions();
      const currentSessions = sessions.filter((s) => (s as unknown).repoUrl === this.repoUrl);

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
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error as any));
          if ((normalizedError?.message as any).includes("Authentication failed")) {
            return {
              success: false,
              message: "Git authentication failed. Check your credentials or SSH key.",
              error: error instanceof Error ? error : new Error(String(error)),
            };
          } else if ((error as any).message.includes("[rejected]")) {
            return {
              success: false,
              message: "Push rejected. Try pulling changes first or use force push if appropriate.",
              error: error instanceof Error ? error : new Error(String(error)),
            };
          } else {
            return {
              success: false,
              message: `Failed to push to remote repository: ${(error as any).message}`,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        }
      }

      return {
        success: true,
        message: "Successfully pushed changes to remote repository",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to push to remote repository: ${normalizedError.message}`,
        error: normalizedError,
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

      const sessions = await (this.sessionDb as unknown).listSessions();
      const currentSessions = sessions.filter((s) => (s as unknown).repoUrl === this.repoUrl);

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
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error as any));
          if ((normalizedError?.message as any).includes("Authentication failed")) {
            return {
              success: false,
              message: "Git authentication failed. Check your credentials or SSH key.",
              error: error instanceof Error ? error : new Error(String(error)),
            };
          } else if ((error as any).message.includes("conflict")) {
            return {
              success: false,
              message: "Pull failed due to conflicts. Resolve conflicts manually.",
              error: error instanceof Error ? error : new Error(String(error)),
            };
          } else {
            return {
              success: false,
              message: `Failed to pull from remote repository: ${(error as any).message}`,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        }
      }

      return {
        success: true,
        message: "Successfully pulled changes from remote repository",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to pull from remote repository: ${normalizedError.message}`,
        error: normalizedError,
      };
    }
  }
}
