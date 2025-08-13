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
import { environmentMappings } from "../configuration/sources/environment";
import { getUserConfigDir } from "../configuration/sources/user";
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
import type { ApprovalInfo, ApprovalStatus } from "./approval-types";

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

    // Derive owner/repo from repoUrl when not explicitly provided
    if ((!this.owner || !this.repo) && this.repoUrl.includes("github.com")) {
      try {
        // SSH: git@github.com:owner/repo.git
        // HTTPS: https://github.com/owner/repo.git
        const sshMatch = this.repoUrl.match(/git@github\.com:([^\/]+)\/([^\.]+)/);
        const httpsMatch = this.repoUrl.match(/https:\/\/github\.com\/([^\/]+)\/([^\.]+)/);
        const match = sshMatch || httpsMatch;
        if (match && match[1] && match[2]) {
          this.owner = this.owner || match[1];
          this.repo = this.repo || match[2].replace(/\.git$/, "");
        }
      } catch (_err) {
        // Ignore parsing errors; explicit config may still provide these later
      }
    }
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
      const pullResult = await this.gitService.fetchLatest(workdir);

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
    session?: string,
    draft?: boolean
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
      workdir = await this.sessionDB.getSessionWorkdir(session);
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
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      // Create the pull request
      const prResponse = await octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title,
        body,
        head: sourceBranch,
        base: baseBranch,
        draft: draft || false,
      });

      const pr = prResponse.data;

      // Log GitHub-specific PR information
      log.cli(`🔗 GitHub PR: ${pr.html_url}`);
      log.cli(`📝 PR #${pr.number}: ${title}`);

      const prInfo = {
        number: pr.number,
        url: pr.html_url,
        state: pr.draft ? "draft" : (pr.state as "open" | "closed" | "merged"),
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
          draft: pr.draft,
        },
      };

      // Update session record with PR information if session is provided
      if (session) {
        try {
          const sessionRecord = await this.sessionDB.getSession(session);
          if (sessionRecord) {
            // Update the session record with PR info (GitHub backend doesn't use prBranch)
            const updatedSession = {
              ...sessionRecord,
              pullRequest: {
                number: pr.number,
                url: pr.html_url,
                title: pr.title || `PR #${pr.number}`,
                state: pr.draft ? "draft" : (pr.state as any) || "open",
                createdAt: pr.created_at,
                updatedAt: pr.updated_at,
                mergedAt: pr.merged_at || undefined,
                headBranch: pr.head.ref,
                baseBranch: pr.base.ref,
                body: pr.body || undefined,
                github: {
                  id: pr.id,
                  nodeId: pr.node_id,
                  htmlUrl: pr.html_url,
                  author: pr.user?.login || "unknown",
                },
                lastSynced: new Date().toISOString(),
              },
            };
            await this.sessionDB.updateSession(session, updatedSession);
            log.debug(`Updated session record for ${session} with PR #${pr.number}`);
          }
        } catch (error) {
          // Don't fail the PR creation if session update fails, just log it
          log.debug(`Failed to update session record with PR info: ${error}`);
        }
      }

      return prInfo;
    } catch (error) {
      // Enhanced error handling for different types of GitHub API errors
      const anyError: any = error as any;
      const errorMessage = (anyError?.message || "").toLowerCase();
      const statusCode = anyError?.status ?? anyError?.response?.status;
      const responseData = anyError?.response?.data;
      const ghTop = (responseData?.message || "").toString();
      const ghErrors = Array.isArray(responseData?.errors) ? responseData.errors : [];
      const ghDetailMessages = ghErrors
        .map((e: any) => (e?.message || e?.code || "").toString())
        .filter(Boolean);
      const combinedGhText = [ghTop, ...ghDetailMessages].join(" \n").toLowerCase();

      // Authentication errors (401)
      if (
        statusCode === 401 ||
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
      if (statusCode === 403 || errorMessage.includes("forbidden")) {
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
      if (statusCode === 404 || errorMessage.includes("not found")) {
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
      if (statusCode === 429 || errorMessage.includes("rate limit")) {
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
            `Error: ${anyError?.message || "unknown"}`
        );
      }

      // Validation errors (422) and specific messages
      if (
        statusCode === 422 ||
        errorMessage.includes("422") ||
        combinedGhText.includes("no commits between") ||
        combinedGhText.includes("no changes")
      ) {
        // No changes to PR
        if (
          combinedGhText.includes("no commits between") ||
          combinedGhText.includes("no changes") ||
          errorMessage.includes("no commits between")
        ) {
          throw new MinskyError(
            `📝 No Changes to Create PR\n\n` +
              `No differences found between ${sourceBranch} and ${baseBranch}.\n\n` +
              `💡 To proceed:\n` +
              `  • Ensure you have new commits on ${sourceBranch}\n` +
              `  • Push your branch: git push origin ${sourceBranch}\n` +
              `  • Verify branch selection and base branch`
          );
        }
        // PR already exists
        if (
          combinedGhText.includes("already exists") ||
          combinedGhText.includes("pull request already exists")
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

      // Fallback for any other errors: include GitHub's message for transparency
      const detail = ghTop || ghDetailMessages[0] || anyError?.message || "Unknown error";
      throw new MinskyError(
        `Failed to create GitHub pull request (status ${statusCode ?? "n/a"}): ${detail}`
      );
    }
  }

  /**
   * Update an existing GitHub pull request
   * This method handles updating PR title and/or body without triggering git conflicts
   */
  async updatePullRequest(options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }): Promise<PRInfo> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured to update pull requests");
    }

    // Get PR number - either from options or derive from session
    let prNumber: number;
    if (options.prIdentifier) {
      prNumber =
        typeof options.prIdentifier === "string"
          ? parseInt(options.prIdentifier, 10)
          : options.prIdentifier;
      if (isNaN(prNumber)) {
        throw new MinskyError(`Invalid PR number: ${options.prIdentifier}`);
      }
    } else if (options.session) {
      // Find PR number from session record or GitHub API
      const sessionRecord = await this.sessionDB.getSession(options.session);
      if (!sessionRecord) {
        throw new MinskyError(`Session '${options.session}' not found`);
      }

      // Try to get PR number from session record first
      if (sessionRecord.pullRequest?.number) {
        prNumber =
          typeof sessionRecord.pullRequest.number === "string"
            ? parseInt(sessionRecord.pullRequest.number, 10)
            : sessionRecord.pullRequest.number;
      } else {
        // If no PR number in session, try to find it via GitHub API using current git branch
        try {
          const { getConfiguration } = require("../configuration/index");
          const config = getConfiguration();
          const githubToken = config.github.token;
          if (!githubToken) {
            throw new MinskyError("GitHub token required for PR operations");
          }

          // Get current git branch from the session workspace
          if (!options.session) {
            throw new MinskyError(
              "Session name is required to update PR without explicit PR number"
            );
          }
          const sessionWorkdir = await this.sessionDB.getSessionWorkdir(options.session);
          const { GitService } = require("../git");
          const gitService = new GitService(this.sessionDB);
          const currentBranch = (
            await gitService.execInRepository(sessionWorkdir, "git branch --show-current")
          ).trim();

          const octokit = new Octokit({
            auth: githubToken,
            log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          });
          const { data: pulls } = await octokit.rest.pulls.list({
            owner: this.owner,
            repo: this.repo,
            head: `${this.owner}:${currentBranch}`,
            state: "open",
          });

          const first = pulls[0];
          if (!first) {
            throw new MinskyError(`No open PR found for branch '${currentBranch}'`);
          }

          prNumber = first.number;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new MinskyError(`No PR found for session '${options.session}': ${msg}`);
        }
      }
    } else {
      throw new MinskyError("Either prIdentifier or session must be provided");
    }

    try {
      // Get GitHub token from configuration system
      const { getConfiguration } = require("../configuration/index");
      const config = getConfiguration();
      const githubToken = config.github.token;
      if (!githubToken) {
        throw new MinskyError("GitHub token required for PR operations");
      }

      // Initialize Octokit client
      const octokit = new Octokit({
        auth: githubToken,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      // Prepare update payload - only include fields that are provided
      const updateData: { title?: string; body?: string } = {};
      if (options.title !== undefined) {
        updateData.title = options.title;
      }
      if (options.body !== undefined) {
        updateData.body = options.body;
      }

      if (Object.keys(updateData).length === 0) {
        throw new MinskyError("At least one field (title or body) must be provided for update");
      }

      // Update the PR via GitHub API
      const response = await octokit.rest.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        ...updateData,
      });

      log.debug(`Updated GitHub PR #${prNumber}`, {
        title: updateData.title,
        body: updateData.body
          ? updateData.body.substring(0, 100) + (updateData.body.length > 100 ? "..." : "")
          : undefined,
      });

      return {
        number: response.data.number,
        url: response.data.html_url,
        state: response.data.state as "open" | "closed" | "merged",
        metadata: {
          owner: this.owner,
          repo: this.repo,
          // Only set workdir when session provided
          workdir: options.session ? await this.sessionDB.getSessionWorkdir(options.session) : "",
        },
      };
    } catch (error) {
      // Enhanced error handling for PR update operations
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();

        // Authentication errors (401, 403)
        if (errorMessage.includes("401") || errorMessage.includes("403")) {
          throw new MinskyError(
            `🔐 GitHub Authentication Error\n\n` +
              `Unable to authenticate with GitHub API.\n\n` +
              `💡 To fix this:\n` +
              `  • Verify your GitHub token is valid and not expired\n` +
              `  • Ensure you have write access to the repository\n` +
              `  • Check your token permissions include 'repo' scope`
          );
        }

        // PR not found (404)
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          throw new MinskyError(
            `🔍 Pull Request Not Found\n\n` +
              `PR #${prNumber} was not found in ${this.owner}/${this.repo}.\n\n` +
              `💡 To fix this:\n` +
              `  • Verify the PR number is correct\n` +
              `  • Check if the PR has been closed or merged\n` +
              `  • Visit: https://github.com/${this.owner}/${this.repo}/pull/${prNumber}`
          );
        }
      }

      // Fallback for any other errors
      throw new MinskyError(
        `Failed to update GitHub pull request: ${getErrorMessage(error as any)}`
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
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
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

      // Merge the pull request using a merge commit that mirrors PR title/body
      // This aligns GitHub backend behavior with the prepared merge commit workflow
      const mergeResponse = await octokit.rest.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        merge_method: "merge",
        commit_title: pr.title || `Merge pull request #${prNumber} from ${pr.head.ref}`,
        commit_message: pr.body || "",
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

  /**
   * Find the PR number for a given branch name
   * Searches through open and closed PRs to find one with the matching head branch
   */
  private async findPRNumberForBranch(branchName: string): Promise<number> {
    try {
      // Get GitHub token from configuration system
      const { getConfiguration } = require("../configuration/index");
      const config = getConfiguration();
      const githubToken = config.github.token;
      if (!githubToken) {
        throw new MinskyError("GitHub token not configured");
      }

      // Create Octokit instance
      const octokit = new Octokit({
        auth: githubToken,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      // Search for pull requests with this head branch
      // First try open PRs, then closed ones
      for (const state of ["open", "closed"] as const) {
        const pullsResponse = await octokit.rest.pulls.list({
          owner: this.owner || "",
          repo: this.repo || "",
          state,
          head: `${this.owner}:${branchName}`, // Format: owner:branch
          per_page: 100,
        });

        const matchingPR = pullsResponse.data.find((pr) => pr.head.ref === branchName);
        if (matchingPR) {
          return matchingPR.number;
        }
      }

      // If not found with owner prefix, try without it (for forks)
      for (const state of ["open", "closed"] as const) {
        const pullsResponse = await octokit.rest.pulls.list({
          owner: this.owner || "",
          repo: this.repo || "",
          state,
          per_page: 100,
        });

        const matchingPR = pullsResponse.data.find((pr) => pr.head.ref === branchName);
        if (matchingPR) {
          return matchingPR.number;
        }
      }

      throw new MinskyError(`No pull request found for branch: ${branchName}`);
    } catch (error) {
      if (error instanceof MinskyError) {
        throw error;
      }
      throw new MinskyError(
        `Failed to find PR number for branch ${branchName}: ${getErrorMessage(error as any)}`
      );
    }
  }

  /**
   * Approve a GitHub pull request using the GitHub API
   * Creates a review with 'APPROVE' state on the specified pull request
   */
  async approvePullRequest(
    prIdentifier: string | number,
    reviewComment?: string
  ): Promise<ApprovalInfo> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured to approve pull requests");
    }

    let prNumber: number;

    // If prIdentifier is already a number, use it directly
    if (typeof prIdentifier === "number") {
      prNumber = prIdentifier;
    } else {
      // If it's a string, check if it's a numeric PR number or a branch name
      const parsedNumber = parseInt(prIdentifier, 10);
      if (!isNaN(parsedNumber) && String(parsedNumber) === prIdentifier) {
        // It's a valid PR number as string
        prNumber = parsedNumber;
      } else {
        // It's a branch name, need to find the PR number for this branch
        prNumber = await this.findPRNumberForBranch(prIdentifier);
      }
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
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      // Get the PR details first to validate it exists and is open
      const prResponse = await octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const pr = prResponse.data;

      if (pr.state !== "open") {
        throw new MinskyError(`Pull request #${prNumber} is not open (current state: ${pr.state})`);
      }

      // Create an approval review on the pull request
      const reviewResponse = await octokit.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        body: reviewComment || "Approved via Minsky session workflow",
        event: "APPROVE",
      });

      const review = reviewResponse.data;

      // Get the current user info for the approval record
      const userResponse = await octokit.rest.users.getAuthenticated();
      const approver = userResponse.data.login;

      log.info("GitHub PR approved successfully", {
        prNumber,
        reviewId: review.id,
        approver,
        owner: this.owner,
        repo: this.repo,
      });

      return {
        reviewId: String(review.id),
        approvedBy: approver,
        approvedAt: review.submitted_at || new Date().toISOString(),
        comment: reviewComment,
        prNumber,
        metadata: {
          github: {
            reviewId: review.id,
            reviewState: (review.state as any) || "APPROVED",
            reviewerLogin: approver,
            submittedAt: review.submitted_at || new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      // Enhanced error handling for different types of GitHub API errors
      const errorMessage = getErrorMessage(error as any);

      // Token permissions issues
      if (errorMessage.includes("401") || errorMessage.includes("Bad credentials")) {
        throw new MinskyError(
          `🔑 GitHub Authentication Error\n\n` +
            `Your GitHub token is invalid or expired.\n\n` +
            `💡 To fix this:\n` +
            `  • Generate a new GitHub token at: https://github.com/settings/tokens\n` +
            `  • Ensure the token has 'repo' and 'pull_requests:write' permissions\n` +
            `  • Update your GITHUB_TOKEN environment variable or config file`
        );
      }

      // Insufficient permissions for approval
      if (errorMessage.includes("403")) {
        throw new MinskyError(
          `🚫 GitHub Permission Error\n\n` +
            `You don't have permission to approve pull requests in ${this.owner}/${this.repo}.\n\n` +
            `💡 To fix this:\n` +
            `  • Ensure your GitHub token has 'repo' permissions\n` +
            `  • Verify you have write access to the repository\n` +
            `  • Contact the repository owner if you need additional permissions`
        );
      }

      // PR not found
      if (errorMessage.includes("404")) {
        throw new MinskyError(
          `🔍 Pull Request Not Found\n\n` +
            `Pull request #${prNumber} does not exist in ${this.owner}/${this.repo}.\n\n` +
            `💡 Please verify:\n` +
            `  • The PR number is correct\n` +
            `  • The repository owner/name is correct\n` +
            `  • The PR hasn't been deleted`
        );
      }

      // Rate limiting
      if (errorMessage.includes("rate limit") || errorMessage.includes("403")) {
        throw new MinskyError(
          `⏱️ GitHub Rate Limit Exceeded\n\n` +
            `Too many API requests to GitHub. Please wait before trying again.\n\n` +
            `💡 To avoid this:\n` +
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

      // Self-approval is not allowed
      if (
        errorMessage.includes("Can not approve your own pull request") ||
        errorMessage.toLowerCase().includes("cannot approve your own pull request")
      ) {
        throw new MinskyError(
          `🙅 Cannot Approve Your Own Pull Request\n\n` +
            `GitHub prevents authors from approving their own PR.\n\n` +
            `PR: https://github.com/${this.owner}/${this.repo}/pull/${prNumber}\n\n` +
            `Next steps:\n` +
            `  • Request a review from a maintainer\n` +
            `  • Alternatively, have another collaborator approve the PR`
        );
      }

      // Fallback for any other errors
      throw new MinskyError(
        `Failed to approve GitHub pull request: ${getErrorMessage(error as any)}`
      );
    }
  }

  /**
   * Get approval status for a GitHub pull request
   * Checks the reviews and approval status via GitHub API
   */
  async getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus> {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured to check PR approval status");
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
        throw new MinskyError("GitHub token not configured");
      }

      // Create Octokit instance
      const octokit = new Octokit({
        auth: githubToken,
      });

      // Get PR details and reviews
      const [prResponse, reviewsResponse] = await Promise.all([
        octokit.rest.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
        octokit.rest.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        }),
      ]);

      const pr = prResponse.data;
      const reviews = reviewsResponse.data;

      // Count approvals and rejections
      const approvals = reviews.filter((review) => review.state === "APPROVED");
      const rejections = reviews.filter((review) => review.state === "CHANGES_REQUESTED");

      // Determine required approvals from branch protection (default to 0 if unavailable)
      let requiredApprovals = 0;
      try {
        const protection = await octokit.rest.repos.getBranchProtection({
          owner: this.owner,
          repo: this.repo,
          branch: pr.base.ref,
        });
        const required =
          protection.data.required_pull_request_reviews?.required_approving_review_count;
        if (typeof required === "number" && required >= 0) {
          requiredApprovals = required;
        }
      } catch (_e) {
        // No protection or insufficient perms → treat as zero required approvals
        requiredApprovals = 0;
      }

      // Determine approval: if no required approvals, only block when changes requested
      const isApproved =
        (requiredApprovals === 0 && rejections.length === 0) ||
        (requiredApprovals > 0 && approvals.length >= requiredApprovals && rejections.length === 0);
      const canMerge = isApproved && !!pr.mergeable && pr.state === "open";

      return {
        isApproved,
        canMerge,
        approvals: approvals.map((review) => ({
          reviewId: String(review.id),
          approvedBy: review.user?.login || "unknown",
          approvedAt: review.submitted_at || "",
          comment: review.body || undefined,
          prNumber,
        })),
        requiredApprovals,
        prState: (pr.state as any) || "open",
        metadata: {
          github: {
            statusChecks: [],
            branchProtection: {
              requiredReviews: requiredApprovals,
              dismissStaleReviews: false,
              requireCodeOwnerReviews: false,
              restrictPushes: false,
            },
            codeownersApproval: undefined,
          },
        },
      };
    } catch (error) {
      throw new MinskyError(
        `Failed to get GitHub PR approval status: ${getErrorMessage(error as any)}`
      );
    }
  }
}
