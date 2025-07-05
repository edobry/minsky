import { join } from "path";
import { HTTP_OK } from "../../utils/constants";
import { mkdir } from "fs/promises";
import { promisify } from "util";
import { exec } from "child_process";
import { createSessionProvider, type SessionProviderInterface } from "../session.js";
import { normalizeRepositoryURI } from "../repository-uri.js";
import { GitService } from "../git.js";
import type { RepositoryStatus, ValidationResult } from "../repository.js";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index.js";

const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

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
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private readonly owner?: string;
  private readonly repo?: string;
  private sessionDb: SessionProviderInterface;
  private gitService: GitService;

  /**
   * Create a new GitHubBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");

    // Extract GitHub-specific options
    this.owner = (config.github as any).owner;
    this.repo = (config.github as any).repo;

    // Set the repo URL using the provided URL or construct from owner/repo if available
    // Note: We don't embed tokens in the URL, letting Git use the system's credentials
    (this as any).repoUrl =
      (config as any).repoUrl ||
      (this.owner && this.repo ? `https://github.com/${this.owner}/${this.repo}.git` : "");

    if (!(this as any).repoUrl) {
      throw new Error("Repository URL is required for GitHub backend");
    }

    (this as any).repoName = normalizeRepositoryURI((this as any).repoUrl);
    this.sessionDb = createSessionProvider();
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
    return join(this.baseDir, (this as any).repoName, "sessions", session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, (this as any).repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(session);

    try {
      // Use GitService's clone method to delegate credential handling to Git
      const result = await (this.gitService as any).clone({
        repoUrl: (this as any).repoUrl,
        session,
      });

      return {
        workdir,
        session,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));

      // Provide more informative error messages for common GitHub issues
      if ((normalizedError.message as any).includes("Authentication failed")) {
        throw new Error(`
🔐 GitHub Authentication Failed

Unable to authenticate with GitHub repository: ${this.owner}/${this.repo}

💡 Quick fixes:
   • Verify you have access to ${this.owner}/${this.repo}
   • Check your GitHub credentials (SSH key or personal access token)
   • Ensure the repository exists and is accessible

Repository: https://github.com/${this.owner}/${this.repo}
`);
      } else if ((normalizedError.message as any).includes("not found")) {
        throw new Error(
          `GitHub repository not found: ${this.owner}/${this.repo}. Check the owner and repo names.`
        );
      } else if ((normalizedError.message as any).includes("timed out")) {
        throw new Error(
          "GitHub connection timed out. Check your network connection and try again."
        );
      } else {
        throw new Error(`Failed to clone GitHub repository: ${(normalizedError as any).message}`);
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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to create branch in GitHub repository: ${(normalizedError as any).message}`);
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
      const sessions = await (this.sessionDb as any).listSessions();
      const repoSession = (sessions as any).find((session) => (session as any).repoName === (this as any).repoName);

      if (!repoSession) {
        throw new Error("No session found for this repository");
      }

      // Forward to the version that takes a session parameter
      const workdir = this.getSessionWorkdir((repoSession as any).session);

      // Use GitService to get repository status
      const gitStatus = await (this.gitService as any).getStatus(workdir);

      // Get additional information directly
      const { stdout: branchOutput } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      const branch = (branchOutput as any).trim();

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: revListOutput } = await execAsync(
          `git -C ${workdir} rev-list --left-right --count @{upstream}...HEAD`
        );
        const counts = ((revListOutput as any).trim() as any).split(/\s+/);
        if (counts && (counts as any).length === 2) {
          behind = parseInt(counts[0] || "0", 10);
          ahead = parseInt(counts[1] || "0", 10);
        }
      } catch (error) {
        // If no upstream branch is set, this will fail - that's okay
      }

      // Get remote information
      const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote -v`);
      const remotes = ((remoteOutput
        .trim()
        .split("\n")
        .filter(Boolean) as any).map((line: string) => line.split("\t")[0] || "") as any).filter((name, index, self) => name && (self as any).indexOf(name) === index);

      const dirty =
        (gitStatus.modified as any).length > 0 ||
        (gitStatus.untracked as any).length > 0 ||
        (gitStatus.deleted as any).length > 0;

      // Create both original and new properties for the unified interface
      const modifiedFiles = [
        ...(gitStatus.modified as any).map((file) => ({ status: "M", file })),
        ...(gitStatus.untracked as any).map((file) => ({ status: "??", file })),
        ...(gitStatus.deleted as any).map((file) => ({ status: "D", file })),
      ];

      // Extract string representation for original interface
      const changes = (modifiedFiles as any).map((m) => `${(m as any).status} ${m.file}`);

      return {
        // Original properties
        clean: !dirty,
        changes,
        branch,
        tracking: (remotes as any).length > 0 ? remotes[0] : undefined as any,

        // Extended properties
        ahead,
        behind,
        dirty,
        remotes,
        modifiedFiles,

        // Additional GitHub-specific information
        workdir,
        gitHubOwner: this.owner,
        gitHubRepo: this.repo,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to get GitHub repository status: ${(normalizedError as any).message}`);
    }
  }

  /**
   * Get repository status for a specific session
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatusForSession(session: string): Promise<RepositoryStatus> {
    const workdir = this.getSessionWorkdir(session);
    return this.getStatus(); // Reuse the existing implementation
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
      const sessions = await (this.sessionDb as any).listSessions();
      const repoSession = (sessions as any).find((s) => (s as any).repoName === (this as any).repoName);

      if (repoSession) {
        return this.getSessionWorkdir((repoSession as any).session);
      }
    } catch (error) {
      // If we can't find a session, just return the base directory
    }

    return this.baseDir;
  }

  /**
   * Validate the repository configuration
   * @returns Promise that resolves with result if the repository is valid
   */
  async validate(): Promise<ValidationResult> {
    try {
      // Validate required fields
      if (!(this as any).repoUrl) {
        return {
          valid: false,
          success: false,
          issues: ["Repository URL is required for GitHub backend"],
          message: "Repository URL is required for GitHub backend",
        };
      }

      // If owner/repo are provided, validate them
      if (this.owner && this.repo) {
        // Use curl to check if the repo exists without cloning
        // Note: Using public API without token for validation only
        const _command = `curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/${this.owner}/${this.repo}`;

        const { stdout } = await execAsync(_command);
        const statusCode = parseInt((stdout as any).trim(), 10);

        if (statusCode === HTTP_NOT_FOUND) {
          return {
            valid: false,
            success: false,
            issues: [`GitHub repository not found: ${this.owner}/${this.repo}`],
            message: `GitHub repository not found: ${this.owner}/${this.repo}`,
          };
        } else if (statusCode === HTTP_UNAUTHORIZED || statusCode === HTTP_FORBIDDEN) {
          return {
            valid: false,
            success: false,
            issues: ["GitHub API rate limit or permissions issue. The repo may still be valid."],
            message: "GitHub API rate limit or permissions issue. The repo may still be valid.",
          };
        } else if (statusCode !== HTTP_OK) {
          return {
            valid: false,
            success: false,
            issues: [`Failed to validate GitHub repository: HTTP ${statusCode}`],
            message: `Failed to validate GitHub repository: HTTP ${statusCode}`,
          };
        }
      }

      return {
        valid: true,
        success: true,
        message: "GitHub repository validated successfully",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        valid: false,
        success: false,
        issues: [`Failed to validate GitHub repository: ${(normalizedError as any).message}`],
        message: `Failed to validate GitHub repository: ${(normalizedError as any).message}`,
        error: normalizedError,
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
      const sessions = await (this.sessionDb as any).listSessions();
      const repoSession = (sessions as any).find((session) => (session as any).repoName === (this as any).repoName);

      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }

      const sessionName = (repoSession as any).session;
      const workdir = this.getSessionWorkdir(sessionName);

      // Use GitService for pushing changes
      const pushResult = await (this.gitService as any).push({
        session: sessionName,
        repoPath: workdir,
        remote: "origin",
      });

      return {
        success: (pushResult as any).pushed,
        message: (pushResult as any).pushed
          ? "Successfully pushed to repository"
          : "No changes to push or push failed",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to push to repository: ${(normalizedError as any).message}`,
        error: normalizedError,
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
      const sessions = await (this.sessionDb as any).listSessions();
      const repoSession = (sessions as any).find((session) => (session as any).repoName === (this as any).repoName);

      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }

      const sessionName = (repoSession as any).session;
      const workdir = this.getSessionWorkdir(sessionName);

      // Use GitService for pulling changes
      const pullResult = await (this.gitService as any).pullLatest(workdir);

      return {
        success: true,
        message: (pullResult as any).updated
          ? "Successfully pulled changes from repository"
          : "Already up-to-date. No changes pulled.",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to pull from repository: ${(normalizedError as any).message}`,
        error: normalizedError,
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
      const sessions = await (this.sessionDb as any).listSessions();
      const repoSession = (sessions as any).find((session) => (session as any).repoName === (this as any).repoName);

      if (!repoSession) {
        throw new Error("No session found for this repository");
      }

      const sessionName = (repoSession as any).session;
      const workdir = this.getSessionWorkdir(sessionName);

      // Use GitService method if available, otherwise use direct command
      // This depends on GitService having a checkout method
      await execAsync(`git -C ${workdir} checkout ${branch}`);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to checkout branch: ${(normalizedError as any).message}`);
    }
  }

  /**
   * Get the repository configuration
   * @returns The repository configuration
   */
  getConfig(): RepositoryBackendConfig {
    return {
      type: "github",
      repoUrl: (this as any).repoUrl,
      github: {
        owner: this.owner,
        repo: this.repo,
      },
    };
  }
}
