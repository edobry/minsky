/**
 * Repository backend interface for Minsky.
 * Defines the contract for different repository backends (local, remote, GitHub).
 */
import { normalizeRepoName } from "./repo-utils";
import { normalizeRepositoryUri, detectRepositoryFromCwd, UriFormat } from "./uri-utils";
import { createSessionProvider } from "./session";
import { getCurrentWorkingDirectory } from "../utils/process";
import {ValidationError, MinskyError, getErrorMessage} from "../errors/index";
import { log } from "../utils/logger";

/**
 * Repository backend types supported by the system.
 */
export enum RepositoryBackendType {
  LOCAL = "local",
  REMOTE = "remote", 
  GITHUB = "github"
}

/**
 * Repository resolution options.
 */
export interface RepositoryResolutionOptions {
  /**
   * Explicit repository URI or path
   */
  uri?: string;

  /**
   * Session name to resolve the repository from
   */
  session?: string;

  /**
   * Task ID to resolve the repository from
   */
  taskId?: string;

  /**
   * Whether to auto-detect the repository from the current directory
   * Default: true if no other options are provided
   */
  autoDetect?: boolean;

  /**
   * Current working directory for auto-detection
   * Default: process.cwd()
   */
  cwd?: string;
}

/**
 * Resolved repository information.
 */
export interface ResolvedRepository {
  /**
   * The repository URI
   */
  uri: string;

  /**
   * The normalized repository name (org/repo or local/repo)
   */
  name: string;

  /**
   * Whether this is a local repository
   */
  isLocal: boolean;

  /**
   * The repository path for local repositories
   */
  path?: string;

  /**
   * The repository backend type
   */
  backendType: RepositoryBackendType;

  /**
   * Repository format (HTTPS, SSH, etc.)
   */
  format: UriFormat;
}

/**
 * Status information about a repository.
 */
export interface RepositoryStatus {
  clean: boolean;
  changes: string[];
  branch: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  remotes?: string[];
  modifiedFiles?: Array<{ status: string; file: string }>;
  [key: string]: any;
}

/**
 * Base repository configuration.
 */
export interface RepositoryConfig {
  type: RepositoryBackendType | "local" | "remote" | "github";
  path?: string; // Local repository path
  url?: string; // Remote repository URL
  branch?: string; // Branch to checkout
}

/**
 * Remote Git repository configuration.
 */
export interface RemoteGitConfig extends RepositoryConfig {
  type: RepositoryBackendType.REMOTE;
  url: string; // Required for remote repositories
  branch?: string; // Branch to checkout
}

/**
 * GitHub repository configuration.
 */
export interface GitHubConfig extends Omit<RemoteGitConfig, "type"> {
  type: RepositoryBackendType.GITHUB;
  owner?: string; // GitHub repository owner
  repo?: string; // GitHub repository name
  token?: string; // GitHub access token (optional, uses git config if not provided)
}

/**
 * Repository validation result.
 */
export interface ValidationResult {
  valid: boolean;
  issues?: string[];
  // Additional fields to align with Result interface
  success?: boolean;
  message?: string;
  error?: Error;
}

/**
 * Repository clone result.
 */
export interface CloneResult {
  workdir: string; // Local working directory path
  session: string; // Session identifier
}

/**
 * Branch operation result.
 */
export interface BranchResult {
  workdir: string; // Local working directory path
  branch: string; // Created/checked out branch name
}

/**
 * Repository backend interface.
 * All repository operations should be implemented by backend classes.
 */
export interface RepositoryBackend {
  /**
   * Clone the repository to the specified destination.
   * @param session Session identifier
   * @returns CloneResult with working directory information
   */
  clone(session: string): Promise<CloneResult>;

  /**
   * Get the status of the repository.
   * @param session Optional session identifier
   * @returns RepositoryStatus with clean state, changes, and branch information
   */
  getStatus(session?: string): Promise<any>;

