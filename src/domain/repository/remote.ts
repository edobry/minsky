import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import { execGitWithTimeout, gitCloneWithTimeout, type GitExecOptions } from "../../utils/git-exec";
import { normalizeRepoName } from "../repo-utils";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { RepositoryStatus } from "../repository";
import {
  createPreparedMergeCommitPR,
  mergePreparedMergeCommitPR,
  type PreparedMergeCommitOptions,
  type PreparedMergeCommitMergeOptions,
} from "../git/prepared-merge-commit-workflow";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
  PRInfo,
  MergeInfo,
} from "./index";

// Define a global for process to avoid linting errors
declare const process: {
  env: {
    XDG_STATE_HOME?: string;
    HOME?: string;
    [key: string]: string | undefined;
  };
  cwd(): string;
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
  private sessionDB: SessionProviderInterface;

  /**
   * Create a new RemoteGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");

    // Extract configuration options
    this.repoUrl = config.repoUrl;
    this.defaultBranch = config.branch;

    if (!this.repoUrl) {
      throw new Error("Repository URL is required for Remote Git backend");
    }

    this.repoName = normalizeRepositoryURI(this.repoUrl);
    this.sessionDB = createSessionProvider();
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
      if (normalizedError?.message.includes("Authentication failed")) {
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
        normalizedError?.message.includes("not found") ||
        normalizedError?.message.includes("does not exist")
      ) {
        throw new Error(`Git repository not found: ${this.repoUrl}. Check the URL.`);
      } else if (normalizedError?.message.includes("timed out")) {
        throw new Error("Git connection timed out. Check your network connection and try again.");
      } else {
        throw new Error(`Failed to clone Git repository: ${normalizedError.message}`);
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
      await execGitWithTimeout("remote-create-branch", `checkout -b ${branch}`, { workdir });

      return {
        workdir,
        branch,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to create branch in Git repository: ${normalizedError.message}`);
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
      } catch (error) {
        // If no upstream branch is set, this will fail - that's okay
      }

      // Check for unstaged changes
      const { stdout: statusOutput } = await execGitWithTimeout(
        "remote-status-check",
        "status --porcelain",
        { workdir }
      );
      const dirty = statusOutput.trim().length > 0;

      // Get remotes
      const { stdout: remoteOutput } = await execGitWithTimeout("remote-list", "remote", {
        workdir,
      });
      const remotes = remoteOutput.trim().split("\n").filter(Boolean);

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
      throw new Error(`Failed to get Git repository status: ${normalizedError.message}`);
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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to validate Git repository: ${normalizedError.message}`,
        error: normalizedError,
      };
    }
  }

  /**
   * Push changes to remote repository
   * @param branch Optional branch to push (defaults to current branch)
   * @returns Result of the push operation
   */
  async push(branch?: string): Promise<any> {
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
      const sessions = await this.sessionDB.listSessions();
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
          // Determine current branch or use provided branch
          let targetBranch = branch;
          if (!targetBranch) {
            const { stdout: branchOutput } = await execAsync(
              `git -C ${workdir} rev-parse --abbrev-ref HEAD`
            );
            targetBranch = branchOutput.trim();
          }

          // Push to remote
          await execGitWithTimeout("push", `push origin ${targetBranch}`, { workdir });
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error as any));
          if ((normalizedError?.message as any).includes("Authentication failed")) {
            return {
              success: false,
              error: new Error(
                "Authentication failed during push operation. Please check your credentials."
              ),
            };
          }
          throw normalizedError;
        }
      }

      return { success: true };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: new Error(`Failed to push changes: ${normalizedError.message}`),
      };
    }
  }

  /**
   * Pull changes from remote repository
   * @param branch Optional branch to pull (defaults to current branch)
   * @returns Result of the pull operation
   */
  async pull(branch?: string): Promise<any> {
    try {
      // Validate repository configuration
      const validation = await this.validate();
      if (!validation.success) {
        return validation;
      }

      // Get all sessions for this repository
      const sessions = await this.sessionDB.listSessions();
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
          // Determine current branch or use provided branch
          let targetBranch = branch;
          if (!targetBranch) {
            const { stdout: branchOutput } = await execAsync(
              `git -C ${workdir} rev-parse --abbrev-ref HEAD`
            );
            targetBranch = branchOutput.trim();
          }

          // Pull from remote
          await execGitWithTimeout("pull", `pull origin ${targetBranch}`, { workdir });
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error as any));
          if ((normalizedError?.message as any).includes("Authentication failed")) {
            return {
              success: false,
              error: new Error(
                "Authentication failed during pull operation. Please check your credentials."
              ),
            };
          }
          throw normalizedError;
        }
      }

      return { success: true, message: "Pull completed successfully" };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        error: new Error(`Failed to pull changes: ${normalizedError.message}`),
      };
    }
  }

  /**
   * Create a pull request using prepared merge commit workflow
   * This creates a PR branch with a merge commit prepared for approval
   */
  async createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string = "main",
    session?: string
  ): Promise<PRInfo> {
    let workdir: string;

    // Determine working directory
    if (session) {
      const record = await this.sessionDB.getSession(session);
      if (!record) {
        throw new MinskyError(`Session '${session}' not found in database`);
      }
      workdir = this.getSessionWorkdir(session);
    } else {
      // Use current working directory
      workdir = process.cwd();
    }

    const options: PreparedMergeCommitOptions = {
      title,
      body,
      sourceBranch,
      baseBranch,
      workdir,
      session,
    };

    return await createPreparedMergeCommitPR(options);
  }

  /**
   * Update an existing pull request (remote backend)
   * For remote repositories, we treat the PR as a branch update
   */
  async updatePullRequest(options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }): Promise<PRInfo> {
    // For remote repositories, updating a PR means updating the prepared merge commit
    // This might involve git operations and network calls, so we keep the existing workflow

    if (!options.session) {
      throw new MinskyError("Session is required for remote repository PR updates");
    }

    const sessionRecord = await this.sessionDB.getSession(options.session);
    if (!sessionRecord?.prBranch) {
      throw new MinskyError(`No PR found for session '${options.session}'`);
    }

    // For remote repos, we might need to recreate the prepared merge commit with new metadata
    // This involves network operations and may have conflicts, so we use the existing workflow
    const { sessionPr } = await import("../session/commands/pr-command");

    const result = await sessionPr(
      {
        sessionName: options.session,
        title: options.title,
        body: options.body,
        // For remote backend updates, we still need conflict checking
        skipConflictCheck: false,
        noStatusUpdate: true,
        autoResolveDeleteConflicts: false,
      },
      { interface: "cli" }
    );

    return {
      number: sessionRecord.prBranch || "unknown",
      url: sessionRecord.prBranch || this.repoUrl,
      state: "open",
      metadata: {
        backend: "remote",
        repoUrl: this.repoUrl,
        workdir: this.getSessionWorkdir(options.session),
      },
    };
  }

  /**
   * Merge a pull request using the prepared merge commit workflow
   * This merges the PR branch into the base branch
   */
  async mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo> {
    let workdir: string;

    // Determine working directory
    if (session) {
      const record = await this.sessionDB.getSession(session);
      if (!record) {
        throw new MinskyError(`Session '${session}' not found in database`);
      }
      // For remote repositories, we need to use the session workspace (local working copy)
      // since record.repoUrl is a remote URL that can't be used as a working directory
      workdir = this.getSessionWorkdir(session);
    } else {
      workdir = process.cwd();
    }

    const options: PreparedMergeCommitMergeOptions = {
      prIdentifier,
      workdir,
      session,
    };

    return await mergePreparedMergeCommitPR(options);
  }
}
