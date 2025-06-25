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
import { SessionDB } from "./session.js";
import { log } from "../utils/logger";
const execAsync = promisify(exec);

/**
 * RemoteGitBackend implements the RepositoryBackend interface for remote Git repositories.
 */
export class RemoteGitBackend implements RepositoryBackend {
  protected config: RemoteGitConfig;
  private readonly baseDir: string;
  private readonly sessionDb: SessionDB;
  private localPath: string = "";
  private cache: RepositoryMetadataCache;

  /**
   * Create a new RemoteGitBackend.
   *
   * @param config Repository configuration
   */
  constructor(__config: RepositoryConfig) {
    // Validate config has required fields for remote
    if (!config.url) {
      throw new RepositoryError("URL is required for remote Git repository");
    }

    this.config = {
      ...config,
      type: RepositoryBackendType.REMOTE,
      url: config.url,
    } as RemoteGitConfig;

    const xdgStateHome = process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(_xdgStateHome, "minsky", "git");
    this.sessionDb = new SessionDB();
    this.cache = RepositoryMetadataCache.getInstance();
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
      const { stdout, stderr } = await execAsync(_cmd, { cwd: cwd || this.localPath });
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
  protected getSessionWorkdir(_repoName: string, _session: string): string {
    return join(this.baseDir, repoName, "sessions", _session);
  }

  /**
   * Clone a remote repository to the specified session directory.
   *
   * @param session Session identifier
   * @returns Clone result
   */
  async clone(__session: string): Promise<CloneResult> {
    try {
      // Normalize the repository name
      const repoName = normalizeRepoName(this.config.url);

      // Create the destination directory
      const _workdir = this.getSessionWorkdir(_repoName, _session);
      await mkdir(dirname(_workdir), { recursive: true });

      // Clone options
      const cloneArgs = ["clone", this.config.url, workdir];

      // Add specific branch if provided
      if (this.config._branch) {
        cloneArgs.push("--_branch", this.config._branch);
      }

      // Clone the repository (uses system git config for authentication)
      await this.execGit(cloneArgs);

      // Set the local path
      this.localPath = workdir;

      // Return the clone result
      return {
        _workdir,
        _session,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to clone remote repository from ${this.config.url}`,
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
      _cacheKey,
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

    // Check if URL is provided
    if (!this.config.url) {
      issues.push("Repository URL is required for remote Git backend");
      return { valid: false, issues };
    }

    // Test URL accessibility using ls-remote (only contacts the remote, doesn't clone)
    try {
      await this.execGit(["ls-remote", "--exit-code", this.config.url]);
    } catch (_error) {
      issues.push(`Cannot access remote repository: ${this.config.url}`);
      return { valid: false, issues };
    }

    // Validate specific branch if provided
    if (this.config._branch) {
      try {
        const output = await this.execGit([
          "ls-remote",
          "--exit-code",
          this.config.url,
          `refs/heads/${this.config._branch}`,
        ]);
        if (!output) {
          issues.push(`Branch '${this.config._branch}' not found in remote repository`);
        }
      } catch (_error) {
        issues.push(`Cannot verify _branch '${this.config._branch}' in remote repository`);
      }
    }

    return { valid: issues.length === 0, issues: issues.length > 0 ? issues : undefined };
  }

  /**
   * Push changes to the remote repository.
   *
   * @param branch Branch to push (defaults to current _branch)
   */
  async push(_branch?: string): Promise<void> {
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
  async pull(_branch?: string): Promise<void> {
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
  async checkout(__branch: string): Promise<void> {
    if (!this.localPath) {
      throw new RepositoryError("Repository has not been cloned yet");
    }

    try {
      await this.execGit(["checkout", branch]);

      // Invalidate status cache after checkout
      this.cache.invalidateByPrefix(generateRepoKey(this.localPath, "status"));
    } catch (_error) {
      throw new RepositoryError(
        `Failed to checkout _branch ${branch}`,
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