  /**
   * Get the local path of the repository.
   * @param session Optional session identifier
   * @returns The local repository path (or Promise resolving to path)
   */
  getPath(session?: string): string | Promise<string>;

  /**
   * Validate the repository configuration.
   * @returns ValidationResult indicating if the repository is valid
   */
  validate(): Promise<any>;

  /**
   * Push changes to the remote repository.
   * @param branch Branch to push (defaults to current _branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  push(branch?: string): Promise<any>;

  /**
   * Pull changes from the remote repository.
   * @param branch Branch to pull (defaults to current _branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  pull(branch?: string): Promise<any>;

  /**
   * Create a new branch and switch to it.
   * @param session Session identifier
   * @param name Branch name to create
   * @returns BranchResult with working directory and branch information
   */
  branch(session: string, name: string): Promise<BranchResult>;

  /**
   * Checkout an existing branch.
   * @param branch Branch name to checkout
   * @returns void
   */
  checkout(branch: string): Promise<void>;

  /**
   * Get the repository configuration.
   * @returns The repository configuration
   */
  getConfig(): RepositoryConfig;
}

/**
 * Alias for backward compatibility with existing code.
 */
export type RepositoryBackendConfig = RepositoryConfig;

/**
 * Create a repository backend instance based on the provided configuration.
 *
 * @param config Repository configuration
 * @returns RepositoryBackend instance
 */
