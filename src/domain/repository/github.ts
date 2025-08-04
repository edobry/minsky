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
  private sessionDB: SessionProviderInterface;
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
    this.sessionDB = createSessionProvider();
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
      const sessions = await this.sessionDB.listSessions();
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
      const sessions = await this.sessionDB.listSessions();
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
      const sessions = await this.sessionDB.listSessions();
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
      const sessions = await this.sessionDB.listSessions();
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
      const sessions = await this.sessionDB.listSessions();
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
      const record = await this.sessionDB.getSession(session);
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

      // Get GitHub token from configuration system
      const { getConfiguration } = require("../configuration/index");
      const config = getConfiguration();
      const githubToken = config.github.token;
      if (!githubToken) {
        // Get environment variable names that map to github.token
        const githubTokenEnvVars = Object.entries(environmentMappings)
          .filter(([_, configPath]) => configPath === "github.token")
          .map(([envVar, _]) => envVar);

        const configFile = `${getUserConfigDir()}/config.yaml`;
        const primaryEnvVar = githubTokenEnvVars[0] || "GITHUB_TOKEN";

        throw new MinskyError(
          `GitHub token not found. Set ${primaryEnvVar} environment variable or add token to ${configFile}`
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
      // Enhanced error handling for different types of GitHub API errors
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();

        // Authentication errors (401, 403)
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("bad credentials") ||
          errorMessage.includes("unauthorized")
        ) {
          throw new MinskyError(
            `🔐 GitHub Authentication Failed\n\n` +
              `Your GitHub token is invalid or expired.\n\n` +
              `💡 To fix this:\n` +
              `  1. Generate a new Personal Access Token at https://github.com/settings/tokens\n` +
              `  2. Set it as GITHUB_TOKEN or GH_TOKEN environment variable\n` +
              `  3. Ensure the token has 'repo' and 'pull_requests' permissions\n\n` +
              `Repository: ${this.owner}/${this.repo}`
          );
        }

        // Permission errors (403)
        if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
          throw new MinskyError(
            `🚫 GitHub Permission Denied\n\n` +
              `You don't have permission to create pull requests in ${this.owner}/${this.repo}.\n\n` +
              `💡 To fix this:\n` +
              `  • Ensure you have push access to the repository\n` +
              `  • Check if the repository exists and is public/accessible\n` +
              `  • Verify your GitHub token has sufficient permissions\n\n` +
              `Repository: https://github.com/${this.owner}/${this.repo}`
          );
        }

        // Repository not found (404)
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          throw new MinskyError(
            `📂 GitHub Repository Not Found\n\n` +
              `The repository ${this.owner}/${this.repo} was not found.\n\n` +
              `💡 To fix this:\n` +
              `  • Verify the repository name and owner are correct\n` +
              `  • Check if the repository is private and you have access\n` +
              `  • Ensure the repository exists at https://github.com/${this.owner}/${this.repo}`
          );
        }

        // Rate limiting (429)
        if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
          throw new MinskyError(
            `⏱️ GitHub Rate Limit Exceeded\n\n` +
              `You've hit GitHub's API rate limit.\n\n` +
              `💡 To fix this:\n` +
              `  • Wait a few minutes before trying again\n` +
              `  • Use a GitHub token for higher rate limits\n` +
              `  • Consider using GitHub Enterprise for unlimited API calls`
          );
        }

        // Network connectivity issues
        if (
          errorMessage.includes("network") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("enotfound")
        ) {
          throw new MinskyError(
            `🌐 Network Connection Error\n\n` +
              `Unable to connect to GitHub API.\n\n` +
              `💡 To fix this:\n` +
              `  • Check your internet connection\n` +
              `  • Verify GitHub is accessible (https://githubstatus.com)\n` +
              `  • Try again in a few moments\n\n` +
              `Error: ${error.message}`
          );
        }

        // Validation errors (422)
        if (errorMessage.includes("422")) {
          // Check if it's a "No commits between" error
          if (errorMessage.includes("no commits between") || errorMessage.includes("no changes")) {
            throw new MinskyError(
              `📝 No Changes to Create PR\n\n` +
                `No differences found between ${sourceBranch} and ${baseBranch}.\n\n` +
                `💡 To fix this:\n` +
                `  • Make sure your changes are committed to ${sourceBranch}\n` +
                `  • Push your branch: git push origin ${sourceBranch}\n` +
                `  • Verify you're on the correct branch: git branch`
            );
          }
          // Check if PR already exists
          if (
            errorMessage.includes("pull request already exists") ||
            errorMessage.includes("already exists")
          ) {
            throw new MinskyError(
              `🔄 Pull Request Already Exists\n\n` +
                `A pull request from ${sourceBranch} to ${baseBranch} already exists.\n\n` +
                `💡 Options:\n` +
                `  • Update the existing PR instead of creating a new one\n` +
                `  • Use a different branch name\n` +
                `  • Close the existing PR if it's no longer needed\n\n` +
                `Check: https://github.com/${this.owner}/${this.repo}/pulls`
            );
          }
        }
      }

      // Fallback for any other errors
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
      // Get GitHub token from configuration system
      const { getConfiguration } = require("../configuration/index");
      const config = getConfiguration();
      const githubToken = config.github.token;
      if (!githubToken) {
        // Get environment variable names that map to github.token
        const githubTokenEnvVars = Object.entries(environmentMappings)
          .filter(([_, configPath]) => configPath === "github.token")
          .map(([envVar, _]) => envVar);

        const configFile = `${getUserConfigDir()}/config.yaml`;
        const primaryEnvVar = githubTokenEnvVars[0] || "GITHUB_TOKEN";

        throw new MinskyError(
          `GitHub token not found. Set ${primaryEnvVar} environment variable or add token to ${configFile}`
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
      // Enhanced error handling for GitHub PR merge operations
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();

        // Authentication errors
        if (
          errorMessage.includes("401") ||
          errorMessage.includes("bad credentials") ||
          errorMessage.includes("unauthorized")
        ) {
          throw new MinskyError(
            `🔐 GitHub Authentication Failed\n\n` +
              `Your GitHub token is invalid or expired.\n\n` +
              `💡 To fix this:\n` +
              `  1. Generate a new Personal Access Token at https://github.com/settings/tokens\n` +
              `  2. Set it as GITHUB_TOKEN or GH_TOKEN environment variable\n` +
              `  3. Ensure the token has 'repo' and 'pull_requests' permissions`
          );
        }

        // Permission errors
        if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
          throw new MinskyError(
            `🚫 GitHub Permission Denied\n\n` +
              `You don't have permission to merge pull requests in ${this.owner}/${this.repo}.\n\n` +
              `💡 To fix this:\n` +
              `  • Ensure you have write access to the repository\n` +
              `  • Check if branch protection rules prevent merging\n` +
              `  • Verify your GitHub token has sufficient permissions`
          );
        }

        // PR not found (404)
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          throw new MinskyError(
            `📂 Pull Request Not Found\n\n` +
              `Pull request #${prNumber} was not found in ${this.owner}/${this.repo}.\n\n` +
              `💡 To fix this:\n` +
              `  • Verify the PR number is correct\n` +
              `  • Check if the PR was already merged or closed\n` +
              `  • Ensure the repository exists and is accessible\n\n` +
              `Check: https://github.com/${this.owner}/${this.repo}/pulls`
          );
        }

        // Merge conflicts or protection rules (405, 422)
        if (
          errorMessage.includes("405") ||
          errorMessage.includes("422") ||
          errorMessage.includes("merge conflicts")
        ) {
          throw new MinskyError(
            `🔀 Pull Request Cannot Be Merged\n\n` +
              `Pull request #${prNumber} cannot be merged automatically.\n\n` +
              `💡 Common causes:\n` +
              `  • Merge conflicts that need to be resolved\n` +
              `  • Branch protection rules requiring reviews\n` +
              `  • Required status checks not passing\n` +
              `  • PR is not in an open state\n\n` +
              `Visit the PR to resolve: https://github.com/${this.owner}/${this.repo}/pull/${prNumber}`
          );
        }

        // Rate limiting
        if (errorMessage.includes("429") || errorMessage.includes("rate limit")) {
          throw new MinskyError(
            `⏱️ GitHub Rate Limit Exceeded\n\n` +
              `You've hit GitHub's API rate limit.\n\n` +
              `💡 To fix this:\n` +
              `  • Wait a few minutes before trying again\n` +
              `  • Use a GitHub token for higher rate limits`
          );
        }

        // Network issues
        if (
          errorMessage.includes("network") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("enotfound")
        ) {
          throw new MinskyError(
            `🌐 Network Connection Error\n\n` +
              `Unable to connect to GitHub API.\n\n` +
              `💡 To fix this:\n` +
              `  • Check your internet connection\n` +
              `  • Verify GitHub is accessible (https://githubstatus.com)\n` +
              `  • Try again in a few moments`
          );
        }
      }

      // Fallback for any other errors
      throw new MinskyError(
        `Failed to merge GitHub pull request: ${getErrorMessage(error as any)}`
      );
    }
  }
}
