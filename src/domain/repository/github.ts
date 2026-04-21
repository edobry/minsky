import { join } from "path";
import { HTTP_OK } from "../../utils/constants";
import { mkdir } from "fs/promises";
import type { SessionProviderInterface } from "../session";
import { execAsync } from "../../utils/exec";
import { normalizeRepositoryURI } from "../repository-uri";
import { GitService } from "../git";
import { execGitWithTimeout } from "../../utils/git-exec";
import { MinskyError } from "../../errors/index";
import type { RepositoryStatus } from "./legacy-types";
import type {
  ForgeBackend,
  ForgeType,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  ValidationResult,
  RepoStatus,
  PRInfo,
  MergeInfo,
  CreatePROptions,
  UpdatePROptions,
  PullRequestOperations,
  CIStatusOperations,
  ReviewOperations,
} from "./index";
import type { ApprovalInfo, ApprovalStatus } from "./approval-types";
import type { ChecksResult } from "./github-pr-checks";
import { getCheckRunsForRef } from "./github-pr-checks";
import type { Octokit } from "@octokit/rest";
import {
  createPullRequest as createPR,
  updatePullRequest as updatePR,
  mergePullRequest as mergePR,
  getPullRequestDetails as getPRDetails,
  getPullRequestDiff as getPRDiff,
  findPRNumberForBranch,
  createOctokit,
  type GitHubContext,
} from "./github-pr-operations";
import {
  approvePullRequest as approvePR,
  getPullRequestApprovalStatus as getApprovalStatus,
  diagnoseMergeBlocker,
} from "./github-pr-approval";
import { FallbackTokenProvider, type TokenProvider } from "../auth";

const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/**
 * GitHub Repository Backend implementation
 * Handles cloning, branching and other operations for GitHub repositories
 */
export class GitHubBackend implements ForgeBackend {
  private readonly baseDir: string;
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private readonly owner?: string;
  private readonly repo?: string;
  private readonly sessionDB: SessionProviderInterface;
  private gitService: GitService;
  private readonly tokenProvider: TokenProvider;
  readonly forgeType: ForgeType = "github";

