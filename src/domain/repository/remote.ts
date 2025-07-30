import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import {
  execGitWithTimeout,
  gitPushWithTimeout,
  gitPullWithTimeout,
  type GitExecOptions,
} from "../../utils/git-exec";
import { normalizeRepoName } from "../repo-utils";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type { RepositoryStatus } from "../repository";
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
  private sessionDb: SessionProviderInterface;

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
          await gitPushWithTimeout("origin", branch, { workdir });
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
   * @returns Result of the pull operation
   */
  async pull(): Promise<Result> {
    // TODO: Implement remote git pull logic
    return { success: false, message: "Not implemented" };
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
      const record = await this.sessionDb.getSession(session);
      if (!record) {
        throw new MinskyError(`Session '${session}' not found in database`);
      }
      workdir = this.getSessionWorkdir(session);
    } else {
      // Use current working directory
      workdir = process.cwd();
    }

    // Generate PR branch name from title
    const prBranchName = this.titleToBranchName(title);
    const prBranch = `pr/${prBranchName}`;

    try {
      // Ensure we're on the source branch
      await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });

      // Create and checkout the PR branch
      try {
        await execGitWithTimeout("branch", `branch ${prBranch}`, { workdir, timeout: 30000 });
      } catch (err) {
        // Branch might already exist, try to delete and recreate
        try {
          await execGitWithTimeout("branch", `branch -D ${prBranch}`, { workdir, timeout: 30000 });
          await execGitWithTimeout("branch", `branch ${prBranch}`, { workdir, timeout: 30000 });
        } catch (deleteErr) {
          throw new MinskyError(`Failed to create PR branch: ${getErrorMessage(err as any)}`);
        }
      }

      // Switch to PR branch
      await execGitWithTimeout("switch", `switch ${prBranch}`, { workdir, timeout: 30000 });

      // Create commit message for merge commit
      let commitMessage = title;
      if (body) {
        commitMessage += `\n\n${body}`;
      }

      // Merge source branch INTO PR branch with --no-ff (prepared merge commit)
      const escapedCommitMessage = commitMessage.replace(/"/g, '\\"');
      await execGitWithTimeout(
        "merge",
        `merge --no-ff ${sourceBranch} -m "${escapedCommitMessage}"`,
        { workdir, timeout: 180000 }
      );

      // Push the PR branch to remote
      await execGitWithTimeout("push", `push origin ${prBranch} --force`, {
        workdir,
        timeout: 30000,
      });

      // Switch back to source branch
      await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });

      return {
        number: prBranch, // Use branch name as identifier for remote repos
        url: prBranch, // Use branch name as URL for remote repos
        state: "open",
        metadata: {
          prBranch,
          baseBranch,
          sourceBranch,
          title,
          body,
          workdir,
        },
      };
    } catch (error) {
      // Clean up on error - try to switch back to source branch
      try {
        await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });
      } catch (cleanupErr) {
        log.warn("Failed to switch back to source branch after error", { cleanupErr });
      }

      throw new MinskyError(`Failed to create pull request: ${getErrorMessage(error as any)}`);
    }
  }

  /**
   * Merge a pull request using the prepared merge commit workflow
   * This merges the PR branch into the base branch
   */
  async mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo> {
    let workdir: string;
    const prBranch = typeof prIdentifier === "string" ? prIdentifier : `pr/${prIdentifier}`;

    // Determine working directory
    if (session) {
      const record = await this.sessionDb.getSession(session);
      if (!record) {
        throw new MinskyError(`Session '${session}' not found in database`);
      }
      workdir = this.getSessionWorkdir(session);
    } else {
      workdir = process.cwd();
    }

    try {
      // Determine base branch (default to main if not specified)
      const baseBranch = "main"; // Could be parameterized later

      // Switch to base branch
      await execGitWithTimeout("switch", `switch ${baseBranch}`, { workdir, timeout: 30000 });

      // Pull latest changes
      await execGitWithTimeout("pull", `pull origin ${baseBranch}`, { workdir, timeout: 60000 });

      // Merge the PR branch (this should be a fast-forward since PR branch has the prepared merge commit)
      await execGitWithTimeout("merge", `merge --no-ff ${prBranch}`, { workdir, timeout: 180000 });

      // Get merge information
      const commitHash = (
        await execGitWithTimeout("rev-parse", "rev-parse HEAD", { workdir, timeout: 10000 })
      ).stdout.trim();
      const mergeDate = new Date().toISOString();
      const mergedBy = (
        await execGitWithTimeout("config", "config user.name", { workdir, timeout: 10000 })
      ).stdout.trim();

      // Push the merge to remote
      await execGitWithTimeout("push", `push origin ${baseBranch}`, { workdir, timeout: 60000 });

      // Delete the PR branch from remote
      try {
        await execGitWithTimeout("push", `push origin --delete ${prBranch}`, {
          workdir,
          timeout: 30000,
        });
      } catch (deleteErr) {
        log.warn(`Failed to delete remote PR branch ${prBranch}`, {
          error: getErrorMessage(deleteErr),
        });
      }

      // Delete the local PR branch
      try {
        await execGitWithTimeout("branch", `branch -D ${prBranch}`, { workdir, timeout: 30000 });
      } catch (deleteErr) {
        log.warn(`Failed to delete local PR branch ${prBranch}`, {
          error: getErrorMessage(deleteErr),
        });
      }

      return {
        commitHash,
        mergeDate,
        mergedBy,
        metadata: {
          prBranch,
          baseBranch,
          workdir,
        },
      };
    } catch (error) {
      throw new MinskyError(`Failed to merge pull request: ${getErrorMessage(error as any)}`);
    }
  }

  /**
   * Convert a PR title to a branch name
   * e.g. "feat: add new feature" -> "feat-add-new-feature"
   */
  private titleToBranchName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
      .replace(/[^\w-]/g, "")
      .replace(/--+/g, "-")
      .replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }
}
