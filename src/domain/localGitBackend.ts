/**
 * Local Git backend implementation for Minsky.
 * Manages local Git repositories using the system Git client.
 */

import { exec } from "child_process";
import { DEFAULT_TIMEOUT_MS } from "../utils/constants";
import { promisify } from "util";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { RepositoryBackendType } from "./repository";
import type {
  RepositoryBackend,
  RepositoryConfig,
  RepositoryStatus,
  ValidationResult,
  CloneResult,
  BranchResult,
} from "./repository";
import {
  RepositoryMetadataCache,
  generateRepoKey,
  RepositoryError,
} from "../utils/repository-utils";
import { normalizeRepoName } from "./repo-utils";
import { log } from "../utils/logger";

const execAsync = promisify(exec);

/**
 * LocalGitBackend implements the RepositoryBackend interface for local Git repositories.
 */
export class LocalGitBackend implements RepositoryBackend {
  private readonly config: RepositoryConfig;
  private readonly baseDir: string;
  private localPath: string = "";
  private cache: RepositoryMetadataCache;

  /**
   * Create a new LocalGitBackend.
   *
   * @param config Repository configuration
   */
  constructor(config: RepositoryConfig) {
    this.config = {
      ...config,
      type: (RepositoryBackendType as unknown).LOCAL,
    };
    const _xdgStateHome =
      (process.env as unknown).XDG_STATE_HOME || join((process.env as unknown).HOME || "", ".local/state");
    this.baseDir = join(_xdgStateHome, "minsky", "sessions");
    this.cache = (RepositoryMetadataCache as unknown).getInstance();
  }

  /**
   * Execute a Git command in the specified directory.
   *
   * @param args Git command arguments
   * @param cwd Working directory
   * @returns The command output
   */
  private async execGit(args: string[], cwd?: string): Promise<string> {
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
      return (stdout as unknown).trim();
    } catch (error) {
      throw new RepositoryError(
        `Git _command failed: ${cmd}`,
        error instanceof Error ? error : undefined as unknown
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
  private getSessionWorkdir(session: string): string {
    return join(this.baseDir, "sessions", session);
  }

  /**
   * Clone a local repository to the specified session directory.
   *
   * @param session Session identifier
   * @returns Clone result
   */
  async clone(session: string): Promise<CloneResult> {
    if (!(this.config as unknown).path) {
      throw new RepositoryError("Local repository path is required for LOCAL backend");
    }

    try {
      // Normalize the repository name
      const repoName = normalizeRepoName((this.config as unknown).path);

      // Create the destination directory
      const workdir = this.getSessionWorkdir(session);
      await mkdir(dirname(workdir), { recursive: true });

      // Clone the repository
      await this.execGit(["clone", (this.config as unknown).path, workdir] as any[]);

      // Set the local path
      this.localPath = workdir;

      // Return the clone result
      return {
        workdir,
        session: session,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to clone local repository from ${(this.config as unknown).path}`,
        error instanceof Error ? error : undefined as unknown
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

    return (this.cache as unknown).get(
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
            workdir: this.localPath!,
            clean: statusOutput === "",
            changes: (statusOutput as unknown).split("\n").filter((line) => line !== ""),
            branch: branchOutput,
            tracking: trackingOutput !== "" ? trackingOutput : undefined as unknown,
          };
        } catch (error) {
          throw new RepositoryError(
            "Failed to get repository status",
            error instanceof Error ? error : undefined as unknown
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

    // Check if the repository path exists
    if (!(this.config as unknown).path) {
      (issues as unknown).push("Repository path is required for local Git backend");
      return { valid: false, issues };
    }

    if (!existsSync((this.config as unknown).path)) {
      (issues as unknown).push(`Repository path does not exist: ${(this.config as unknown).path}`);
      return { valid: false, issues };
    }

    // Check if it's a Git repository
    try {
      await execAsync(`git -C ${(this.config as unknown).path} rev-parse --git-dir`);
    } catch (error) {
      (issues as unknown).push(`Not a valid Git repository: ${(this.config as unknown).path}`);
      return { valid: false, issues };
    }

    return { valid: (issues as unknown).length === 0, issues: (issues as unknown).length > 0 ? issues : undefined as unknown };
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
      (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to push branch ${branchToPush}`,
        error instanceof Error ? error : undefined as unknown
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
      (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to pull branch ${branchToPull}`,
        error instanceof Error ? error : undefined as unknown
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
  async branch(session: string, name: string): Promise<BranchResult> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    try {
      await this.execGit(["checkout", "-b", name] as any[]);

      // Invalidate status cache after branch creation
      (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));

      return {
        workdir: this.localPath!,
        branch: name,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to create branch ${name}`,
        error instanceof Error ? error : undefined as unknown
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
      (this.cache as unknown).invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to checkout branch ${branch}`,
        error instanceof Error ? error : undefined as unknown
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