  /**
   * Create a new GitHubBackend instance
   * @param config Backend configuration
   * @param sessionDB Session provider for database operations
   * @param tokenProvider Optional token provider for GitHub API authentication
   */
  constructor(
    config: RepositoryBackendConfig,
    sessionDB: SessionProviderInterface,
    tokenProvider?: TokenProvider
  ) {
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
        const sshMatch = this.repoUrl.match(/git@github\.com:([^/]+)\/([^.]+)/);
        const httpsMatch = this.repoUrl.match(/https:\/\/github\.com\/([^.]+)\/([^.]+)/);
        const match = sshMatch || httpsMatch;
        if (match && match[1] && match[2]) {
          this.owner = this.owner || match[1];
          this.repo = this.repo || match[2].replace(/\.git$/, "");
        }
      } catch (_err) {
        // Ignore parsing errors; explicit config may still provide these later
      }
    }
    this.sessionDB = sessionDB;
    this.gitService = new GitService(this.baseDir);

    // Use the provided TokenProvider, or fall back to config-based token if available
    if (tokenProvider) {
      this.tokenProvider = tokenProvider;
    } else if (config.github?.token) {
      this.tokenProvider = new FallbackTokenProvider(config.github.token);
    } else {
      // Last resort: read from config system at token-request time
      this.tokenProvider = new FallbackTokenProvider(
        (() => {
          try {
            const { getConfiguration } = require("../configuration/index");
            const cfg = getConfiguration();
            return cfg.github?.token || "";
          } catch {
            return "";
          }
        })()
      );
    }
  }

  /**
   * Get the session database provider
   */
  private async getSessionDB(): Promise<SessionProviderInterface> {
    return this.sessionDB;
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
      const _result = await this.gitService.clone({
        repoUrl: this.repoUrl,
        workdir,
        session,
      });

      return {
        workdir,
        session,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      // Provide more informative error messages for common GitHub issues
      if (normalizedError.message.includes("Authentication failed")) {
        throw new Error(`
GitHub Authentication Failed

Unable to authenticate with GitHub repository: ${this.owner}/${this.repo}

Quick fixes:
   - Verify you have access to ${this.owner}/${this.repo}
   - Check your GitHub credentials (SSH key or personal access token)
   - Ensure the repository exists and is accessible

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
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to create branch in GitHub repository: ${normalizedError.message}`);
    }
  }

  /**
   * Get repository status
   */
  async getStatus(): Promise<RepoStatus> {
    try {
      // Find a session for this repository
      const sessionDB = await this.getSessionDB();
      const sessions = await sessionDB.listSessions();
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
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to get GitHub repository status: ${normalizedError.message}`);
    }
  }

  /**
   * Get repository status for a specific session
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatusForSession(session: string): Promise<RepositoryStatus> {
    const _workdir = this.getSessionWorkdir(session);
    return this.getStatus(); // Reuse the existing implementation
  }

  /**
   * Get the repository path
   * @param session Optional session identifier
   * @returns Path to the repository
   */
  async getPath(session?: string): Promise<string> {
    if (session) {
      return this.getSessionWorkdir(session);
    }

    // If no session is provided, find one for this repository
    try {
      const sessionDB = await this.getSessionDB();
      const sessions = await sessionDB.listSessions();
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
      const normalizedError = error instanceof Error ? error : new Error(String(error));
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
  async push(): Promise<{ success: boolean; message: string }> {
    try {
      // Find a session for this repository
      const sessionDB = await this.getSessionDB();
      const sessions = await sessionDB.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }

      const sessionId = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionId);

      // Use GitService for pushing changes
      const pushResult = await this.gitService.push({
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
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to push to repository: ${normalizedError.message}`,
      };
    }
  }

  /**
   * Pull changes from GitHub repository
   * @returns Result of the pull operation
   */
  async pull(): Promise<{ success: boolean; message: string }> {
    try {
      // Find a session for this repository
      const sessionDB = await this.getSessionDB();
      const sessions = await sessionDB.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

      if (!repoSession) {
        return {
          success: false,
          message: "No session found for this repository",
        };
      }

      const sessionId = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionId);

      // Use GitService for pulling changes
      const pullResult = await this.gitService.fetchLatest(workdir);

      return {
        success: true,
        message: pullResult.updated
          ? "Successfully pulled changes from repository"
          : "Already up-to-date. No changes pulled.",
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to pull from repository: ${normalizedError.message}`,
      };
    }
  }

  /**
   * Checkout an existing branch
   * @param branch Branch name to checkout
   */
  async checkout(branch: string): Promise<void> {
    try {
      // Find a session for this repository
      const sessionDB = await this.getSessionDB();
      const sessions = await sessionDB.listSessions();
      const repoSession = sessions.find((session) => session.repoName === this.repoName);

      if (!repoSession) {
        throw new Error("No session found for this repository");
      }

      const sessionId = repoSession.session;
      const workdir = this.getSessionWorkdir(sessionId);

      await execGitWithTimeout("github-checkout-branch", `checkout ${branch}`, { workdir });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to checkout branch: ${normalizedError.message}`);
    }
  }

  /**
   * Get the repository configuration
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

  // ── Helpers for GitHub context ──────────────────────────────────────

  private requireGitHubContext(): GitHubContext {
    if (!this.owner || !this.repo) {
      throw new MinskyError("GitHub owner and repo must be configured for PR operations");
    }
    return {
      owner: this.owner,
      repo: this.repo,
      getToken: () => this.tokenProvider.getServiceToken(),
    };
  }

  /**
   * Find PR number for a branch name (used by PR operations modules)
   */
  private async findPRNumberForBranch(branchName: string): Promise<number> {
    const gh = this.requireGitHubContext();
    const token = await this.tokenProvider.getServiceToken();
    const octokit = createOctokit(token);
    return findPRNumberForBranch(branchName, gh, octokit);
  }

  // ── Grouped sub-interface properties ─────────────────────────────────

  get pr(): PullRequestOperations {
    return {
      create: async (options: CreatePROptions): Promise<PRInfo> => {
        const gh = this.requireGitHubContext();

        let workdir: string;
        if (options.session) {
          const sessionDB = await this.getSessionDB();
          const record = await sessionDB.getSession(options.session);
          if (!record) {
            throw new MinskyError(`Session '${options.session}' not found in database`);
          }
          workdir = await sessionDB.getSessionWorkdir(options.session);
        } else {
          workdir = process.cwd();
        }

        return createPR(
          gh,
          options.title,
          options.body,
          options.sourceBranch,
          options.baseBranch,
          workdir,
          options.session,
          options.draft || false,
          () => this.getSessionDB(),
          options.authorshipTier
        );
      },

      update: async (options: UpdatePROptions): Promise<PRInfo> => {
        const gh = this.requireGitHubContext();
        return updatePR(gh, options, () => this.getSessionDB());
      },

      merge: async (
        prIdentifier: string | number,
        _session?: string,
        options?: import("./index").MergePROptions
      ): Promise<MergeInfo> => {
        const gh = this.requireGitHubContext();
        return mergePR(
          gh,
          prIdentifier,
          (prNum: number, octokit: Octokit) => diagnoseMergeBlocker(gh, prNum, octokit),
          options?.mergeTrailers,
          options?.tokenOverride
        );
      },

      get: async (options: { prIdentifier?: string | number; session?: string }) => {
        const gh = this.requireGitHubContext();
        return getPRDetails(
          gh,
          options,
          () => this.getSessionDB(),
          (branch) => this.findPRNumberForBranch(branch)
        );
      },

      getDiff: async (options: { prIdentifier?: string | number; session?: string }) => {
        const gh = this.requireGitHubContext();
        return getPRDiff(
          gh,
          options,
          () => this.getSessionDB(),
          (branch) => this.findPRNumberForBranch(branch)
        );
      },
    };
  }

  get ci(): CIStatusOperations {
    return {
      getChecksForRef: async (headSha: string): Promise<ChecksResult> => {
        const gh = this.requireGitHubContext();
        const token = await this.tokenProvider.getServiceToken();
        const octokit = createOctokit(token);
        return getCheckRunsForRef(gh, headSha, octokit);
      },

      getChecksForPR: async (prNumber: number): Promise<ChecksResult> => {
        const gh = this.requireGitHubContext();
        const token = await this.tokenProvider.getServiceToken();
        const octokit = createOctokit(token);

        const { data: pr } = await octokit.rest.pulls.get({
          owner: gh.owner,
          repo: gh.repo,
          pull_number: prNumber,
        });

        return getCheckRunsForRef(gh, pr.head.sha, octokit);
      },
    };
  }

  get review(): ReviewOperations {
    return {
      approve: async (
        prIdentifier: string | number,
        reviewComment?: string
      ): Promise<ApprovalInfo> => {
        const gh = this.requireGitHubContext();
        return approvePR(gh, prIdentifier, reviewComment);
      },

      getApprovalStatus: async (prIdentifier: string | number): Promise<ApprovalStatus> => {
        const gh = this.requireGitHubContext();
        return getApprovalStatus(gh, prIdentifier);
      },
    };
  }
}