export async function createRepositoryBackend(
  config: RepositoryConfig
): Promise<RepositoryBackend> {
  switch ((config as unknown).type) {
  case (RepositoryBackendType as unknown).LOCAL: {
    const { LocalGitBackend } = await import("./localGitBackend.js");
    return new LocalGitBackend(config as unknown);
  }
  case (RepositoryBackendType as unknown).REMOTE: {
    const { RemoteGitBackend } = await import("./remoteGitBackend.js");
    return new RemoteGitBackend(config as unknown);
  }
  case (RepositoryBackendType as unknown).GITHUB: {
    const { GitService } = await import("./git.js");
    const gitService = new GitService();

    // Create an adapter using GitService that conforms to RepositoryBackend interface
    return {
      clone: async (session: string): Promise<CloneResult> => {
        const workdir = (gitService as unknown).getSessionWorkdir(session);
        return await (gitService as unknown).clone({
          repoUrl: (config as unknown).url || "",
          session,
          workdir,
        });
      },

      getStatus: async (session?: string): Promise<RepositoryStatus> => {
        // If no session is provided, work with the most recent session
        if (!session) {
          const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
          const sessions = await (sessionDb as unknown).listSessions();
          const repoName = normalizeRepoName((config as unknown).url || "");
          const repoSession = (sessions as unknown).find((s) => (s as unknown).repoName === repoName);
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          session = (repoSession as unknown).session;
        }

        const repoName = normalizeRepoName((config as unknown).url || "");
        const workdir = (gitService as unknown).getSessionWorkdir(session);

        const gitStatus = await (gitService as unknown).getStatus(workdir);

        // Get additional status info directly via Git commands
        const { stdout: branchOutput } = await (
          await import("util")
        ).promisify(((await import("child_process")) as unknown).exec)(
          `git -C ${workdir} rev-parse --abbrev-ref HEAD`
        );

        const branch = (branchOutput as unknown).trim();
        return {
          clean: (gitStatus.modified as unknown).length === 0 && (gitStatus.untracked as unknown).length === 0,
          changes: [
            ...(gitStatus.modified as unknown).map((file) => `M ${file}`),
            ...(gitStatus.untracked as unknown).map((file) => `?? ${file}`),
            ...(gitStatus.deleted as unknown).map((file) => `D ${file}`),
          ],
          branch,
          // Add other required fields from RepositoryStatus
          modifiedFiles: [
            ...(gitStatus.modified as unknown).map((file) => ({ status: "M", file })),
            ...(gitStatus.untracked as unknown).map((file) => ({ status: "??", file })),
            ...(gitStatus.deleted as unknown).map((file) => ({ status: "D", file })),
          ],
          dirty: (gitStatus.modified as unknown).length > 0 || (gitStatus.untracked as unknown).length > 0,
        };
      },

      getPath: async (session?: string): Promise<string> => {
        // If no session is provided, work with the most recent session
        if (!session) {
          const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
          const sessions = await (sessionDb as unknown).listSessions();
          const repoName = normalizeRepoName((config as unknown).url || "");
          const repoSession = (sessions as unknown).find((s) => (s as unknown).repoName === repoName);
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          session = (repoSession as unknown).session;
        }

        const repoName = normalizeRepoName((config as unknown).url || "");
        return (gitService as unknown).getSessionWorkdir(session);
      },

      validate: async (): Promise<ValidationResult> => {
        // Basic validation of the GitHub configuration
        if (!(config as unknown).url) {
          return {
            valid: false,
            issues: ["Repository URL is required"],
            success: false,
            message: "Repository URL is required",
          };
        }

        return {
          valid: true,
          success: true,
          message: "GitHub configuration is valid",
        };
      },

      push: async (branch?: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
        const sessions = await (sessionDb as unknown).listSessions();
        const repoName = normalizeRepoName((config as unknown).url || "");
        const repoSession = (sessions as unknown).find((s) => (s as unknown).repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const sessionName = (repoSession as unknown).session;
        const workdir = (gitService as unknown).getSessionWorkdir(sessionName);

        await (gitService as unknown).push({
          session: sessionName,
          repoPath: workdir,
        });
      },

      pull: async (branch?: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
        const sessions = await (sessionDb as unknown).listSessions();
        const repoName = normalizeRepoName((config as unknown).url || "");
        const repoSession = (sessions as unknown).find((s) => (s as unknown).repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const workdir = (gitService as unknown).getSessionWorkdir((repoSession as unknown).session);
        await (gitService as unknown).pullLatest(workdir);
      },

      branch: async (session: string, name: string): Promise<BranchResult> => {
        const repoName = normalizeRepoName((config as unknown).url || "");
        const workdir = (gitService as unknown).getSessionWorkdir(session);

        // Execute branch creation via Git command
        await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
          `git -C ${workdir} checkout -b ${name}`
        );

        return {
          workdir,
          branch: name,
        };
      },

      checkout: async (branch: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
        const sessions = await (sessionDb as unknown).listSessions();
        const repoName = normalizeRepoName((config as unknown).url || "");
        const repoSession = (sessions as unknown).find((s) => (s as unknown).repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const workdir = (gitService as unknown).getSessionWorkdir((repoSession as unknown).session);

        // Execute checkout via Git command
        await (await import("util")).promisify(((await import("child_process")) as unknown).exec)(
          `git -C ${workdir} checkout ${branch}`
        );
      },

      getConfig: (): RepositoryConfig => {
        return {
          type: (RepositoryBackendType as unknown).GITHUB,
          url: (config as unknown).url,
          owner: (config as GitHubConfig).owner,
          repo: (config as GitHubConfig).repo,
          token: (config as GitHubConfig).token,
        } as RepositoryConfig;
      },
    };
  }
  default: {
    throw new Error(`Unsupported repository backend type: ${(config as unknown).type}`);
  }
  }
}

/**
 * Resolves a repository reference to a canonical URI and normalized name.
 *
 * Resolution strategy:
 * 1. If explicit URI is provided, use it
 * 2. If session is specified, get repository from the session
 * 3. If task ID is specified, find the associated session's repository
 * 4. If auto-detection is enabled, try to find repository from current directory
 * DEFAULT_RETRY_COUNT. Otherwise throw an error
 *
 * @param options Resolution options
 * @returns Resolved repository information
 * @throws ValidationError if repository cannot be resolved
 */
export async function resolveRepository(
  options: RepositoryResolutionOptions = {}
): Promise<ResolvedRepository> {
  const { uri, session, taskId, autoDetect = true, cwd = getCurrentWorkingDirectory() } = options;

  let repositoryUri: string | undefined;
  let backendType = (RepositoryBackendType as unknown).LOCAL;

  // 1. Try to resolve from explicit URI
  if (uri) {
    repositoryUri = uri;
  }
  // 2. Try to resolve from session
  else if (session) {
    const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
    const sessionRecord = await (sessionDb as unknown).getSession(session);
    if (!sessionRecord) {
      throw new ValidationError(`Session not found: ${session}`);
    }
    repositoryUri = (sessionRecord as unknown).repoUrl;
    backendType =
      ((sessionRecord as unknown).backendType as RepositoryBackendType) || (RepositoryBackendType as unknown).LOCAL;
  }
  // 3. Try to resolve from task ID
  else if (taskId) {
    const normalizedTaskId = taskId.startsWith("#") ? taskId : `#${taskId}`;
    const sessionDb = new ((await import("./session.js")) as unknown).SessionDB();
    const sessionRecord = await (sessionDb as unknown).getSessionByTaskId(normalizedTaskId);
    if (!sessionRecord) {
      throw new ValidationError(`No session found for task: ${taskId}`);
    }
    repositoryUri = (sessionRecord as unknown).repoUrl;
    backendType =
      ((sessionRecord as unknown).backendType as RepositoryBackendType) || (RepositoryBackendType as unknown).LOCAL;
  }
  // 4. Try auto-detection from current directory
  else if (autoDetect) {
    repositoryUri = await detectRepositoryFromCwd(cwd);
    if (!repositoryUri) {
      throw new ValidationError("No Git repository found in current directory");
    }
  }
  // DEFAULT_RETRY_COUNT. No resolution method available
  else {
    throw new ValidationError(
      "Cannot resolve repository: no URI, session, or task ID provided, and auto-detection is disabled"
    );
  }

  // Normalize the repository URI
  try {
    const normalized = normalizeRepositoryUri(repositoryUri as string, {
      validateLocalExists: true,
      ensureFullyQualified: true,
    });

    // Determine backend type based on URI format
    if ((normalized as unknown).isLocal) {
      backendType = (RepositoryBackendType as unknown).LOCAL;
    } else {
      // Default to GITHUB for remote repositories unless specified otherwise
      if (backendType === (RepositoryBackendType as unknown).LOCAL) {
        backendType = (RepositoryBackendType as unknown).GITHUB;
      }
    }

    // For local repositories, extract the path
    let path: string | undefined;
    if ((normalized as unknown).isLocal) {
      path =
        (normalized as unknown).format === UriFormat.FILE
          ? (normalized.uri as unknown).replace(/^file:\/\//, "")
          : (normalized as unknown).uri;
    }

    return {
      uri: (normalized as unknown).uri,
      name: (normalized as unknown).name,
      isLocal: (normalized as unknown).isLocal,
      path,
      backendType,
      format: (normalized as unknown).format,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`Invalid repository URI: ${repositoryUri}`);
  }
}

/**
 * Deprecated: Use resolveRepository instead.
 * This is kept for backward compatibility.
 */
export async function resolveRepoPath(options: {
  session?: string;
  repo?: string;
}): Promise<string> {
  log.warn("resolveRepoPath is deprecated. Use resolveRepository instead.");

  try {
    const repository = await resolveRepository({
      uri: (options as unknown).repo,
      session: (options as unknown).session,
      autoDetect: true,
    });

    if ((repository as unknown).isLocal) {
      return (repository as unknown).path || "";
    } else {
      // For backward compatibility, return the URI for remote repositories
      return (repository as unknown).uri;
    }
  } catch (error) {
    throw new MinskyError(
      `Failed to resolve repository _path: ${getErrorMessage(error as any)}`
    );
  }
}
