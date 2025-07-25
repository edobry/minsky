import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import { normalizeRepositoryURI } from "../repository-uri";
import { execGitWithTimeout, gitCloneWithTimeout, type GitExecOptions } from "../../utils/git-exec";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index";

// Define a global for process to avoid linting errors
declare const process: {
  env: {
    XDG_STATE_HOME?: string;
    HOME?: string;
    [key: string]: string | undefined;
  };
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
}
