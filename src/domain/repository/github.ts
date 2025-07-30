import { join } from "path";
import { HTTP_OK } from "../../utils/constants";
import { mkdir } from "fs/promises";
import { promisify } from "util";
import { exec } from "child_process";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import { GitService } from "../git";
import { execGitWithTimeout } from "../../utils/git-exec";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { Octokit } from "@octokit/rest";
import type { RepositoryStatus, ValidationResult } from "../repository";
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

const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

// Define a global for process to avoid linting errors
declare const process: {
  env: {
    XDG_STATE_HOME?: string;
    HOME?: string;
    GITHUB_TOKEN?: string;
    GH_TOKEN?: string;
    [key: string]: string | undefined;
  };
  cwd(): string;
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
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");

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

    this.repoName = normalizeRepositoryURI(this.repoUrl);
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
        workdir,
        session,
      });

      return {
        workdir,
        session,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));

      // Provide more informative error messages for common GitHub issues
      if (normalizedError.message.includes("Authentication failed")) {
        throw new Error(`
🔐 GitHub Authentication Failed

Unable to authenticate with GitHub repository: ${this.owner}/${this.repo}

💡 Quick fixes:
   • Verify you have access to ${this.owner}/${this.repo}
   • Check your GitHub credentials (SSH key or personal access token)
   • Ensure the repository exists and is accessible

Repository: https://github.com/${this.owner}/${this.repo}
`);
      } else if (normalizedError.message.includes("not found")) {
        throw new Error(
          `GitHub repository not found: ${this.owner}/${this.repo}. Check the owner and repo names.`
        );
      } else if (normalizedError.message.includes("timed out")) {
        throw new Error(
          "GitHub connection timed out. Check your network connection and try again."
        );
      } else {
        throw new Error(`Failed to clone GitHub repository: ${normalizedError.message}`);
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
      await execGitWithTimeout("github-create-branch", `checkout -b ${branch}`, { workdir });

      return {
        workdir,
        branch,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to create branch in GitHub repository: ${normalizedError.message}`);
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
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

      if (!repoSession) {
        throw new Error("No session found for this repository");
      }

      // Forward to the version that takes a session parameter
      const workdir = this.getSessionWorkdir(repoSession.session);

      // Use GitService to get repository status
      const gitStatus = await this.gitService.getStatus(workdir);

      // Get additional information directly
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

      // Get remote information
      const { stdout: remoteOutput } = await execGitWithTimeout("github-remote-list", "remote -v", {
        workdir,
      });
      const remotes = remoteOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => line.split("\t")[0] || "")
        .filter((name, index, self) => name && self.indexOf(name) === index);

      const dirty =
        gitStatus.modified.length > 0 ||
        gitStatus.untracked.length > 0 ||
        gitStatus.deleted.length > 0;

      // Create both original and new properties for the unified interface
      const modifiedFiles = [
        ...gitStatus.modified.map((file) => ({ status: "M", file })),
        ...gitStatus.untracked.map((file) => ({ status: "??", file })),
        ...gitStatus.deleted.map((file) => ({ status: "D", file })),
      ];

      // Extract string representation for original interface
      const changes = modifiedFiles.map((m) => `${m.status} ${m.file}`);

      return {
        // Original properties
        clean: !dirty,
        changes,
        branch,
        tracking: remotes.length > 0 ? remotes[0] : undefined,

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
      throw new Error(`Failed to get GitHub repository status: ${normalizedError.message}`);
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
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find((s) => s.repoName === this.repoName);

      if (repoSession) {
        return this.getSessionWorkdir(repoSession.session);
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
      if (!this.repoUrl) {
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
        const statusCode = parseInt(stdout.trim(), 10);

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
        issues: [`Failed to validate GitHub repository: ${normalizedError.message}`],
        message: `Failed to validate GitHub repository: ${normalizedError.message}`,
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
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

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
        remote: "origin",
      });

      return {
        success: pushResult.pushed,
        message: pushResult.pushed
          ? "Successfully pushed to repository"
          : "No changes to push or push failed",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to push to repository: ${normalizedError.message}`,
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
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return {
        success: false,
        message: `Failed to pull from repository: ${normalizedError.message}`,
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
      const sessions = await this.sessionDb.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

      if (!repoSession) {
        throw new Error("No session found for this repository");
      }

      const sessionName = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionName);

      // Use GitService method if available, otherwise use direct command
      // This depends on GitService having a checkout method
      await execGitWithTimeout("github-checkout-branch", `checkout ${branch}`, { workdir });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      throw new Error(`Failed to checkout branch: ${normalizedError.message}`);
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
        repo: this.repo,
      },
    };
  }

  /**
   * Create a GitHub pull request using the GitHub API
   * This creates a real GitHub PR from the source branch to the base branch
   */
  async createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string = "main",
    session?: string
  ): Promise<PRInfo> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured to create pull requests");
    }

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

    try {
      // First, ensure the source branch is pushed to the remote
      await execGitWithTimeout("push", `push origin ${sourceBranch}`, {
        workdir,
        timeout: 60000,
      });

      // Get GitHub token from environment
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!githubToken) {
        throw new MinskyError(
          "GitHub token not found. Set GITHUB_TOKEN or GH_TOKEN environment variable"
        );
      }

      // Create Octokit instance
      const octokit = new Octokit({
        auth: githubToken,
      });

      // Create the pull request
      const prResponse = await octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        head: sourceBranch,
        base: baseBranch,
      });

      const pr = prResponse.data;

      return {
        number: pr.number,
        url: pr.html_url,
        state: pr.state as "open" | "closed" | "merged",
        metadata: {
          id: pr.id,
          node_id: pr.node_id,
          head_sha: pr.head.sha,
          base_ref: pr.base.ref,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          owner: this.owner,
          repo: this.repo,
          workdir,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("422")) {
        // Check if it's a "No commits between" error
        if (error.message.includes("No commits between")) {
          throw new MinskyError(
            `No differences found between ${sourceBranch} and ${baseBranch}. Make sure your changes are committed and pushed.`
          );
        }
        // Check if PR already exists
        if (error.message.includes("pull request already exists")) {
          throw new MinskyError(
            `A pull request from ${sourceBranch} to ${baseBranch} already exists.`
          );
        }
      }

      throw new MinskyError(
        `Failed to create GitHub pull request: ${getErrorMessage(error as any)}`
      );
    }
  }

  /**
   * Merge a GitHub pull request using the GitHub API
   * This merges the PR using GitHub's default merge strategy
   */
  async mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured to merge pull requests");
    }

    const prNumber = typeof prIdentifier === "string" ? parseInt(prIdentifier, 10) : prIdentifier;
    if (isNaN(prNumber)) {
      throw new MinskyError(`Invalid PR number: ${prIdentifier}`);
    }

    try {
      // Get GitHub token from environment
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!githubToken) {
        throw new MinskyError(
          "GitHub token not found. Set GITHUB_TOKEN or GH_TOKEN environment variable"
        );
      }

      // Create Octokit instance
      const octokit = new Octokit({
        auth: githubToken,
      });

      // Get the PR details first
      const prResponse = await octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const pr = prResponse.data;

      if (pr.state !== "open") {
        throw new MinskyError(`Pull request #${prNumber} is not open (current state: ${pr.state})`);
      }

      if (!pr.mergeable) {
        throw new MinskyError(
          `Pull request #${prNumber} has merge conflicts that must be resolved first`
        );
      }

      // Merge the pull request using GitHub's default merge strategy
      const mergeResponse = await octokit.rest.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        commit_title: `Merge pull request #${prNumber} from ${pr.head.ref}`,
      });

      const merge = mergeResponse.data;

      return {
        commitHash: merge.sha,
        mergeDate: new Date().toISOString(),
        mergedBy: pr.user?.login || "unknown",
        metadata: {
          pr_number: prNumber,
          pr_url: pr.html_url,
          merge_method: "merge", // GitHub default
          merged_at: new Date().toISOString(),
          owner: this.owner,
          repo: this.repo,
          head_ref: pr.head.ref,
          base_ref: pr.base.ref,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("405")) {
        throw new MinskyError(
          `Pull request #${prNumber} cannot be merged. It may have conflicts or branch protection rules preventing the merge.`
        );
      }

      throw new MinskyError(
        `Failed to merge GitHub pull request: ${getErrorMessage(error as any)}`
      );
    }
  }
}
