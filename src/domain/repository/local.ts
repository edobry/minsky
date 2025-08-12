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
  ApprovalInfo,
  ApprovalStatus,
  SessionUpdateEvent,
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
 * Local Git Repository Backend implementation
 * This is the default backend that uses a local git repository
 */
export class LocalGitBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private sessionDB: SessionProviderInterface;
  private config: RepositoryBackendConfig;

  /**
   * Create a new LocalGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");
    this.repoUrl = config.repoUrl;
    this.repoName = normalizeRepositoryURI(this.repoUrl);
    this.sessionDB = createSessionProvider();
    this.config = config;
  }

  /**
   * Get the backend type
   * @returns Backend type identifier
   */
  getType(): string {
    return "local";
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
    // Use consistent path structure with SessionDB: no repoName component
    // This fixes the bug where LocalGitBackend and SessionDB used different paths
    return join(this.baseDir, "sessions", session);
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

    // Clone the repository
    await gitCloneWithTimeout(this.repoUrl, workdir);

    return {
      workdir,
      session,
    };
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

    // Create the branch in the specified session's repo
    await execGitWithTimeout("local-create-branch", `checkout -b ${branch}`, { workdir });

    return {
      workdir,
      branch,
    };
  }

  /**
   * Get repository status
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatus(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);
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

    const { stdout: statusOutput } = await execGitWithTimeout(
      "local-status-check",
      "status --porcelain",
      { workdir }
    );
    const dirty = statusOutput.trim().length > 0;
    const modifiedFiles = statusOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3),
      }));

    // Get remote information
    const { stdout: remoteOutput } = await execGitWithTimeout("local-remote-list", "remote", {
      workdir,
    });
    const remotes = remoteOutput.trim().split("\n").filter(Boolean);

    return {
      branch,
      ahead,
      behind,
      dirty,
      remotes,
      workdir,
      modifiedFiles,
      clean: modifiedFiles.length === 0,
      changes: modifiedFiles.map((file) => `M ${file.file}`),
    };
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
   * @returns Promise that resolves if the repository is valid
   */
  async validate(): Promise<Result> {
    try {
      // If the repo is a local path, check if it has a .git directory
      if (!this.repoUrl.includes("://") && !this.repoUrl.includes("@")) {
        const { stdout } = await execAsync(
          `test -d "${this.repoUrl}/.git" && echo "true" || echo "false"`
        );
        if (stdout.trim() !== "true") {
          throw new Error(`Not a git repository: ${this.repoUrl}`);
        }
      }

      // For remote repositories, we can't easily validate them without cloning
      // For now, we'll just assume they're valid
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return { success: false, message: `Invalid git repository: ${normalizedError.message}` };
    }
    return { success: true, message: "Repository is valid" };
  }

  async push(branch?: string): Promise<any> {
    try {
      // Use the base repository directory (not session-specific)
      const workdir = this.repoUrl;

      // Build push command with optional branch
      let pushCommand = "push";
      if (branch) {
        pushCommand += ` origin ${branch}`;
      }

      await execGitWithTimeout("push", pushCommand, {
        workdir,
        timeout: 60000,
      });
      return { success: true, message: "Push completed successfully" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Push failed: ${errorMessage}`,
      };
    }
  }

  async pull(branch?: string): Promise<any> {
    try {
      // Use the base repository directory (not session-specific)
      const workdir = this.repoUrl;

      // Build pull command with optional branch
      let pullCommand = "pull";
      if (branch) {
        pullCommand += ` origin ${branch}`;
      }

      await execGitWithTimeout("pull", pullCommand, {
        workdir,
        timeout: 60000,
      });
      return { success: true, message: "Pull completed successfully" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Pull failed: ${errorMessage}`,
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
   * Update an existing pull request (local backend)
   * For local repositories, we treat the PR as a branch update
   */
  async updatePullRequest(options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }): Promise<PRInfo> {
    // For local repositories, updating a PR means updating the prepared merge commit
    // This might involve git operations, so we keep the existing sessionPr workflow
    // but with update semantics

    if (!options.session) {
      throw new MinskyError("Session is required for local repository PR updates");
    }

    const sessionRecord = await this.sessionDB.getSession(options.session);
    if (!sessionRecord?.prBranch) {
      throw new MinskyError(`No PR found for session '${options.session}'`);
    }

    // For local repos, we might need to recreate the prepared merge commit with new metadata
    // This is more complex and may involve conflicts, so we delegate to the existing workflow
    const { sessionPr } = await import("../session/commands/pr-command");

    const result = await sessionPr(
      {
        sessionName: options.session,
        title: options.title,
        body: options.body,
        // For local backend updates, we still might need conflict checking
        skipConflictCheck: false,
        noStatusUpdate: true,
        autoResolveDeleteConflicts: false,
      },
      { interface: "cli" }
    );

    return {
      number: sessionRecord.prBranch || "unknown",
      url: sessionRecord.prBranch || "local",
      state: "open",
      metadata: {
        backend: "local",
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
      // FIXED: Use the main repository (repoUrl) instead of session workspace
      // For local repositories, repoUrl is a local file path to the main repository
      // where PR branches exist. Merge operations must happen there, not in the
      // session workspace which is just a temporary development copy.
      workdir = record.repoUrl;
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

  /**
   * Approve a pull request in the local repository
   * For local repositories, this updates the session record with prApproved: true.
   * (GitHub backend would update GitHub, local backend updates session record)
   */
  async approvePullRequest(
    prIdentifier: string | number,
    reviewComment?: string
  ): Promise<ApprovalInfo> {
    const prId = String(prIdentifier);

    // Find session record by PR branch
    const sessions = await this.sessionDB.listSessions();
    const sessionRecord = sessions.find((s) => s.prBranch === prId);

    if (!sessionRecord) {
      throw new Error(`No session found with PR branch: ${prId}`);
    }

    // Get current git user for approval record
    let approver = "local-user";
    try {
      const { stdout } = await execGitWithTimeout("get-user-name", "config user.name", {
        workdir: process.cwd(),
        timeout: 5000,
      });
      approver = stdout.trim() || "local-user";
    } catch {
      // Use default if git config fails
    }

    // Update session record with approval (this is where local backend stores approval)
    await this.sessionDB.updateSession(sessionRecord.session, {
      prApproved: true,
    });

    log.info("Local PR approved - session record updated", {
      prIdentifier: prId,
      sessionName: sessionRecord.session,
      approver,
    });

    return {
      reviewId: `local-${prId}-${Date.now()}`,
      approvedBy: approver,
      approvedAt: new Date().toISOString(),
      comment: reviewComment,
      platformData: {
        platform: "local",
        prIdentifier: prId,
        sessionName: sessionRecord.session,
      },
    };
  }

  /**
   * Get approval status for a pull request in the local repository
   * For local repositories, checks the session record for prApproved status.
   */
  async getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus> {
    const prId = String(prIdentifier);

    // Find session record by PR branch
    const sessions = await this.sessionDB.listSessions();
    const sessionRecord = sessions.find((s) => s.prBranch === prId);

    if (!sessionRecord) {
      log.debug("No session found for PR approval status check", { prIdentifier: prId });
      return {
        isApproved: false,
        approvals: [],
        requiredApprovals: 1,
        canMerge: false,
        platformData: {
          platform: "local",
          prIdentifier: prId,
          error: "No session found with this PR branch",
        },
      };
    }

    const isApproved = !!sessionRecord.prApproved;

    log.debug("Local PR approval status", {
      prIdentifier: prId,
      sessionName: sessionRecord.session,
      isApproved,
    });

    return {
      isApproved,
      approvals: isApproved
        ? [
            {
              reviewId: `local-${sessionRecord.session}`,
              approvedBy: "local-user",
              approvedAt: new Date().toISOString(), // We don't track when it was approved
              platformData: { platform: "local", sessionName: sessionRecord.session },
            },
          ]
        : [],
      requiredApprovals: 1,
      canMerge: isApproved,
      platformData: {
        platform: "local",
        prIdentifier: prId,
        sessionName: sessionRecord.session,
      },
    };
  }

  /**
   * Post-session-update hook: Auto-update PR branches for local repositories
   * This ensures PRs stay current when sessions are updated with latest main
   *
   * Design note: Simple implementation now, structured for future work item integration
   */
  async onSessionUpdated(event: SessionUpdateEvent): Promise<void> {
    const { session, workdir } = event;
    try {
      // Check if session has an associated PR
      const hasPr = session.pullRequest || (session.prState && session.prState.exists);

      if (!hasPr) {
        log.debug(`Session '${session.session}' has no associated PR, skipping PR branch update`);
        return;
      }

      // Determine PR branch name
      let prBranch: string;
      if (session.pullRequest?.headBranch) {
        prBranch = session.pullRequest.headBranch;
      } else if (session.prState?.branchName) {
        prBranch = session.prState.branchName;
      } else {
        // Default PR branch naming convention
        prBranch = `pr/${session.session}`;
      }

      log.info(`Local session has associated PR, auto-updating PR branch '${prBranch}'`);

      // Check if we're currently on the PR branch
      const currentBranchName = await execGitWithTimeout(workdir, ["branch", "--show-current"], {
        timeout: 10000,
      });

      if (currentBranchName === prBranch) {
        // We're on the PR branch, push the updates
        await execGitWithTimeout(workdir, ["push", "origin", prBranch], { timeout: 30000 });
        log.info(`PR branch '${prBranch}' updated successfully`);
      } else {
        // We're on a different branch (probably session branch), need to update PR branch
        log.debug(
          `Current branch '${currentBranchName}' differs from PR branch '${prBranch}', updating PR branch`
        );

        // Check if PR branch exists locally
        try {
          await execGitWithTimeout(workdir, ["rev-parse", "--verify", prBranch], {
            timeout: 10000,
          });
          // PR branch exists locally, merge current changes into it
          await execGitWithTimeout(workdir, ["checkout", prBranch], { timeout: 10000 });
          await execGitWithTimeout(workdir, ["merge", currentBranchName], { timeout: 30000 });
          await execGitWithTimeout(workdir, ["push", "origin", prBranch], { timeout: 30000 });
          await execGitWithTimeout(workdir, ["checkout", currentBranchName], { timeout: 10000 });
          log.info(`PR branch '${prBranch}' updated with latest changes`);
        } catch {
          // PR branch doesn't exist locally, create it from current branch
          await execGitWithTimeout(workdir, ["checkout", "-b", prBranch], { timeout: 10000 });
          await execGitWithTimeout(workdir, ["push", "origin", prBranch], { timeout: 30000 });
          await execGitWithTimeout(workdir, ["checkout", currentBranchName], { timeout: 10000 });
          log.info(`PR branch '${prBranch}' created and pushed`);
        }
      }
    } catch (error) {
      // Don't fail the session update if PR update fails
      log.warn(
        `Failed to update PR branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
