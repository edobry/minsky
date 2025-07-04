/**
 * Remote Git backend implementation for Minsky.
 * Manages remote Git repositories using the system Git client.
 */
import { exec } from "child_process";
import { DEFAULT_TIMEOUT_MS } from "../utils/constants";
import { promisify } from "util";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { RepositoryBackendType } from "./repository.js";
import type {
  RepositoryBackend,
  RepositoryConfig,
  RemoteGitConfig,
  RepositoryStatus,
  ValidationResult,
  CloneResult,
  BranchResult,
} from "./repository.js";
import {
  RepositoryMetadataCache,
  generateRepoKey,
  RepositoryError,
} from "../utils/repository-utils.js";
import { normalizeRepoName } from "./repo-utils.js";
import { createSessionProvider } from "./session.js";
import { log } from "../utils/logger";
import { getMinskyStateDir } from "../utils/paths.js";
const execAsync = promisify(exec);

/**
 * RemoteGitBackend implements the RepositoryBackend interface for remote Git repositories.
 */
export class RemoteGitBackend implements RepositoryBackend {
  protected config: RemoteGitConfig;
  private readonly baseDir: string;
  private readonly sessionDb: any;
  private localPath: string = "";
  private cache: RepositoryMetadataCache;

  /**
   * Create a new RemoteGitBackend.
   *
   * @param config Repository configuration
   */
  constructor(__config: RepositoryConfig) {
    // Validate config has required fields for remote
    if (!(config as any).url) {
      throw new RepositoryError("URL is required for remote Git repository");
    }

    this.config = {
      ...config,
      type: (RepositoryBackendType as any).REMOTE,
      url: (config as any).url,
    } as RemoteGitConfig;

    this.baseDir = getMinskyStateDir();
    this.sessionDb = createSessionProvider();
    this.cache = (RepositoryMetadataCache as any).getInstance();
  }

