/**
 * Repository backend interface for Minsky.
 * Defines the contract for different repository backends (local, remote, GitHub).
 */
import { normalizeRepoName } from "./repo-utils.js";
import { normalizeRepositoryUri, detectRepositoryFromCwd, UriFormat } from "./uri-utils.js";
import { SessionDB } from "./session.js";
import { getCurrentWorkingDirectory } from "../utils/process.js";
import { ValidationError, MinskyError } from "../errors/index.js";
import { log } from "../utils/logger.js";

/**
 * Repository backend types supported by the system.
 */
export enum RepositoryBackendType {}
// Enum values removed as they are unused

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
  [key: string]: unknown;
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
  clone(__session: string): Promise<CloneResult>;

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
  push(_branch?: string): Promise<any>;

  /**
   * Pull changes from the remote repository.
   * @param branch Branch to pull (defaults to current _branch)
   * @returns Result of the operation (may be void or a more detailed result)
   */
  pull(_branch?: string): Promise<any>;

  /**
   * Create a new branch and switch to it.
   * @param session Session identifier
   * @param name Branch name to create
   * @returns BranchResult with working directory and branch information
   */
  branch(__session: string, name: string): Promise<BranchResult>;

  /**
   * Checkout an existing branch.
   * @param branch Branch name to checkout
   * @returns void
   */
  checkout(__branch: string): Promise<void>;

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
  switch (config.type) {
  case RepositoryBackendType.LOCAL: {
    const { LocalGitBackend } = await import("./localGitBackend.js");
    return new LocalGitBackend(config);
  }
  case RepositoryBackendType.REMOTE: {
    const { RemoteGitBackend } = await import("./remoteGitBackend.js");
    return new RemoteGitBackend(config);
  }
  case RepositoryBackendType.GITHUB: {
    const { GitService } = await import("./git.js");
    const gitService = new GitService();

    // Create an adapter using GitService that conforms to RepositoryBackend interface
    return {
      clone: async (_session: string): Promise<CloneResult> => {
        return await gitService.clone({
          repoUrl: config.url || "",
          _session,
          github: {
            token: (config as GitHubConfig).token,
            owner: (config as GitHubConfig).owner,
            repo: (config as GitHubConfig).repo,
          },
        });
      },

      getStatus: async (session?: string): Promise<RepositoryStatus> => {
        // If no session is provided, work with the most recent session
        if (!session) {
          const sessionDb = new (await import("./session.js")).SessionDB();
          const sessions = await sessionDb.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find((s) => s.repoName === repoName);
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          session = repoSession.session;
        }

        const repoName = normalizeRepoName(config.url || "");
        const _workdir = gitService.getSessionWorkdir(_repoName, _session);

        const gitStatus = await gitService.getStatus(_workdir);

        // Get additional status info directly via Git commands
        const { stdout: branchOutput } = await (
          await import("util")
        ).promisify((await import("child_process")).exec)(
          `git -C ${workdir} rev-parse --abbrev-ref HEAD`
        );

        const _branch = branchOutput.trim();
        return {
          clean: gitStatus.modified.length === 0 && gitStatus.untracked.length === 0,
          changes: [
            ...gitStatus.modified.map((file) => `M ${file}`),
            ...gitStatus.untracked.map((file) => `?? ${file}`),
            ...gitStatus.deleted.map((file) => `D ${file}`),
          ],
          branch,
          // Add other required fields from RepositoryStatus
          modifiedFiles: [
            ...gitStatus.modified.map((file) => ({ status: "M", file })),
            ...gitStatus.untracked.map((file) => ({ status: "??", file })),
            ...gitStatus.deleted.map((file) => ({ status: "D", file })),
          ],
          dirty: gitStatus.modified.length > 0 || gitStatus.untracked.length > 0,
        };
      },

      getPath: async (session?: string): Promise<string> => {
        // If no session is provided, work with the most recent session
        if (!session) {
          const sessionDb = new (await import("./session.js")).SessionDB();
          const sessions = await sessionDb.listSessions();
          const repoName = normalizeRepoName(config.url || "");
          const repoSession = sessions.find((s) => s.repoName === repoName);
          if (!repoSession) {
            throw new Error("No session found for this repository");
          }
          session = repoSession.session;
        }

        const repoName = normalizeRepoName(config.url || "");
        return gitService.getSessionWorkdir(_repoName, _session);
      },

      validate: async (): Promise<ValidationResult> => {
        // Basic validation of the GitHub configuration
        if (!config.url) {
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

      push: async (_branch?: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new (await import("./session.js")).SessionDB();
        const sessions = await sessionDb.listSessions();
        const repoName = normalizeRepoName(config.url || "");
        const repoSession = sessions.find((s) => s.repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const _session = repoSession.session;
        const _workdir = gitService.getSessionWorkdir(_repoName, _session);

        await gitService.push({
          _session,
          _repoPath: workdir,
        });
      },

      pull: async (_branch?: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new (await import("./session.js")).SessionDB();
        const sessions = await sessionDb.listSessions();
        const repoName = normalizeRepoName(config.url || "");
        const repoSession = sessions.find((s) => s.repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const _workdir = gitService.getSessionWorkdir(_repoName, repoSession._session);
        await gitService.pullLatest(_workdir);
      },

      branch: async (_session: string, name: string): Promise<BranchResult> => {
        const repoName = normalizeRepoName(config.url || "");
        const _workdir = gitService.getSessionWorkdir(_repoName, _session);

        // Execute branch creation via Git command
        await (await import("util")).promisify((await import("child_process")).exec)(
          `git -C ${workdir} checkout -b ${name}`
        );

        return {
          _workdir,
          _branch: name,
        };
      },

      checkout: async (_branch: string): Promise<void> => {
        // Find an existing session for this repository
        const sessionDb = new (await import("./session.js")).SessionDB();
        const sessions = await sessionDb.listSessions();
        const repoName = normalizeRepoName(config.url || "");
        const repoSession = sessions.find((s) => s.repoName === repoName);

        if (!repoSession) {
          throw new Error("No session found for this repository");
        }

        const _workdir = gitService.getSessionWorkdir(_repoName, repoSession._session);

        // Execute checkout via Git command
        await (await import("util")).promisify((await import("child_process")).exec)(
          `git -C ${workdir} checkout ${branch}`
        );
      },

      getConfig: (): RepositoryConfig => {
        return {
          type: RepositoryBackendType.GITHUB,
          url: config.url,
          owner: (config as GitHubConfig).owner,
          repo: (config as GitHubConfig).repo,
          token: (config as GitHubConfig).token,
        } as RepositoryConfig;
      },
    };
  }
  default: {
    throw new Error(`Unsupported repository backend type: ${config.type}`);
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
  let backendType = RepositoryBackendType.LOCAL;

  // 1. Try to resolve from explicit URI
  if (uri) {
    repositoryUri = uri;
  }
  // 2. Try to resolve from session
  else if (session) {
    const sessionDb = new SessionDB();
    const sessionRecord = await sessionDb.getSession(_session);
    if (!sessionRecord) {
      throw new ValidationError(`Session not found: ${session}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType =
      (sessionRecord.backendType as RepositoryBackendType) || RepositoryBackendType.LOCAL;
  }
  // 3. Try to resolve from task ID
  else if (_taskId) {
    const normalizedTaskId = taskId.startsWith("#") ? taskId : `#${taskId}`;
    const sessionDb = new SessionDB();
    const sessionRecord = await sessionDb.getSessionByTaskId(normalizedTaskId);
    if (!sessionRecord) {
      throw new ValidationError(`No session found for task: ${taskId}`);
    }
    repositoryUri = sessionRecord.repoUrl;
    backendType =
      (sessionRecord.backendType as RepositoryBackendType) || RepositoryBackendType.LOCAL;
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
      "Cannot resolve repository: no URI, _session, or task ID provided, and auto-detection is disabled"
    );
  }

  // Normalize the repository URI
  try {
    const normalized = normalizeRepositoryUri(repositoryUri as string, {
      validateLocalExists: true,
      ensureFullyQualified: true,
    });

    // Determine backend type based on URI format
    if (normalized.isLocal) {
      backendType = RepositoryBackendType.LOCAL;
    } else {
      // Default to GITHUB for remote repositories unless specified otherwise
      if (backendType === RepositoryBackendType.LOCAL) {
        backendType = RepositoryBackendType.GITHUB;
      }
    }

    // For local repositories, extract the path
    let path: string | undefined;
    if (normalized.isLocal) {
      path =
        normalized.format === UriFormat.FILE
          ? normalized.uri.replace(/^file:\/\//, "")
          : normalized.uri;
    }

    return {
      uri: normalized.uri,
      name: normalized.name,
      isLocal: normalized.isLocal,
      path,
      backendType,
      format: normalized.format,
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
      uri: options.repo,
      session: options.session,
      autoDetect: true,
    });

    if (repository.isLocal) {
      return repository.path || "";
    } else {
      // For backward compatibility, return the URI for remote repositories
      return repository.uri;
    }
  } catch (error) {
    throw new MinskyError(
      `Failed to resolve repository _path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
