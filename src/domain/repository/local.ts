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
 * Local Git Repository Backend implementation
 * This is the default backend that uses a local git repository
 */
export class LocalGitBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl!: string;
  private readonly repoName!: string;
  private sessionDb: SessionProviderInterface;
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
    this.sessionDb = createSessionProvider();
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

  async push(): Promise<Result> {
    // TODO: Implement local git push logic
    return { success: false, message: "Not implemented" };
  }

  async pull(): Promise<Result> {
    // TODO: Implement local git pull logic
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
        number: prBranch, // Use branch name as identifier for local repos
        url: prBranch, // Use branch name as URL for local repos
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
