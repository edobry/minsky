import { join } from "path";
import { mkdir } from "fs/promises";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import { execGitWithTimeout, gitCloneWithTimeout } from "../../utils/git-exec";
import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";
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
import {
  createPullRequest as _createPR,
  updatePullRequest as _updatePR,
  mergePullRequest as _mergePR,
  getPullRequestDetails as _getPRDetails,
  getPullRequestDiff as _getPRDiff,
  type LocalContext,
} from "./local-pr-operations";
import {
  approvePullRequest as _approvePR,
  getPullRequestApprovalStatus as _getApprovalStatus,
} from "./local-pr-approval";
import { execAsync } from "../../utils/exec";

/**
 * Local Git Repository Backend implementation
 * This is the default backend that uses a local git repository.
 *
 * PR and approval logic lives in local-pr-operations.ts and
 * local-pr-approval.ts; this class is a thin delegation layer.
 */
export class LocalGitBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private sessionDB: SessionProviderInterface | null = null;
  private config: RepositoryBackendConfig;

  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");
    this.repoUrl = config.repoUrl;
    this.repoName = normalizeRepositoryURI(this.repoUrl);
    this.config = config;
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private async getSessionDB(): Promise<SessionProviderInterface> {
    if (!this.sessionDB) {
      this.sessionDB = await createSessionProvider();
    }
    return this.sessionDB;
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private getSessionWorkdir(session: string): string {
    // Use consistent path structure with SessionDB: no repoName component.
    // This fixes the bug where LocalGitBackend and SessionDB used different paths.
    return join(this.baseDir, "sessions", session);
  }

  /** Build a LocalContext for delegation to helper modules. */
  private get ctx(): LocalContext {
    return {
      getSessionWorkdir: (s) => this.getSessionWorkdir(s),
      getSessionDB: () => this.getSessionDB(),
    };
  }

  // ── RepositoryBackend: basic operations ──────────────────────────────

  getType(): string {
    return "local";
  }

  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    const sessionsDir = join(this.baseDir, this.repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const workdir = this.getSessionWorkdir(session);
    await gitCloneWithTimeout(this.repoUrl, workdir);

    return { workdir, session };
  }

  async branch(session: string, branch: string): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = this.getSessionWorkdir(session);
    await execGitWithTimeout("local-create-branch", `checkout -b ${branch}`, { workdir });
    return { workdir, branch };
  }

  async getStatus(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);
    const { stdout: branchOutput } = await execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    const branch = branchOutput.trim();

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
      // No upstream branch set — that's fine
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

  async getPath(session: string): Promise<string> {
    return this.getSessionWorkdir(session);
  }

  async validate(): Promise<Result> {
    try {
      if (!this.repoUrl.includes("://") && !this.repoUrl.includes("@")) {
        const { stdout } = await execAsync(
          `test -d "${this.repoUrl}/.git" && echo "true" || echo "false"`
        );
        if (stdout.trim() !== "true") {
          throw new Error(`Not a git repository: ${this.repoUrl}`);
        }
      }
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return { success: false, message: `Invalid git repository: ${normalizedError.message}` };
    }
    return { success: true, message: "Repository is valid" };
  }

  async push(branch?: string): Promise<any> {
    try {
      const workdir = this.repoUrl;
      let pushCommand = "push";
      if (branch) {
        pushCommand += ` origin ${branch}`;
      }
      await execGitWithTimeout("push", pushCommand, { workdir, timeout: 60000 });
      return { success: true, message: "Push completed successfully" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Push failed: ${errorMessage}` };
    }
  }

  async pull(branch?: string): Promise<any> {
    try {
      const workdir = this.repoUrl;
      let pullCommand = "pull";
      if (branch) {
        pullCommand += ` origin ${branch}`;
      }
      await execGitWithTimeout("pull", pullCommand, { workdir, timeout: 60000 });
      return { success: true, message: "Pull completed successfully" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Pull failed: ${errorMessage}` };
    }
  }

  // ── RepositoryBackend: PR operations (delegated) ─────────────────────

  async createPullRequest(
    title: string,
    body: string,
    sourceBranch: string,
    baseBranch: string = "main",
    session?: string,
    draft?: boolean
  ): Promise<PRInfo> {
    return _createPR(this.ctx, title, body, sourceBranch, baseBranch, session, draft);
  }

  async updatePullRequest(options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }): Promise<PRInfo> {
    return _updatePR(this.ctx, options);
  }

  async mergePullRequest(prIdentifier: string | number, session?: string): Promise<MergeInfo> {
    return _mergePR(this.ctx, prIdentifier, session);
  }

  async getPullRequestDetails(options: {
    prIdentifier?: string | number;
    session?: string;
  }): Promise<any> {
    return _getPRDetails(this.ctx, options);
  }

  async getPullRequestDiff(options: {
    prIdentifier?: string | number;
    session?: string;
  }): Promise<any> {
    return _getPRDiff(this.ctx, options);
  }

  // ── RepositoryBackend: approval operations (delegated) ───────────────

  async approvePullRequest(
    prIdentifier: string | number,
    reviewComment?: string
  ): Promise<ApprovalInfo> {
    return _approvePR(this.ctx, prIdentifier, reviewComment);
  }

  async getPullRequestApprovalStatus(prIdentifier: string | number): Promise<ApprovalStatus> {
    return _getApprovalStatus(this.ctx, prIdentifier);
  }

  // ── RepositoryBackend: session hook ─────────────────────────────────

  /**
   * Post-session-update hook: auto-update PR branches for local repositories.
   * Ensures PRs stay current when sessions are updated with latest main.
   */
  async onSessionUpdated(event: SessionUpdateEvent): Promise<void> {
    const { session, workdir } = event;
    try {
      const hasPr = session.pullRequest || (session.prState && session.prState.exists);
      if (!hasPr) {
        log.debug(`Session '${session.session}' has no associated PR, skipping PR branch update`);
        return;
      }

      let prBranch: string;
      if (session.pullRequest?.headBranch) {
        prBranch = session.pullRequest.headBranch;
      } else if (session.prState?.branchName) {
        prBranch = session.prState.branchName;
      } else {
        prBranch = `pr/${session.session}`;
      }

      log.info(`Local session has associated PR, auto-updating PR branch '${prBranch}'`);

      const { stdout: currentBranchOutput } = await execGitWithTimeout(
        "branch-show-current",
        "branch --show-current",
        { workdir, timeout: 10000 }
      );
      const currentBranchName = currentBranchOutput.trim();

      if (currentBranchName === prBranch) {
        await execGitWithTimeout("push", `push origin ${prBranch}`, { workdir, timeout: 30000 });
        log.info(`PR branch '${prBranch}' updated successfully`);
      } else {
        log.debug(
          `Current branch '${currentBranchName}' differs from PR branch '${prBranch}', updating PR branch`
        );

        try {
          await execGitWithTimeout("rev-parse", `rev-parse --verify ${prBranch}`, {
            workdir,
            timeout: 10000,
          });
          // PR branch exists locally — merge current changes into it
          await execGitWithTimeout("checkout", `checkout ${prBranch}`, { workdir, timeout: 10000 });
          await execGitWithTimeout("merge", `merge ${currentBranchName}`, {
            workdir,
            timeout: 30000,
          });
          await execGitWithTimeout("push", `push origin ${prBranch}`, { workdir, timeout: 30000 });
          await execGitWithTimeout("checkout", `checkout ${currentBranchName}`, {
            workdir,
            timeout: 10000,
          });
          log.info(`PR branch '${prBranch}' updated with latest changes`);
        } catch {
          // PR branch doesn't exist locally — create it from current branch
          await execGitWithTimeout("checkout-b", `checkout -b ${prBranch}`, {
            workdir,
            timeout: 10000,
          });
          await execGitWithTimeout("push", `push origin ${prBranch}`, { workdir, timeout: 30000 });
          await execGitWithTimeout("checkout", `checkout ${currentBranchName}`, {
            workdir,
            timeout: 10000,
          });
          log.info(`PR branch '${prBranch}' created and pushed`);
        }
      }
    } catch (error) {
      log.warn(
        `Failed to update PR branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
