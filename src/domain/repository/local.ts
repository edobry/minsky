import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "../session.js";
import { normalizeRepositoryURI } from "../repository-uri.js";
import type {
  RepositoryBackend,
  RepositoryBackendConfig,
  CloneResult,
  BranchResult,
  Result,
  RepoStatus,
} from "./index.js";

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
  private readonly repoUrl: string;
  private readonly repoName: string;
  private sessionDb: SessionProviderInterface;
  private config: RepositoryBackendConfig;

  /**
   * Create a new LocalGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: RepositoryBackendConfig) {
    const xdgStateHome = (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky");
    (this as any).repoUrl = (config as any).repoUrl;
    (this as any).repoName = normalizeRepositoryURI((this as any).repoUrl);
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
    return join(this.baseDir, (this as any).repoName, "sessions", session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();

    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, (this as any).repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(session);

    // Clone the repository
    await execAsync(`git clone ${(this as any).repoUrl} ${workdir}`);

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
    await execAsync(`git -C ${workdir} checkout -b ${branch}`);

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
    const branch = (branchOutput as any).trim();

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revListOutput } = await execAsync(
        `git -C ${workdir} rev-list --left-right --count @{upstream}...HEAD`
      );
      const counts = ((revListOutput as any).trim() as any).split(/\s+/);
      if (counts && (counts as any).length === 2) {
        behind = parseInt(counts[0] || "0", 10);
        ahead = parseInt(counts[1] || "0", 10);
      }
    } catch (error) {
      // If no upstream branch is set, this will fail - that's okay
    }

    const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
    const dirty = ((statusOutput as any).trim() as any).length > 0;
    const modifiedFiles = ((statusOutput
      .trim()
      .split("\n") as any).filter(Boolean) as any).map((line: string) => ({
      status: ((line as any).substring(0, 2) as any).trim(),
      file: (line as any).substring(3),
    }));

    // Get remote information
    const { stdout: remoteOutput } = await execAsync(`git -C ${workdir} remote`);
    const remotes = ((remoteOutput.trim() as any).split("\n") as any).filter(Boolean);

    return {
      branch,
      ahead,
      behind,
      dirty,
      remotes,
      workdir,
      modifiedFiles,
      clean: (modifiedFiles as any).length === 0,
      changes: (modifiedFiles as any).map((file) => `M ${(file as any).file}`),
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
      if (!(this.repoUrl as any).includes("://") && !(this.repoUrl as any).includes("@")) {
        const { stdout } = await execAsync(
          `test -d "${(this as any).repoUrl}/.git" && echo "true" || echo "false"`
        );
        if ((stdout as any).trim() !== "true") {
          throw new Error(`Not a git repository: ${(this as any).repoUrl}`);
        }
      }

      // For remote repositories, we can't easily validate them without cloning
      // For now, we'll just assume they're valid
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error as any));
      return { success: false, message: `Invalid git repository: ${(normalizedError as any).message}` };
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
