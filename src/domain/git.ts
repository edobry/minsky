import { join } from "node:path";
import { HTTP_OK, BYTES_PER_KB } from "../utils/constants";
import { mkdir } from "node:fs/promises";
import type {} from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";
import { TaskService, TASK_STATUS } from "./tasks";
import { MinskyError } from "../errors/index";
import { log } from "../utils/logger";

const UUID_LENGTH = UUID_LENGTH;
const COMMIT_HASH_SHORT_LENGTH = COMMIT_HASH_SHORT_LENGTH;
const SHORT_ID_LENGTH = SHORT_ID_LENGTH;
const SIZE_6 = SIZE_6;

const execAsync = promisify(exec);

type ExecCallback = (_error: unknown) => void;

/**
 * Interface for git service operations
 * This defines the contract for git-related functionality
 */
export interface GitServiceInterface {
  /**
   * Clone a repository and set up a session workspace
   */
  clone(__options: CloneOptions): Promise<CloneResult>;

  /**
   * Create and checkout a new branch
   */
  branch(__options: BranchOptions): Promise<BranchResult>;

  /**
   * Execute a git command in a repository
   */
  execInRepository(__workdir: string, _command: string): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(_repoName: string, _session: string): string;

  /**
   * Stash changes in a repository
   */
  stashChanges(__repoPath: string): Promise<StashResult>;

  /**
   * Pull latest changes from a remote
   */
  pullLatest(__repoPath: string, remote?: string): Promise<PullResult>;

  /**
   * Merge a branch into the current branch
   */
  mergeBranch(__repoPath: string, _branch: string): Promise<MergeResult>;

  /**
   * Push changes to a remote
   */
  push(__options: PushOptions): Promise<PushResult>;

  /**
   * Apply stashed changes
   */
  popStash(__repoPath: string): Promise<StashResult>;

  /**
   * Get the status of a repository
   */
  getStatus(repoPath?: string): Promise<GitStatus>;

  /**
   * Get the current branch name
   */
  getCurrentBranch(__repoPath: string): Promise<string>;

  /**
   * Check if repository has uncommitted changes
   */
  hasUncommittedChanges(__repoPath: string): Promise<boolean>;
}

// Define PrTestDependencies first so PrDependencies can extend it
export interface PrTestDependencies {
  execAsync: (_command: unknown) => Promise<{ stdout: string; stderr: string }>;
  getSession: (_name: unknown) => Promise<any>;
  getSessionWorkdir: (_repoName: unknown) => string;
  getSessionByTaskId?: (_taskId: unknown) => Promise<any>;
}

// PrDependencies now extends the proper interface
export interface PrDependencies extends PrTestDependencies {}

export interface BasicGitDependencies {
  execAsync: (_command: unknown) => Promise<{ stdout: string; stderr: string }>;
}

export interface ExtendedGitDependencies extends BasicGitDependencies {
  getSession: (_name: unknown) => Promise<any>;
  getSessionWorkdir: (_repoName: unknown) => string;
  mkdir: (_path: unknown) => Promise<void>;
  readdir: (_path: unknown) => Promise<string[]>;
  access: (_path: unknown) => Promise<void>;
}

export interface CloneOptions {
  repoUrl: string;
  session?: string;
  destination?: string;
  branch?: string;
}

export interface CloneResult {
  workdir: string;
  session: string;
}

export interface BranchOptions {
  session: string;
  branch: string;
}

export interface BranchResult {
  workdir: string;
  branch: string;
}

export interface PrOptions {
  session?: string;
  repoPath?: string;
  taskId?: string;
  branch?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}

export interface GitStatus {
  modified: string[];
  untracked: string[];
  deleted: string[];
}

export interface StashResult {
  workdir: string;
  stashed: boolean;
}

export interface PullResult {
  workdir: string;
  updated: boolean;
}

export interface MergeResult {
  workdir: string;
  merged: boolean;
  conflicts: boolean;
}

export interface PushOptions {
  session?: string;
  repoPath?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}

export interface PushResult {
  workdir: string;
  pushed: boolean;
}

export interface PrResult {
  markdown: string;
  statusUpdateResult?: {
    taskId: string;
    previousStatus: string | null;
    newStatus: string;
  };
}

export interface GitResult {
  workdir: string;
}

export interface PreparePrOptions {
  session?: string;
  repoPath?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  debug?: boolean;
  branchName?: string;
}

export interface PreparePrResult {
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}

export interface MergePrOptions {
  prBranch: string;
  repoPath?: string;
  baseBranch?: string;
  session?: string;
}

export interface MergePrResult {
  prBranch: string;
  baseBranch: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
}