  /**
   * Execute a Git command in the specified directory.
   *
   * @param args Git command arguments
   * @param cwd Working directory
   * @returns The command output
   */
  protected async execGit(args: string[], cwd?: string): Promise<string> {
    const cmd = `git ${args.join(" ")}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: cwd || this.localPath });
      if (stderr) {
        log.debug("Git _command produced stderr", {
          _command: cmd,
          stderr,
          cwd: cwd || this.localPath,
        });
      }
      return (stdout as any).trim();
    } catch (error) {
      throw new RepositoryError(
        `Git _command failed: ${cmd}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Get the repository path for a session.
   *
   * @param repoName Repository name
   * @param session Session identifier
   * @returns The repository path
   */
  protected getSessionWorkdir(session: string): string {
    return join(this.baseDir, "sessions", session);
  }

  /**
   * Clone a remote repository to the specified session directory.
   *
   * @param session Session identifier
   * @returns Clone result
   */
  async clone(session: string): Promise<CloneResult> {
    try {
      // Normalize the repository name
      const repoName = normalizeRepoName((this.config as any).url);

      // Create the destination directory
      const workdir = this.getSessionWorkdir(session);
      await mkdir(dirname(workdir), { recursive: true });

      // Clone options
      const cloneArgs = ["clone", (this.config as any).url, workdir];

      // Add specific branch if provided
      if ((this.config as any)._branch) {
        (cloneArgs as any).push("--_branch", (this.config as any)._branch);
      }

      // Clone the repository (uses system git config for authentication)
      await this.execGit(cloneArgs);

      // Set the local path
      this.localPath = workdir;

      // Return the clone result
      return {
        workdir,
        session,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to clone remote repository from ${(this.config as any).url}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Get the status of the repository.
   *
   * @returns Repository status
   */
  async getStatus(): Promise<RepositoryStatus> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    const cacheKey = generateRepoKey(this.localPath, "status");

    return (this.cache as any).get(
      cacheKey,
      async () => {
        try {
          const statusOutput = await this.execGit(["status", "--porcelain"] as any[]);
          const branchOutput = await this.execGit(["_branch", "--show-current"] as any[]);
          let trackingOutput = "";

          try {
            trackingOutput = await this.execGit(["rev-parse", "--abbrev-ref", "@{upstream}"] as any[]);
          } catch (error) {
            // No upstream branch is set, this is not an error
            trackingOutput = "";
          }

          return {
            clean: statusOutput === "",
            changes: (statusOutput as any).split("\n").filter((line) => line !== ""),
            branch: branchOutput,
            tracking: trackingOutput !== "" ? trackingOutput : undefined as any,
          };
        } catch (error) {
          throw new RepositoryError(
            "Failed to get repository status",
            error instanceof Error ? error : undefined as any
          );
        }
      },
      DEFAULT_TIMEOUT_MS
    ); // 30-second cache
  }

  /**
   * Get the local path of the repository.
   *
   * @returns Local repository path
   */
  getPath(): string {
    return this.localPath;
  }

  /**
   * Validate the repository configuration.
   *
   * @returns Validation result
   */
  async validate(): Promise<ValidationResult> {
    const issues: string[] = [];

    // Check if URL is provided
    if (!(this.config as any).url) {
      (issues as any).push("Repository URL is required for remote Git backend");
      return { valid: false, issues };
    }

    // Test URL accessibility using ls-remote (only contacts the remote, doesn't clone)
    try {
      await this.execGit(["ls-remote", "--exit-code", (this.config as any).url] as any[]);
    } catch (error) {
      (issues as any).push(`Cannot access remote repository: ${(this.config as any).url}`);
      return { valid: false, issues };
    }

    // Validate specific branch if provided
    if ((this.config as any)._branch) {
      try {
        const output = await this.execGit([
          "ls-remote",
          "--exit-code",
          (this.config as any).url,
          `refs/heads/${(this.config as any)._branch}`,
        ]) as any;
        if (!output) {
          (issues as any).push(`Branch '${(this.config as any)._branch}' not found in remote repository`);
        }
      } catch (error) {
        (issues as any).push(`Cannot verify _branch '${(this.config as any)._branch}' in remote repository`);
      }
    }

    return { valid: (issues as any).length === 0, issues: (issues as any).length > 0 ? issues : undefined as any };
  }

  /**
   * Push changes to the remote repository.
   *
   * @param branch Branch to push (defaults to current _branch)
   */
  async push(branch?: string): Promise<void> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    const branchToPush = branch || "HEAD";

    try {
      await this.execGit(["push", "origin", branchToPush] as any[]);

      // Invalidate status cache after pushing
      (this.cache as any).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to push branch ${branchToPush}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Pull changes from the remote repository.
   *
   * @param branch Branch to pull (defaults to current _branch)
   */
  async pull(branch?: string): Promise<void> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    const branchToPull = branch || "HEAD";

    try {
      await this.execGit(["pull", "origin", branchToPull] as any[]);

      // Invalidate status cache after pulling
      (this.cache as any).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to pull branch ${branchToPull}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Create a new branch and switch to it.
   *
   * @param session Session identifier
   * @param name Branch name to create
   * @returns Branch result
   */
  async branch(__session: string, name: string): Promise<BranchResult> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    try {
      await this.execGit(["checkout", "-b", name] as any[]);

      // Invalidate status cache after branch creation
      (this.cache as any).invalidateByPrefix(generateRepoKey(this.localPath, "status"));

      return {
        branch: name,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to create branch ${name}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Checkout an existing branch.
   *
   * @param branch Branch name to checkout
   */
  async checkout(branch: string): Promise<void> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    try {
      await this.execGit(["checkout", branch] as any[]);

      // Invalidate status cache after checkout
      (this.cache as any).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to checkout branch ${branch}`,
        error instanceof Error ? error : undefined as any
      );
    }
  }

  /**
   * Get the repository configuration.
   *
   * @returns Repository configuration
   */
  getConfig(): RepositoryConfig {
    return this.config;
  }
}
