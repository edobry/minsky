/**
 * Repository Backend Interface
 *
 * Defines a common interface for different repository backend implementations.
 * This allows Minsky to support different repository sources (local git, GitHub, etc.)
 * without changing the core session management logic.
 */

export * from "./RepositoryBackend";

// Import RepositoryStatus but define our own ValidationResult
import type { RepositoryStatus } from "../repository.js";

import { DEFAULT_TIMEOUT_MS } from "../../utils/constants";
import { getErrorMessage } from "../../errors/index";
// Re-export RepositoryStatus
export type { RepositoryStatus };

// Define ValidationResult with compatibility for both interfaces
export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  success?: boolean;
  message?: string;
  error?: Error;
}

// Define RepoStatus as extending RepositoryStatus for backward compatibility
export interface RepoStatus extends RepositoryStatus {
  // Additional fields specific to the original RepoStatus interface
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  remotes: string[];
  [key: string]: any;
}

/**
 * Configuration for repository backends
 */
export interface RepositoryBackendConfig {
  /**
   * The type of repository backend to use
   */
  type: "local" | "remote" | "github";

  /**
   * Repository URL or path
   */
  repoUrl: string;

  /**
   * Branch to checkout (for remote repositories)
   */
  branch?: string;

  /**
   * Remote repository-specific options
   */
  remote?: {
    /**
     * Authentication method to use for remote repositories
     */
    authMethod?: "ssh" | "https" | "token";

    /**
     * Clone depth for shallow clones (default: 1)
     */
    depth?: number;

    /**
     * Number of retry attempts for network operations (default: 3)
     */
    retryAttempts?: number;

    /**
     * Timeout in milliseconds for git operations (default: DEFAULT_TIMEOUT_MS)
     */
    timeout?: number;

    /**
     * Whether to follow redirects when cloning (default: true)
     */
    followRedirects?: boolean;
  };

  /**
   * GitHub-specific options for GitHub backend
   */
  github?: {
    /**
     * GitHub access token for authentication
     */
    token?: string;

    /**
     * GitHub repository owner (organization or user)
     */
    owner?: string;

    /**
     * GitHub repository name
     */
    repo?: string;

    /**
     * GitHub API URL (for GitHub Enterprise)
     */
    apiUrl?: string;

    /**
     * GitHub Enterprise domain (for GitHub Enterprise)
     */
    enterpriseDomain?: string;

    /**
     * Whether to use the GitHub API for operations like PR creation
     */
    useApi?: boolean;
  };
}

/**
 * Repository clone result
 */
export interface CloneResult {
  /**
   * Working directory where the repository was cloned
   */
  workdir: string;

  /**
   * Session identifier
   */
  session: string;
}

/**
 * Repository branch result
 */
export interface BranchResult {
  /**
   * Working directory where the branch was created
   */
  workdir: string;

  /**
   * Branch name
   */
  branch: string;
}

// Completely rewritten repository backend interface with flexible types
export interface RepositoryBackend {
  getType(): string;
  clone(session: string): Promise<CloneResult>;
  branch(session: string, branch: string): Promise<BranchResult>;
  getStatus(session?: string): Promise<any>;
  getPath(session?: string): string | Promise<string>;
  validate(): Promise<any>;
  push(branch?: string): Promise<any>;
  pull(branch?: string): Promise<any>;
  checkout?(branch: string): Promise<void>;
  getConfig?(): RepositoryBackendConfig;
}

/**
 * Repository backend types
 */
export enum RepositoryBackendType {
  LOCAL = "local",
  REMOTE = "remote",
  GITHUB = "github",
}

/**
 * Operation result
 */
export interface Result {
  /**
   * Whether the operation was successful
   */
  success: boolean;

  /**
   * Optional message
   */
  message?: string;

  /**
   * Optional error
   */
  error?: Error;
}

/**
 * Factory function to create a repository backend
 * @param config Repository backend configuration
 * @returns Repository backend instance
 */
export async function createRepositoryBackend(
  config: RepositoryBackendConfig
): Promise<RepositoryBackend> {
  // Validate common configuration
  if (!(config as any).type) {
    throw new Error("Repository backend type is required");
  }

  if (!(config as any).repoUrl) {
    throw new Error("Repository URL is required");
  }

  // Backend-specific validation
  switch ((config as any).type) {
  case (RepositoryBackendType as any).LOCAL: {
    // For local repositories, validate the path exists (if it's a local path)
    if (!(config.repoUrl as any).includes("://") && !(config.repoUrl as any).includes("@")) {
      try {
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const { stdout } = await execAsync(
          `test -d "${(config as any).repoUrl}" && echo "exists" || echo "not exists"`
        );
        if ((stdout as any).trim() === "not exists") {
          throw new Error(`Repository path does not exist: ${(config as any).repoUrl}`);
        }
      } catch (error) {
        throw new Error(`Failed to validate local repository _path: ${getErrorMessage(error as any)}`);
      }
    }

    const { LocalGitBackend } = await import("./local");
    return new LocalGitBackend(config as any);
  }

  case (RepositoryBackendType as any).REMOTE: {
    // For remote repositories, validate URL format and required options
    if (
      !(config.repoUrl as any).startsWith("http://") &&
        !(config.repoUrl as any).startsWith("https://") &&
        !(config.repoUrl as any).startsWith("git@") &&
        !(config.repoUrl as any).startsWith("ssh://")
    ) {
      throw new Error(`Invalid remote repository URL format: ${(config as any).repoUrl}`);
    }

    // Validate remote options if provided
    if ((config as any).remote) {
      if (
        (config.remote as any).authMethod &&
          !(["ssh", "https", "token"] as any).includes((config.remote as any).authMethod)
      ) {
        throw new Error(
          `Invalid auth method: ${(config.remote as any).authMethod}. Must be one of: ssh, https, token`
        );
      }

      if (
        (config.remote as any).depth &&
          (typeof (config.remote as any).depth !== "number" || (config.remote as any).depth < 1)
      ) {
        throw new Error("Clone depth must be a positive number");
      }
    }

    const { RemoteGitBackend } = await import("./remote");
    return new RemoteGitBackend(config as any);
  }

  case (RepositoryBackendType as any).GITHUB: {
    // For GitHub repositories, validate GitHub-specific options
    if ((config as any).github) {
      // If owner and repo are provided, validate them
      if (
        ((config.github as any).owner && !(config.github as any).repo) ||
          (!(config.github as any).owner && (config.github as any).repo)
      ) {
        throw new Error("Both owner and repo must be provided for GitHub repositories");
      }

      // Validate GitHub Enterprise settings if provided
      if ((config.github as any).enterpriseDomain && !(config.github as any).apiUrl) {
        throw new Error("API URL must be provided when using GitHub Enterprise");
      }
    }

    const { GitHubBackend } = await import("./github");
    return new GitHubBackend(config as any);
  }

  default:
    throw new Error(`Unsupported repository backend type: ${(config as any).type}`);
  }
}