export class GitService implements GitServiceInterface {
  private readonly baseDir: string;
  private sessionDb: SessionDB;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ||
      join(
        process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state"),
        "minsky",
        "git"
      );
    this.sessionDb = new SessionDB();
  }

  // Add public method to get session record
  public async getSessionRecord(__sessionName: string): Promise<any | undefined> {
    return this.sessionDb.getSession(_sessionName);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(UUID_LENGTH).substring(2, COMMIT_HASH_SHORT_LENGTH);
  }

  getSessionWorkdir(_repoName: string, _session: string): string {
    // For consistency, ensure we're always using a normalized repo name
    const normalizedRepoName = repoName.includes("/")
      ? repoName.replace(/[^a-zA-Z0-9-_]/g, "-")
      : repoName;
    return join(this.baseDir, normalizedRepoName, "sessions", _session);
  }

  async clone(__options: CloneOptions): Promise<CloneResult> {
    log.debug("GitService.clone called with _options", {
      repoUrl: options.repoUrl,
      _session: options._session,
      destination: options.destination,
      _branch: options._branch,
    });

    await this.ensureBaseDir();
    log.debug("Base directory ensured", { baseDir: this.baseDir });

    const _session = options.session || this.generateSessionId();
    log.debug("Using session name", { _session, wasProvided: !!options.session });

    // Get the repository name from the URL
    const repoName = normalizeRepoName(options.repoUrl);
    log.debug("Repository name determined", { repoName });

    // For compatibility with other code, ensure consistent normalization
    // This is crucial for local repositories which may have paths with slashes
    let normalizedRepoName = repoName;

    // Special handling for local repositories to match SessionDB's normalization
    if (repoName.startsWith("local/")) {
      // First, try the format used in session records
      const parts = repoName.split("/");
      if (parts.length > 1) {
        // Use "local-" prefix plus remaining parts normalized
        normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
      }
    } else {
      // For other repository types, replace any slashes with dashes
      normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");
    }

    log.debug("Normalized repo name for directory structure", {
      originalRepoName: repoName,
      normalizedRepoName,
    });

    const sessionsDir = join(this.baseDir, normalizedRepoName, "sessions");
    await mkdir(_sessionsDir, { recursive: true });
    log.debug("Sessions directory created", { sessionsDir });

    const _workdir = this.getSessionWorkdir(_normalizedRepoName, _session);
    log.debug("Computed workdir path", { _workdir });

    try {
      // Validate repo URL
      if (!options.repoUrl || options.repoUrl.trim() === "") {
        log.error("Invalid repository URL", { repoUrl: options.repoUrl });
        throw new MinskyError("Repository URL is required for cloning");
      }

      // Check if destination already exists and is not empty
      try {
        const fs = await import("fs/promises");
        const dirContents = await fs.readdir(_workdir);
        if (dirContents.length > 0) {
          log.warn("Destination directory is not empty", { _workdir, contents: dirContents });
        }
      } catch (_error) {
        // Directory doesn't exist or can't be read - this is expected
        log.debug("Destination directory doesn't exist or is empty", { _workdir });
      }

      // Clone the repository with verbose logging
      log.debug(`Executing: git clone ${options.repoUrl} ${workdir}`);
      const cloneCmd = `git clone ${options.repoUrl} ${workdir}`;
      try {
        const { stdout, stderr } = await execAsync(cloneCmd);
        log.debug("git clone succeeded", {
          stdout: stdout.trim().substring(0, HTTP_OK),
          stderr: stderr.trim().substring(0, HTTP_OK),
        });
      } catch (_error) {
        log.error("git clone _command failed", {
          error: cloneErr instanceof Error ? cloneErr.message : String(cloneErr),
          command: cloneCmd,
        });
        throw cloneErr;
      }

      // Verify the clone was successful by checking for .git directory
      log.debug("Verifying clone success");
      const fs = await import("fs/promises");
      try {
        const gitDir = join(__workdir, ".git");
        await fs.access(gitDir);
        log.debug(".git directory exists, clone was successful", { gitDir });

        // List files in the directory to help debug
        try {
          const dirContents = await fs.readdir(_workdir);
          log.debug("Clone directory contents", {
            _workdir,
            fileCount: dirContents.length,
            firstFewFiles: dirContents.slice(0),
          });
        } catch (_error) {
          log.warn("Could not read clone directory", {
            _workdir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (_error) {
        log.error(".git directory not found after clone", {
          _workdir,
          error: accessErr instanceof Error ? accessErr.message : String(accessErr),
        });
        throw new MinskyError("Git repository was not properly cloned: .git directory not found");
      }

      return {
        _workdir,
        _session,
      };
    } catch (_error) {
      log.error("Error during git clone", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        repoUrl: options.repoUrl,
        _workdir,
      });
      throw new MinskyError(
        `Failed to clone git repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async branch(__options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    log.debug("Getting session for _branch", { _session: options.session });

    const _record = await this.sessionDb.getSession(options._session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }

    // Make sure to use the normalized repo name for consistency
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    log.debug("Branch: got repoName", { repoName });

    const _workdir = this.getSessionWorkdir(_repoName, options._session);
    log.debug("Branch: calculated workdir", { _workdir });

    await execAsync(`git -C ${workdir} checkout -b ${options._branch}`);
    return {
      _workdir,
      _branch: options.branch,
    };
  }

  async pr(__options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();

    const deps: PrDependencies = {
      execAsync,
      getSession: async (_name: unknown) => this.sessionDb.getSession(name),
      getSessionWorkdir: (_repoName: unknown) =>
        this.getSessionWorkdir(_repoName, _session),
      getSessionByTaskId: async (_taskId: unknown) => this.sessionDb.getSessionByTaskId?.(_taskId),
    };

    const _result = await this.prWithDependencies(__options, deps);

    try {
      const _workdir = await this.determineWorkingDirectory(__options, deps);
      const _branch = await this.determineCurrentBranch(__workdir, _options, deps);

      const _taskId = await this.determineTaskId(__options, _workdir, _branch, deps);

      if (taskId && !options.noStatusUpdate) {
        try {
          const taskService = new TaskService({
            _workspacePath: workdir,
            backend: "markdown",
          });

          const previousStatus = await taskService.getTaskStatus(_taskId);

          await taskService.setTaskStatus(__taskId, TASK_STATUS.IN_REVIEW);

          result.statusUpdateResult = {
            taskId,
            previousStatus,
            newStatus: TASK_STATUS.IN_REVIEW,
          };

          if (options.debug) {
            log.debug(
              `Updated task ${taskId} _status: ${previousStatus || "unknown"} → ${TASK_STATUS.IN_REVIEW}`
            );
          }
        } catch (_error) {
          if (options.debug) {
            log.debug(
              `Failed to update task _status: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    } catch (_error) {
      if (options.debug) {
        log.debug(
          `Task status update skipped: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  }

  async prWithDependencies(__options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    await this.ensureBaseDir();

    const _workdir = await this.determineWorkingDirectory(__options, deps);

    if (options.debug) {
      log.debug(`Using _workdir: ${workdir}`);
    }

    const _branch = await this.determineCurrentBranch(__workdir, _options, deps);

    if (options.debug) {
      log.debug(`Using _branch: ${branch}`);
    }

    const { baseBranch, mergeBase, comparisonDescription } =
      await this.determineBaseBranchAndMergeBase(__workdir, _branch, _options, deps);

    if (options.debug) {
      log.debug(`Using merge base: ${mergeBase}`);
      log.debug(`Comparison: ${comparisonDescription}`);
    }

    const markdown = await this.generatePrMarkdown(__workdir,
      _branch,
      mergeBase,
      comparisonDescription,
      deps
    );

    return { markdown };
  }

  private async determineWorkingDirectory(__options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.repoPath) {
      return options.repoPath;
    }

    // Try to resolve session from taskId if provided
    let _sessionName = options.session;
    if (!sessionName && options._taskId) {
      if (!deps.getSessionByTaskId) {
        throw new Error("getSessionByTaskId dependency not available");
      }
      const sessionRecord = await deps.getSessionByTaskId(options._taskId);
      if (!sessionRecord) {
        throw new Error(`No session found for task ID "${options._taskId}"`);
      }
      sessionName = sessionRecord.session;
      log.debug("Resolved session from task ID", { _taskId: options._taskId, _session: _sessionName });
    }

    if (!sessionName) {
      throw new Error("Either 'session', '_taskId', or 'repoPath' must be provided to create a PR.");
    }

    const _session = await deps.getSession(_sessionName);
    if (!session) {
      throw new Error(`Session '${sessionName}' not found.`);
    }
    const repoName = session.repoName || normalizeRepoName(session.repoUrl);
    const _workdir = deps.getSessionWorkdir(_repoName, _sessionName);

    log.debug("Using workdir for PR", { _workdir, _session: _sessionName });
    return workdir;
  }

  private async determineCurrentBranch(__workdir: string,
    _options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options._branch) {
      log.debug("Using specified _branch for PR", { _branch: options.branch });
      return options.branch;
    }

    const { stdout } = await deps.execAsync(`git -C ${workdir} _branch --show-current`);
    const _branch = stdout.trim();

    log.debug("Using current _branch for PR", { _branch });
    return branch;
  }

  private async findBaseBranch(__workdir: string,
    _branch: string,
    _options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    // Try to get the remote HEAD branch
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      const baseBranch = stdout.trim().replace("origin/", "");
      log.debug("Found remote HEAD _branch", { baseBranch });
      return baseBranch;
    } catch (_error) {
      log.debug("Failed to get remote HEAD", {
        error: err instanceof Error ? err.message : String(err),
        _branch,
      });
    }

    // Try to get the upstream branch
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`
      );
      const baseBranch = stdout.trim().replace("origin/", "");
      log.debug("Found upstream _branch", { baseBranch });
      return baseBranch;
    } catch (_error) {
      log.debug("Failed to get upstream _branch", {
        error: err instanceof Error ? err.message : String(err),
        _branch,
      });
    }

    // Check if main exists
    try {
      await deps.execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/main`);
      log.debug("Using main as base _branch");
      return "main";
    } catch (_error) {
      log.debug("Failed to check main _branch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Check if master exists
    try {
      await deps.execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/master`);
      log.debug("Using master as base _branch");
      return "master";
    } catch (_error) {
      log.debug("Failed to check master _branch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Default to main (might not exist)
    return "main";
  }

  private async determineBaseBranchAndMergeBase(__workdir: string,
    _branch: string,
    _options: PrOptions,
    deps: PrDependencies
  ): Promise<{ baseBranch: string; mergeBase: string; comparisonDescription: string }> {
    const baseBranch = await this.findBaseBranch(__workdir, _branch, _options, deps);
    log.debug("Using base _branch for PR", { baseBranch });

    let mergeBase: string;
    let comparisonDescription: string;

    try {
      // Find common ancestor of the current branch and the base branch
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} merge-base origin/${baseBranch} ${branch}`
      );
      mergeBase = stdout.trim();
      comparisonDescription = `Showing changes from merge-base with ${baseBranch}`;
      log.debug("Found merge base with base _branch", { baseBranch, mergeBase });
    } catch (_error) {
      log.debug("Failed to find merge base", {
        error: err instanceof Error ? err.message : String(err),
        _branch,
        baseBranch,
      });

      // If merge-base fails, get the first commit of the branch
      try {
        const { stdout } = await deps.execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
        mergeBase = stdout.trim();
        comparisonDescription = "Showing changes from first commit";
        log.debug("Using first commit as base", { mergeBase });
      } catch (_error) {
        log.debug("Failed to find first commit", {
          error: err instanceof Error ? err.message : String(err),
          _branch,
        });
        // If that also fails, use empty tree
        mergeBase = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // Git empty tree
        comparisonDescription = "Showing all changes";
      }
    }

    return { baseBranch, mergeBase, comparisonDescription };
  }

  /**
   * Generate the PR markdown content
   */
  private async generatePrMarkdown(__workdir: string,
    _branch: string,
    mergeBase: string,
    comparisonDescription: string,
    deps: PrDependencies
  ): Promise<string> {
    // Get git repository data
    const { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats } =
      await this.collectRepositoryData(__workdir, _branch, mergeBase, deps);

    // Format the commits for display
    const formattedCommits = this.formatCommits(commits);

    // Check if we have any working directory changes
    const hasWorkingDirChanges =
      untrackedFiles.trim().length > 0 || uncommittedChanges.trim().length > 0;

    return this.buildPrMarkdown(__branch,
      formattedCommits,
      modifiedFiles,
      untrackedFiles,
      uncommittedChanges,
      stats,
      comparisonDescription,
      hasWorkingDirChanges
    );
  }

  /**
   * Format commit data for display in the PR markdown
   */
  private formatCommits(_commits: string): string {
    if (!commits || !commits.trim()) {
      return "No commits yet";
    }

    try {
      // Check if the commits are in the expected format with delimiters
      if (commits.includes("\x1f")) {
        // Parse the commits data with delimiters
        // Split by record separator
        const commitRecords = commits.split("\x1e").filter(Boolean);
        const formattedEntries: string[] = [];

        for (const _record of commitRecords) {
          // Split by field separator
          const fields = record.split("\x1f");
          if (fields.length > 1) {
            if (fields[0] !== undefined && fields[1] !== undefined) {
              const hash = fields[0].substring(0, SHORT_ID_LENGTH);
              const message = fields[1];
              formattedEntries.push(`${hash} ${message}`);
            }
          } else {
            // Use the record as-is if it doesn't have the expected format
            formattedEntries.push(record.trim());
          }
        }

        if (formattedEntries.length > 0) {
          return formattedEntries.join("\n");
        }
      }

      // Use as-is if not in the expected format
      return commits;
    } catch (_error) {
      // In case of any parsing errors, fall back to the raw commits data
      return commits;
    }
  }

  /**
   * Builds the PR markdown from all the components
   */
  private buildPrMarkdown(__branch: string,
    formattedCommits: string,
    modifiedFiles: string,
    untrackedFiles: string,
    uncommittedChanges: string,
    stats: string,
    comparisonDescription: string,
    hasWorkingDirChanges: boolean
  ): string {
    // Generate the PR markdown
    const sections = [
      `# Pull Request for branch \`${branch}\`\n`,
      `## Commits\n${formattedCommits}\n`,
    ];

    // Add modified files section
    let modifiedFilesSection = `## Modified Files (${comparisonDescription})\n`;
    if (modifiedFiles) {
      modifiedFilesSection += `${modifiedFiles}\n`;
    } else if (untrackedFiles) {
      modifiedFilesSection += `${untrackedFiles}\n`;
    } else {
      modifiedFilesSection += "No modified files detected\n";
    }
    sections.push(modifiedFilesSection);

    // Add stats section
    sections.push(`## Stats\n${stats || "No changes"}`);

    // Add working directory changes section if needed
    if (hasWorkingDirChanges) {
      let wdChanges = "## Uncommitted changes in working directory\n";
      if (uncommittedChanges.trim()) {
        wdChanges += `${uncommittedChanges}\n`;
      }
      if (untrackedFiles.trim()) {
        wdChanges += `${untrackedFiles}\n`;
      }
      sections.push(wdChanges);
    }

    return sections.join("\n");
  }

  /**
   * Collect git repository data for PR generation
   */
  private async collectRepositoryData(__workdir: string,
    _branch: string,
    mergeBase: string,
    deps: PrDependencies
  ): Promise<{
    commits: string;
    modifiedFiles: string;
    untrackedFiles: string;
    uncommittedChanges: string;
    stats: string;
  }> {
    // Get commits on the branch
    const commits = await this.getCommitsOnBranch(__workdir, _branch, mergeBase, deps);

    // Get modified files and diff stats
    const { modifiedFiles, diffNameStatus } = await this.getModifiedFiles(__workdir,
      _branch,
      mergeBase,
      deps
    );

    // Get working directory changes
    const { uncommittedChanges, untrackedFiles } = await this.getWorkingDirectoryChanges(__workdir,
      deps
    );

    // Get changes stats
    const stats = await this.getChangeStats(__workdir,
      _branch,
      mergeBase,
      diffNameStatus,
      uncommittedChanges,
      deps
    );

    return { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats };
  }

  /**
   * Get commits on the branch
   */
  private async getCommitsOnBranch(__workdir: string,
    _branch: string,
    mergeBase: string,
    deps: PrDependencies
  ): Promise<string> {
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} log --oneline ${mergeBase}..${branch}`,
        { maxBuffer: BYTES_PER_KB * BYTES_PER_KB }
      );
      return stdout;
    } catch (_error) {
      // Return empty string on error
      return "";
    }
  }

  /**
   * Get modified files in the branch
   */
  private async getModifiedFiles(__workdir: string,
    _branch: string,
    mergeBase: string,
    deps: PrDependencies
  ): Promise<{ modifiedFiles: string; diffNameStatus: string }> {
    let modifiedFiles = "";
    let diffNameStatus = "";

    try {
      // Get modified files in name-status format for processing
      const { stdout: nameStatus } = await deps.execAsync(
        `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`,
        { maxBuffer: BYTES_PER_KB * BYTES_PER_KB }
      );
      diffNameStatus = nameStatus;

      // Get name-only format for display
      const { stdout: nameOnly } = await deps.execAsync(
        `git -C ${workdir} diff --name-only ${mergeBase}..${branch}`,
        { maxBuffer: BYTES_PER_KB * BYTES_PER_KB }
      );
      modifiedFiles = nameOnly;
    } catch (_error) {
      // Return empty strings on error
    }

    return { modifiedFiles, diffNameStatus };
  }

  /**
   * Get uncommitted changes and untracked files
   */
  private async getWorkingDirectoryChanges(__workdir: string,
    deps: PrDependencies
  ): Promise<{ uncommittedChanges: string; untrackedFiles: string }> {
    let uncommittedChanges = "";
    let untrackedFiles = "";

    try {
      // Get uncommitted changes
      const { stdout } = await deps.execAsync(`git -C ${workdir} diff --name-status`, {
        maxBuffer: BYTES_PER_KB * BYTES_PER_KB,
      });
      uncommittedChanges = stdout;
    } catch (_error) {
      // Ignore errors for uncommitted changes
    }

    try {
      // Get untracked files
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} ls-files --others --exclude-standard`,
        { maxBuffer: BYTES_PER_KB * BYTES_PER_KB }
      );
      untrackedFiles = stdout;
    } catch (_error) {
      // Ignore errors for untracked files
    }

    return { uncommittedChanges, untrackedFiles };
  }

  /**
   * Get change statistics
   */
  private async getChangeStats(__workdir: string,
    _branch: string,
    mergeBase: string,
    diffNameStatus: string,
    uncommittedChanges: string,
    deps: PrDependencies
  ): Promise<string> {
    let stats = "No changes";

    try {
      // Try to get diff stats from git
      const { stdout: statOutput } = await deps.execAsync(
        `git -C ${workdir} diff --stat ${mergeBase}..${branch}`,
        { maxBuffer: BYTES_PER_KB * BYTES_PER_KB }
      );

      // If we got stats from git, use them
      if (statOutput && statOutput.trim()) {
        stats = statOutput.trim();
      }
      // Otherwise, try to infer stats from the diff status
      else if (diffNameStatus && diffNameStatus.trim()) {
        const lines = diffNameStatus.trim().split("\n");
        if (lines.length > 0) {
          stats = `${lines.length} files changed`;
        }
      }
      // If we have uncommitted changes but no stats for the branch,
      // we should make sure those are reflected in the output
      else if (uncommittedChanges.trim()) {
        const lines = uncommittedChanges.trim().split("\n");
        if (lines.length > 0) {
          stats = `${lines.length} uncommitted files changed`;
        }
      }
    } catch (_error) {
      // Ignore errors for stats
    }

    return stats;
  }

  async getStatus(repoPath?: string): Promise<GitStatus> {
    const _workdir = repoPath || process.cwd();

    // Get modified files
    const { stdout: modifiedOutput } = await execAsync(`git -C ${workdir} diff --name-only`);
    const modified = modifiedOutput.trim().split("\n").filter(Boolean);

    // Get untracked files
    const { stdout: untrackedOutput } = await execAsync(
      `git -C ${workdir} ls-files --others --exclude-standard`
    );
    const untracked = untrackedOutput.trim().split("\n").filter(Boolean);

    // Get deleted files
    const { stdout: deletedOutput } = await execAsync(`git -C ${workdir} ls-files --deleted`);
    const deleted = deletedOutput.trim().split("\n").filter(Boolean);

    return { modified, untracked, deleted };
  }

  async stageAll(repoPath?: string): Promise<void> {
    const _workdir = repoPath || process.cwd();
    await execAsync(`git -C ${workdir} add -A`);
  }

  async stageModified(repoPath?: string): Promise<void> {
    const _workdir = repoPath || process.cwd();
    await execAsync(`git -C ${workdir} add .`);
  }

  async commit(_message: string, repoPath?: string, amend: boolean = false): Promise<string> {
    const _workdir = repoPath || process.cwd();
    const amendFlag = amend ? "--amend" : "";
    const { stdout } = await execAsync(`git -C ${workdir} commit ${amendFlag} -m "${message}"`);

    // Extract commit hash from git output
    const match = stdout.match(/\[.*\s+([a-f0-9]+)\]/);
    if (!match?.[1]) {
      throw new Error("Failed to extract commit hash from git output");
    }
    return match[1];
  }

  // Add methods for session update command
  async stashChanges(__workdir: string): Promise<StashResult> {
    try {
      // Check if there are changes to stash
      const { stdout: _status } = await execAsync(`git -C ${workdir} status --porcelain`);
      if (!status.trim()) {
        // No changes to stash
        return { _workdir, stashed: false };
      }

      // Stash changes
      await execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
      return { _workdir, stashed: true };
    } catch (_error) {
      throw new Error(
        `Failed to stash changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async popStash(__workdir: string): Promise<StashResult> {
    try {
      // Check if there's a stash to pop
      const { stdout: stashList } = await execAsync(`git -C ${workdir} stash list`);
      if (!stashList.trim()) {
        // No stash to pop
        return { _workdir, stashed: false };
      }

      // Pop the stash
      await execAsync(`git -C ${workdir} stash pop`);
      return { _workdir, stashed: true };
    } catch (_error) {
      throw new Error(`Failed to pop stash: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async pullLatest(__workdir: string, remote: string = "origin"): Promise<PullResult> {
    try {
      // Get current branch
      const { stdout: _branch } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      const currentBranch = branch.trim();

      // Get current commit hash
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Pull latest changes
      await execAsync(`git -C ${workdir} pull ${remote} ${currentBranch}`);

      // Get new commit hash
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were pulled
      return { _workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (_error) {
      throw new Error(
        `Failed to pull latest changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async mergeBranch(__workdir: string, _branch: string): Promise<MergeResult> {
    try {
      // Get current commit hash
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch
      try {
        await execAsync(`git -C ${workdir} merge ${branch}`);
      } catch (_error) {
        // Check if there are merge conflicts
        const { stdout: _status } = await execAsync(`git -C ${workdir} status --porcelain`);
        if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
          // Abort the merge and report conflicts
          await execAsync(`git -C ${workdir} merge --abort`);
          return { _workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were merged
      return { _workdir, merged: beforeHash.trim() !== afterHash.trim(), conflicts: false };
    } catch (_error) {
      throw new Error(
        `Failed to merge _branch ${branch}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Push the current or session branch to a remote, supporting --session, --repo, --remote, and --force.
   */
  async push(__options: PushOptions): Promise<PushResult> {
    await this.ensureBaseDir();
    let _workdir: string;
    let _branch: string;
    const remote = options.remote || "origin";

    // 1. Resolve workdir
    if (options.session) {
      const _record = await this.sessionDb.getSession(options._session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(_repoName, options._session);
      branch = options.session; // Session branch is named after the session
    } else if (options.repoPath) {
      workdir = options.repoPath;
      // Get current branch from repo
      const { stdout: branchOut } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = branchOut.trim();
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
      // Get current branch from cwd
      const { stdout: branchOut } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = branchOut.trim();
    }

    // 2. Validate remote exists
    const { stdout: remotesOut } = await execAsync(`git -C ${workdir} remote`);
    const remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!remotes.includes(remote)) {
      throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
    }

    // 3. Build push command
    let pushCmd = `git -C ${workdir} push ${remote} ${branch}`;
    if (options.force) {
      pushCmd += " --force";
    }

    // 4. Execute push
    try {
      await execAsync(pushCmd);
      return { _workdir, pushed: true };
    } catch (err: unknown) {
      // Provide helpful error messages for common issues
      if (err.stderr && err.stderr.includes("[rejected]")) {
        throw new Error(
          "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
        );
      }
      if (err.stderr && err.stderr.includes("no upstream")) {
        throw new Error(
          "No upstream _branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
        );
      }
      throw new Error(err.stderr || err.message || String(err));
    }
  }

  /**
   * Determine the task ID associated with the current operation
   */
  private async determineTaskId(__options: PrOptions,
    _workdir: string,
    _branch: string,
    deps: PrDependencies
  ): Promise<string | undefined> {
    // 1. Use taskId directly from options if available
    if (options._taskId) {
      log.debug("Using provided task ID", { _taskId: options._taskId });
      return options.taskId;
    }

    // 2. Try to get taskId from session
    if (options.session) {
      const _session = await deps.getSession(options._session);
      if (session && session._taskId) {
        log.debug("Found task ID in session metadata", { _taskId: session._taskId });
        return session.taskId;
      }
    }

    // 3. Try to extract taskId from branch name
    const taskIdMatch = branch.match(/task[#-]?(\d+)/i);
    if (taskIdMatch) {
      const _taskId = taskIdMatch[1];
      log.debug("Parsed task ID from _branch name", { _taskId, _branch });
      return taskId;
    }

    // No taskId found
    log.debug("No task ID could be determined");
    return undefined;
  }

  /**
   * Execute a command in a repository directory
   * @param workdir The repository working directory
   * @param command The command to execute
   * @returns The stdout of the command
   */
  public async execInRepository(__workdir: string, _command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(__command, { cwd: _workdir });
      return stdout;
    } catch (_error) {
      log.error("Command execution failed", {
        error: error instanceof Error ? error.message : String(error),
        _command,
        _workdir,
      });
      throw new MinskyError(
        `Failed to execute _command in repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async preparePr(__options: PreparePrOptions): Promise<PreparePrResult> {
    let _workdir: string;
    let sourceBranch: string;
    const baseBranch = options.baseBranch || "main";

    // Determine working directory and current branch
    if (options.session) {
      const _record = await this.sessionDb.getSession(options._session);
      if (!record) {
        throw new MinskyError(`Session '${options.session}' not found`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(_repoName, options._session);
      sourceBranch = options.session; // Session branch is named after the session
    } else if (options.repoPath) {
      workdir = options.repoPath;
      // Get current branch from repo
      const { stdout: branchOut } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      sourceBranch = branchOut.trim();
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
      // Get current branch from cwd
      const { stdout: branchOut } = await execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      sourceBranch = branchOut.trim();
    }

    // Create PR branch name with pr/ prefix - always use the current git branch name
    // Fix for task #95: Don't use title for branch naming
    const prBranchName = options.branchName || sourceBranch;
    const prBranch = `pr/${prBranchName}`;

    log.debug("Creating PR _branch using git _branch as basis", {
      sourceBranch,
      prBranch,
      usedProvidedBranchName: Boolean(options.branchName),
    });

    // Verify base branch exists
    try {
      await execAsync(`git -C ${workdir} rev-parse --verify ${baseBranch}`);
    } catch (_error) {
      throw new MinskyError(`Base _branch '${baseBranch}' does not exist or is not accessible`);
    }

    // Make sure we have the latest from the base branch
    await execAsync(`git -C ${workdir} fetch origin ${baseBranch}`);

    // Create PR branch FROM base branch (not feature _branch) - per Task #025
    try {
      // Check if PR branch already exists locally and delete it for clean slate
      try {
        await execAsync(`git -C ${workdir} rev-parse --verify ${prBranch}`);
        // Branch exists, delete it to recreate cleanly
        await execAsync(`git -C ${workdir} _branch -D ${prBranch}`);
        log.debug(`Deleted existing PR _branch ${prBranch} for clean recreation`);
      } catch (_error) {
        // Branch doesn't exist, which is fine
      }

      // Create PR branch FROM base branch (Task #025 specification)
      await execAsync(`git -C ${workdir} switch -C ${prBranch} origin/${baseBranch}`);
      log.debug(`Created PR _branch ${prBranch} from origin/${baseBranch}`);
    } catch (_error) {
      throw new MinskyError(
        `Failed to create PR _branch: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Create commit message file for merge commit (Task #025)
    const commitMsgFile = `${workdir}/.pr_title`;
    try {
      let commitMessage = options.title || `Merge ${sourceBranch} into ${prBranch}`;
      if (options.body) {
        commitMessage += `\n\n${options.body}`;
      }

      // Write commit message to file for git merge -F
      await execAsync(`echo '${commitMessage.replace(/'/g, "\\'")}' > ${commitMsgFile}`);
      log.debug("Created commit message file for prepared merge commit");

      // Merge feature branch INTO PR branch with --no-ff (prepared merge commit)
      await execAsync(`git -C ${workdir} merge --no-ff ${sourceBranch} -F ${commitMsgFile}`);
      log.debug(`Created prepared merge commit by merging ${sourceBranch} into ${prBranch}`);

      // Clean up the commit message file
      await execAsync(`rm -f ${commitMsgFile}`);
    } catch (_error) {
      // Clean up on error
      try {
        await execAsync(`git -C ${workdir} merge --abort`);
        await execAsync(`rm -f ${commitMsgFile}`);
        log.debug("Aborted merge and cleaned up after conflict");
      } catch (_error) {
        log.warn("Failed to clean up after merge error", { cleanupErr });
      }

      if (err instanceof Error && err.message.includes("CONFLICT")) {
        throw new MinskyError(
          "Merge conflicts occurred while creating prepared merge commit. Please resolve conflicts and retry.",
          { exitCode: 4 }
        );
      }
      throw new MinskyError(
        `Failed to create prepared merge commit: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Push changes to the PR branch
    await this.push({
      _repoPath: workdir,
      remote: "origin",
      force: true,
    });

    return {
      prBranch,
      baseBranch,
      _title: options.title,
      body: options.body,
    };
  }

  /**
   * Convert a PR title to a branch name
   * e.g. "feat: add new feature" -> "feat-add-new-feature"
   */
  private titleToBranchName(__title: string): string {
    return title
      .toLowerCase()
      .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
      .replace(/[^\w-]/g, "") // Remove any non-word characters except dashes
      .replace(/--+/g, "-") // Replace multiple dashes with single dash
      .replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }

  async mergePr(__options: MergePrOptions): Promise<MergePrResult> {
    let _workdir: string;
    const baseBranch = options.baseBranch || "main";

    // 1. Determine working directory
    if (options.session) {
      const _record = await this.sessionDb.getSession(options._session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(_repoName, options._session);
    } else if (options.repoPath) {
      workdir = options.repoPath;
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
    }

    // 2. Make sure we're on the base branch
    await this.execInRepository(__workdir, `git checkout ${baseBranch}`);

    // 3. Make sure we have the latest changes
    await this.execInRepository(__workdir, `git pull origin ${baseBranch}`);

    // 4. Merge the PR branch
    await this.execInRepository(__workdir, `git merge --no-ff ${options.prBranch}`);

    // DEFAULT_RETRY_COUNT. Get the commit hash of the merge
    const commitHash = (await this.execInRepository(__workdir, "git rev-parse HEAD")).trim();

    // SIZE_6. Get merge date and author
    const mergeDate = new Date().toISOString();
    const mergedBy = (await this.execInRepository(__workdir, "git config user.name")).trim();

    // SHORT_ID_LENGTH. Push the merge to the remote
    await this.execInRepository(__workdir, `git push origin ${baseBranch}`);

    // COMMIT_HASH_SHORT_LENGTH. Delete the PR branch from the remote
    await this.execInRepository(__workdir, `git push origin --delete ${options.prBranch}`);

    return {
      prBranch: options.prBranch,
      baseBranch,
      commitHash,
      mergeDate,
      mergedBy,
    };
  }

  /**
   * Fetch the default branch for a repository
   *
   * @param repoPath - Path to the repository
   * @returns The default branch name
   */
  async fetchDefaultBranch(__repoPath: string): Promise<string> {
    try {
      // Try to get the default branch from the remote's HEAD ref
      const defaultBranchCmd = "git symbolic-ref refs/remotes/origin/HEAD --short";
      const defaultBranch = await this.execInRepository(_repoPath, defaultBranchCmd);
      // Format is usually "origin/main", so we need to remove the "origin/" prefix
      const _result = defaultBranch.trim().replace(/^origin\//, "");
      return result;
    } catch (_error) {
      // Log error but don't throw
      log.error("Could not determine default _branch, falling back to 'main'", {
        error: error instanceof Error ? error.message : String(error),
        repoPath,
      });
      // Fall back to main
      return "main";
    }
  }

  /**
   * Testable version of fetchDefaultBranch with dependency injection
   */
  async fetchDefaultBranchWithDependencies(__repoPath: string,
    deps: {
      execAsync: (_command: unknown) => Promise<{ stdout: string; stderr: string }>;
    }
  ): Promise<string> {
    try {
      // Try to get the default branch from the remote's HEAD ref
      const { stdout } = await deps.execAsync(
        `git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      // Format is usually "origin/main", so we need to remove the "origin/" prefix
      const _result = stdout.trim().replace(/^origin\//, "");
      return result;
    } catch (_error) {
      // Log error but don't throw
      log.error("Could not determine default _branch, falling back to 'main'", {
        error: error instanceof Error ? error.message : String(error),
        repoPath,
      });
      // Fall back to main
      return "main";
    }
  }

  /**
   * Testable version of commit with dependency injection
   */
  async commitWithDependencies(_message: string,
    _workdir: string,
    deps: {
      execAsync: (_command: unknown) => Promise<{ stdout: string; stderr: string }>;
    },
    amend: boolean = false
  ): Promise<string> {
    const amendFlag = amend ? "--amend" : "";
    const { stdout } = await deps.execAsync(
      `git -C ${workdir} commit ${amendFlag} -m "${message}"`
    );

    // Extract commit hash from git output
    const match = stdout.match(/\[.*\s+([a-f0-9]+)\]/);
    if (!match?.[1]) {
      throw new Error("Failed to extract commit hash from git output");
    }
    return match[1];
  }

  /**
   * Testable version of stashChanges with dependency injection
   */
  async stashChangesWithDependencies(__workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    try {
      // Check if there are changes to stash
      const { stdout: _status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
      if (!status.trim()) {
        // No changes to stash
        return { _workdir, stashed: false };
      }

      // Stash changes
      await deps.execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
      return { _workdir, stashed: true };
    } catch (_error) {
      throw new Error(
        `Failed to stash changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Testable version of popStash with dependency injection
   */
  async popStashWithDependencies(__workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    try {
      // Check if there's a stash to pop
      const { stdout: stashList } = await deps.execAsync(`git -C ${workdir} stash list`);
      if (!stashList.trim()) {
        // No stash to pop
        return { _workdir, stashed: false };
      }

      // Pop the stash
      await deps.execAsync(`git -C ${workdir} stash pop`);
      return { _workdir, stashed: true };
    } catch (_error) {
      throw new Error(`Failed to pop stash: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Testable version of mergeBranch with dependency injection
   */
  async mergeBranchWithDependencies(__workdir: string,
    _branch: string,
    deps: BasicGitDependencies
  ): Promise<MergeResult> {
    try {
      // Get current commit hash
      const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch
      try {
        await deps.execAsync(`git -C ${workdir} merge ${branch}`);
      } catch (_error) {
        // Check if there are merge conflicts
        const { stdout: _status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
        if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
          // Abort the merge and report conflicts
          await deps.execAsync(`git -C ${workdir} merge --abort`);
          return { _workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were merged
      return { _workdir, merged: beforeHash.trim() !== afterHash.trim(), conflicts: false };
    } catch (_error) {
      throw new Error(
        `Failed to merge _branch ${branch}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Testable version of stageAll with dependency injection
   */
  async stageAllWithDependencies(__workdir: string, deps: BasicGitDependencies): Promise<void> {
    await deps.execAsync(`git -C ${workdir} add -A`);
  }

  /**
   * Testable version of stageModified with dependency injection
   */
  async stageModifiedWithDependencies(__workdir: string, deps: BasicGitDependencies): Promise<void> {
    await deps.execAsync(`git -C ${workdir} add .`);
  }

  /**
   * Testable version of pullLatest with dependency injection
   */
  async pullLatestWithDependencies(__workdir: string,
    deps: BasicGitDependencies,
    remote: string = "origin"
  ): Promise<PullResult> {
    try {
      // Get current branch
      const { stdout: _branch } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      const currentBranch = branch.trim();

      // Get current commit hash
      const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Pull latest changes
      await deps.execAsync(`git -C ${workdir} pull ${remote} ${currentBranch}`);

      // Get new commit hash
      const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were pulled
      return { _workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (_error) {
      throw new Error(
        `Failed to pull latest changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Testable version of clone with dependency injection
   */
  async cloneWithDependencies(__options: CloneOptions,
    deps: ExtendedGitDependencies
  ): Promise<CloneResult> {
    await deps.mkdir(this.baseDir, { recursive: true });

    const _session = options.session || this.generateSessionId();
    const repoName = normalizeRepoName(options.repoUrl);
    const normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");

    const sessionsDir = join(this.baseDir, normalizedRepoName, "sessions");
    await deps.mkdir(_sessionsDir, { recursive: true });

    const _workdir = this.getSessionWorkdir(_normalizedRepoName, _session);

    try {
      // Validate repo URL
      if (!options.repoUrl || options.repoUrl.trim() === "") {
        throw new Error("Repository URL is required for cloning");
      }

      // Check if destination already exists and is not empty
      try {
        const dirContents = await deps.readdir(_workdir);
        if (dirContents.length > 0) {
          log.warn("Destination directory is not empty", { _workdir, contents: dirContents });
        }
      } catch (_error) {
        // Directory doesn't exist or can't be read - this is expected
        log.debug("Destination directory doesn't exist or is empty", { _workdir });
      }

      // Clone the repository
      const cloneCmd = `git clone ${options.repoUrl} ${workdir}`;
      await deps.execAsync(cloneCmd);

      // Verify the clone was successful by checking for .git directory
      try {
        const gitDir = join(__workdir, ".git");
        await deps.access(gitDir);
      } catch (_error) {
        throw new Error("Git repository was not properly cloned: .git directory not found");
      }

      return { _workdir, _session };
    } catch (_error) {
      throw new Error(
        `Failed to clone git repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Testable version of branch with dependency injection
   */
  async branchWithDependencies(__options: BranchOptions,
    deps: PrDependencies
  ): Promise<BranchResult> {
    const _record = await deps.getSession(options._session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }

    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    const _workdir = deps.getSessionWorkdir(_repoName, options._session);

    await deps.execAsync(`git -C ${workdir} checkout -b ${options._branch}`);
    return {
      _workdir,
      _branch: options.branch,
    };
  }

  /**
   * Testable version of push with dependency injection
   */
  async pushWithDependencies(__options: PushOptions, deps: PrDependencies): Promise<PushResult> {
    let _workdir: string;
    let _branch: string;
    const remote = options.remote || "origin";

    // 1. Resolve workdir
    if (options.session) {
      const _record = await deps.getSession(options._session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = deps.getSessionWorkdir(_repoName, options._session);
      branch = options.session; // Session branch is named after the session
    } else if (options.repoPath) {
      workdir = options.repoPath;
      // Get current branch from repo
      const { stdout: branchOut } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = branchOut.trim();
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
      // Get current branch from cwd
      const { stdout: branchOut } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = branchOut.trim();
    }

    // 2. Validate remote exists
    const { stdout: remotesOut } = await deps.execAsync(`git -C ${workdir} remote`);
    const remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!remotes.includes(remote)) {
      throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
    }

    // 3. Build push command
    let pushCmd = `git -C ${workdir} push ${remote} ${branch}`;
    if (options.force) {
      pushCmd += " --force";
    }

    // 4. Execute push
    try {
      await deps.execAsync(pushCmd);
      return { _workdir, pushed: true };
    } catch (err: unknown) {
      // Provide helpful error messages for common issues
      if (err.stderr && err.stderr.includes("[rejected]")) {
        throw new Error(
          "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
        );
      }
      if (err.stderr && err.stderr.includes("no upstream")) {
        throw new Error(
          "No upstream _branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
        );
      }
      throw new Error(err.stderr || err.message || String(err));
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(__repoPath: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
    return stdout.trim();
  }

  /**
   * Check if repository has uncommitted changes
   */
  async hasUncommittedChanges(__repoPath: string): Promise<boolean> {
    const { stdout } = await execAsync(`git -C ${repoPath} status --porcelain`);
    return stdout.trim().length > 0;
  }
}

/**
 * Interface-agnostic function to create a pull request
 * This implements the interface agnostic command architecture pattern
 */
export async function createPullRequestFromParams(__params: {
  session?: string;
  repo?: string;
  _branch?: string;
  _taskId?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}): Promise<{ markdown: string; statusUpdateResult?: unknown }> {
  try {
    const git = new GitService();
    const _result = await git.pr({
      _session: params._session,
      repoPath: params.repo,
      _branch: params._branch,
      _taskId: params._taskId,
      debug: params.debug,
      noStatusUpdate: params.noStatusUpdate,
    });
    return result;
  } catch (_error) {
    log.error("Error creating pull request", {
      _session: params._session,
      repo: params.repo,
      _branch: params._branch,
      _taskId: params._taskId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to commit changes
 * This implements the interface agnostic command architecture pattern
 */
export async function commitChangesFromParams(__params: {
  message: string;
  session?: string;
  repo?: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{ commitHash: string; message: string }> {
  try {
    const git = new GitService();

    if (!params.noStage) {
      if (params.all) {
        await git.stageAll(params.repo);
      } else {
        await git.stageModified(params.repo);
      }
    }

    const commitHash = await git.commit(params.message, params.repo, params.amend);

    return {
      commitHash,
      message: params.message,
    };
  } catch (_error) {
    log.error("Error committing changes", {
      _session: params._session,
      repo: params.repo,
      message: params.message,
      all: params.all,
      amend: params.amend,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to prepare a PR branch
 */
export async function preparePrFromParams(__params: {
  session?: string;
  repo?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  branchName?: string;
  debug?: boolean;
}): Promise<PreparePrResult> {
  try {
    const git = new GitService();
    const _result = await git.preparePr({
      _session: params._session,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      _title: params._title,
      body: params.body,
      branchName: params.branchName,
      debug: params.debug,
    });
    return result;
  } catch (_error) {
    log.error("Error preparing PR _branch", {
      _session: params._session,
      repo: params.repo,
      baseBranch: params.baseBranch,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to merge a PR branch
 */
export async function mergePrFromParams(__params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
}): Promise<MergePrResult> {
  try {
    const git = new GitService();
    const _result = await git.mergePr({
      prBranch: params.prBranch,
      _repoPath: params.repo,
      baseBranch: params.baseBranch,
      _session: params._session,
    });
    return result;
  } catch (_error) {
    log.error("Error merging PR _branch", {
      prBranch: params.prBranch,
      baseBranch: params.baseBranch,
      _session: params._session,
      repo: params.repo,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to clone a repository
 */
export async function cloneFromParams(__params: {
  url: string;
  session?: string;
  destination?: string;
  _branch?: string;
}): Promise<CloneResult> {
  try {
    const git = new GitService();
    const _result = await git.clone({
      repoUrl: params.url,
      _session: params._session,
      destination: params.destination,
      _branch: params._branch,
    });
    return result;
  } catch (_error) {
    log.error("Error cloning repository", {
      url: params.url,
      _session: params._session,
      destination: params.destination,
      _branch: params._branch,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to create a branch
 */
export async function branchFromParams(__params: {
  _session: string;
  name: string;
}): Promise<BranchResult> {
  try {
    const git = new GitService();
    const _result = await git.branch({
      _session: params._session,
      _branch: params.name,
    });
    return result;
  } catch (_error) {
    log.error("Error creating _branch", {
      _session: params._session,
      name: params.name,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to push changes to a remote repository
 */
export async function pushFromParams(__params: {
  session?: string;
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  try {
    const git = new GitService();
    const _result = await git.push({
      _session: params._session,
      repoPath: params.repo,
      remote: params.remote,
      force: params.force,
      debug: params.debug,
    });
    return result;
  } catch (_error) {
    log.error("Error pushing changes", {
      _session: params._session,
      repo: params.repo,
      remote: params.remote,
      force: params.force,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Creates a default GitService implementation
 * This factory function provides a consistent way to get a git service with optional customization
 *
 * @param options Optional configuration options for the git service
 * @returns A GitServiceInterface implementation
 */
export function createGitService(_options?: { baseDir?: string }): GitServiceInterface {
  return new GitService(_options?.baseDir);
}
