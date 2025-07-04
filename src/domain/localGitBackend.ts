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
import { RepositoryBackendType } from "./repository.js";
import type {
  RepositoryBackend,
  RepositoryConfig,
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
  constructor(__config: RepositoryConfig) {
    this.config = {
      ...__config,
      type: RepositoryBackendType.LOCAL,
    };
    const _xdgStateHome =
      process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(_xdgStateHome, "minsky", "sessions");
    this.cache = RepositoryMetadataCache.getInstance();
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
      return stdout.trim();
    } catch (error) {
      throw new RepositoryError(
        `Git _command failed: ${cmd}`,
        error instanceof Error ? error : undefined
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
    if (!this.config.path) {
      throw new RepositoryError("Local repository path is required for LOCAL backend");
    }

    try {
      // Normalize the repository name
      const repoName = normalizeRepoName(this.config.path);

      // Create the destination directory
      const workdir = this.getSessionWorkdir(session);
      await mkdir(dirname(workdir), { recursive: true });

      // Clone the repository
      await this.execGit(["clone", this.config.path, workdir]);

      // Set the local path
      this.localPath = workdir;

      // Return the clone result
      return {
        workdir,
        session: session,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to clone local repository from ${this.config.path}`,
        error instanceof Error ? error : undefined
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

    return this.cache.get(
      cacheKey,
      async () => {
        try {
          const statusOutput = await this.execGit(["status", "--porcelain"]);
          const branchOutput = await this.execGit(["_branch", "--show-current"]);
          let trackingOutput = "";

          try {
            trackingOutput = await this.execGit(["rev-parse", "--abbrev-ref", "@{upstream}"]);
          } catch (error) {
            // No upstream branch is set, this is not an error
            trackingOutput = "";
          }

          return {
            clean: statusOutput === "",
            changes: statusOutput.split("\n").filter((line) => line !== ""),
            branch: branchOutput,
            tracking: trackingOutput !== "" ? trackingOutput : undefined,
          };
        } catch (error) {
          throw new RepositoryError(
            "Failed to get repository status",
            error instanceof Error ? error : undefined
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
    if (!this.config.path) {
      issues.push("Repository path is required for local Git backend");
      return { valid: false, issues };
    }

    if (!existsSync(this.config.path)) {
      issues.push(`Repository path does not exist: ${this.config.path}`);
      return { valid: false, issues };
    }

    // Check if it's a Git repository
    try {
      await execAsync(`git -C ${this.config.path} rev-parse --git-dir`);
    } catch (error) {
      issues.push(`Not a valid Git repository: ${this.config.path}`);
      return { valid: false, issues };
    }

    return { valid: issues.length === 0, issues: issues.length > 0 ? issues : undefined };
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
      await this.execGit(["push", "origin", branchToPush]);

      // Invalidate status cache after pushing
      this.cache.invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to push branch ${branchToPush}`,
        error instanceof Error ? error : undefined
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
      await this.execGit(["pull", "origin", branchToPull]);

      // Invalidate status cache after pulling
      this.cache.invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to pull branch ${branchToPull}`,
        error instanceof Error ? error : undefined
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
      await this.execGit(["checkout", "-b", name]);

      // Invalidate status cache after branch creation
      this.cache.invalidateByPrefix(generateRepoKey(this.localPath, "status"));

      return {
        workdir: this.localPath,
        _branch: name,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to create branch ${name}`,
        error instanceof Error ? error : undefined
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
      await this.execGit(["checkout", branch]);

      // Invalidate status cache after checkout
      this.cache.invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (error) {
      throw new RepositoryError(
        `Failed to checkout branch ${branch}`,
        error instanceof Error ? error : undefined
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
