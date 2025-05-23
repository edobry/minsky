import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exec as childExec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecException } from "node:child_process";
import { normalizeRepoName } from "./repo-utils.js";
import { SessionDB } from "./session.js";
import { TaskService, TASK_STATUS } from "./tasks";
import { MinskyError } from "../errors/index.js";
import { log } from "../utils/logger";

const execAsync = promisify(childExec);

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

/**
 * Interface for git service operations
 * This defines the contract for git-related functionality
 */
export interface GitServiceInterface {
  /**
   * Clone a repository and set up a session workspace
   */
  clone(options: {
    repoUrl: string;
    session: string;
    branch?: string;
  }): Promise<{ workdir: string; session: string }>;

  /**
   * Create and checkout a new branch
   */
  branch(options: BranchOptions): Promise<any>;

  /**
   * Execute a git command in a repository
   */
  execInRepository(workdir: string, command: string): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(repoName: string, session: string): string;

  /**
   * Stash changes in a repository
   */
  stashChanges(repoPath: string): Promise<void>;

  /**
   * Pull latest changes from a remote
   */
  pullLatest(repoPath: string, remote?: string): Promise<void>;

  /**
   * Merge a branch into the current branch
   */
  mergeBranch(repoPath: string, branch: string): Promise<{ conflicts: boolean }>;

  /**
   * Push changes to a remote
   */
  push(options: { repoPath: string; remote?: string }): Promise<void>;

  /**
   * Apply stashed changes
   */
  popStash(repoPath: string): Promise<void>;

  /**
   * Get the status of a repository
   */
  getStatus(repoPath?: string): Promise<GitStatus>;
}

// Define PrTestDependencies first so PrDependencies can extend it
export interface PrTestDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
  getSessionByTaskId?: (taskId: string) => Promise<any>;
}

// PrDependencies now extends the proper interface
export interface PrDependencies extends PrTestDependencies {}

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
  conflicts?: boolean;
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
        process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
        "minsky",
        "git"
      );
    this.sessionDb = new SessionDB();
  }

  // Add public method to get session record
  public async getSessionRecord(sessionName: string): Promise<any | undefined> {
    return this.sessionDb.getSession(sessionName);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  getSessionWorkdir(repoName: string, session: string): string {
    // For consistency, ensure we're always using a normalized repo name
    const normalizedRepoName = repoName.includes("/")
      ? repoName.replace(/[^a-zA-Z0-9-_]/g, "-")
      : repoName;
    return join(this.baseDir, normalizedRepoName, "sessions", session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    log.debug("GitService.clone called with options", {
      repoUrl: options.repoUrl,
      session: options.session,
      destination: options.destination,
      branch: options.branch,
    });

    await this.ensureBaseDir();
    log.debug("Base directory ensured", { baseDir: this.baseDir });

    const session = options.session || this.generateSessionId();
    log.debug("Using session name", { session, wasProvided: !!options.session });

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
        normalizedRepoName = `${parts[0]  }-${  parts.slice(1).join("-")}`;
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
    await mkdir(sessionsDir, { recursive: true });
    log.debug("Sessions directory created", { sessionsDir });

    const workdir = this.getSessionWorkdir(normalizedRepoName, session);
    log.debug("Computed workdir path", { workdir });

    try {
      // Validate repo URL
      if (!options.repoUrl || options.repoUrl.trim() === "") {
        log.error("Invalid repository URL", { repoUrl: options.repoUrl });
        throw new MinskyError("Repository URL is required for cloning");
      }

      // Check if destination already exists and is not empty
      try {
        const fs = await import("fs/promises");
        const dirContents = await fs.readdir(workdir);
        if (dirContents.length > 0) {
          log.warn("Destination directory is not empty", { workdir, contents: dirContents });
        }
      } catch (err) {
        // Directory doesn't exist or can't be read - this is expected
        log.debug("Destination directory doesn't exist or is empty", { workdir });
      }

      // Clone the repository with verbose logging
      log.debug(`Executing: git clone ${options.repoUrl} ${workdir}`);
      const cloneCmd = `git clone ${options.repoUrl} ${workdir}`;
      try {
        const { stdout, stderr } = await execAsync(cloneCmd);
        log.debug("git clone succeeded", {
          stdout: stdout.trim().substring(0, 200),
          stderr: stderr.trim().substring(0, 200),
        });
      } catch (cloneErr) {
        log.error("git clone command failed", {
          error: cloneErr instanceof Error ? cloneErr.message : String(cloneErr),
          command: cloneCmd,
        });
        throw cloneErr;
      }

      // Verify the clone was successful by checking for .git directory
      log.debug("Verifying clone success");
      const fs = await import("fs/promises");
      try {
        const gitDir = join(workdir, ".git");
        await fs.access(gitDir);
        log.debug(".git directory exists, clone was successful", { gitDir });

        // List files in the directory to help debug
        try {
          const dirContents = await fs.readdir(workdir);
          log.debug("Clone directory contents", {
            workdir,
            fileCount: dirContents.length,
            firstFewFiles: dirContents.slice(0, 5),
          });
        } catch (err) {
          log.warn("Could not read clone directory", {
            workdir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (accessErr) {
        log.error(".git directory not found after clone", {
          workdir,
          error: accessErr instanceof Error ? accessErr.message : String(accessErr),
        });
        throw new MinskyError("Git repository was not properly cloned: .git directory not found");
      }

      return {
        workdir,
        session,
      };
    } catch (error) {
      log.error("Error during git clone", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        repoUrl: options.repoUrl,
        workdir,
      });
      throw new MinskyError(
        `Failed to clone git repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    log.debug("Getting session for branch", { session: options.session });

    const record = await this.sessionDb.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }

    // Make sure to use the normalized repo name for consistency
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    log.debug("Branch: got repoName", { repoName });

    const workdir = this.getSessionWorkdir(repoName, options.session);
    log.debug("Branch: calculated workdir", { workdir });

    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return {
      workdir,
      branch: options.branch,
    };
  }

  async pr(options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();

    const deps: PrDependencies = {
      execAsync,
      getSession: async (name: string) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName: string, session: string) =>
        this.getSessionWorkdir(repoName, session),
      getSessionByTaskId: async (taskId: string) => this.sessionDb.getSessionByTaskId?.(taskId),
    };

    const result = await this.prWithDependencies(options, deps);

    try {
      const workdir = await this.determineWorkingDirectory(options, deps);
      const branch = await this.determineCurrentBranch(workdir, options, deps);

      const taskId = await this.determineTaskId(options, workdir, branch, deps);

      if (taskId && !options.noStatusUpdate) {
        try {
          const taskService = new TaskService({
            workspacePath: workdir,
            backend: "markdown",
          });

          const previousStatus = await taskService.getTaskStatus(taskId);

          await taskService.setTaskStatus(taskId, TASK_STATUS.IN_REVIEW);

          result.statusUpdateResult = {
            taskId,
            previousStatus,
            newStatus: TASK_STATUS.IN_REVIEW,
          };

          if (options.debug) {
            log.debug(
              `Updated task ${taskId} status: ${previousStatus || "unknown"} → ${TASK_STATUS.IN_REVIEW}`
            );
          }
        } catch (error) {
          if (options.debug) {
            log.debug(
              `Failed to update task status: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
    } catch (error) {
      if (options.debug) {
        log.debug(
          `Task status update skipped: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  }

  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    await this.ensureBaseDir();

    const workdir = await this.determineWorkingDirectory(options, deps);

    if (options.debug) {
      log.debug(`Using workdir: ${workdir}`);
    }

    const branch = await this.determineCurrentBranch(workdir, options, deps);

    if (options.debug) {
      log.debug(`Using branch: ${branch}`);
    }

    const { baseBranch, mergeBase, comparisonDescription } =
      await this.determineBaseBranchAndMergeBase(workdir, branch, options, deps);

    if (options.debug) {
      log.debug(`Using merge base: ${mergeBase}`);
      log.debug(`Comparison: ${comparisonDescription}`);
    }

    const markdown = await this.generatePrMarkdown(
      workdir,
      branch,
      mergeBase,
      comparisonDescription,
      deps
    );

    return { markdown };
  }

  private async determineWorkingDirectory(
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.repoPath) {
      return options.repoPath;
    }

    if (!options.session) {
      throw new Error("Either 'session' or 'repoPath' must be provided to create a PR.");
    }

    const session = await deps.getSession(options.session);
    if (!session) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    const repoName = session.repoName || normalizeRepoName(session.repoUrl);
    const workdir = deps.getSessionWorkdir(repoName, options.session);

    log.debug("Using workdir for PR", { workdir, session: options.session });
    return workdir;
  }

  private async determineCurrentBranch(
    workdir: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.branch) {
      log.debug("Using specified branch for PR", { branch: options.branch });
      return options.branch;
    }

    const { stdout } = await deps.execAsync(`git -C ${workdir} branch --show-current`);
    const branch = stdout.trim();

    log.debug("Using current branch for PR", { branch });
    return branch;
  }

  private async findBaseBranch(
    workdir: string,
    branch: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    // Try to get the remote HEAD branch
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      const baseBranch = stdout.trim().replace("origin/", "");
      log.debug("Found remote HEAD branch", { baseBranch });
      return baseBranch;
    } catch (err) {
      log.debug("Failed to get remote HEAD", {
        error: err instanceof Error ? err.message : String(err),
        branch,
      });
    }

    // Try to get the upstream branch
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`
      );
      const baseBranch = stdout.trim().replace("origin/", "");
      log.debug("Found upstream branch", { baseBranch });
      return baseBranch;
    } catch (err) {
      log.debug("Failed to get upstream branch", {
        error: err instanceof Error ? err.message : String(err),
        branch,
      });
    }

    // Check if main exists
    try {
      await deps.execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/main`);
      log.debug("Using main as base branch");
      return "main";
    } catch (err) {
      log.debug("Failed to check main branch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Check if master exists
    try {
      await deps.execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/master`);
      log.debug("Using master as base branch");
      return "master";
    } catch (err) {
      log.debug("Failed to check master branch", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Default to main (might not exist)
    return "main";
  }

  private async determineBaseBranchAndMergeBase(
    workdir: string,
    branch: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<{ baseBranch: string; mergeBase: string; comparisonDescription: string }> {
    const baseBranch = await this.findBaseBranch(workdir, branch, options, deps);
    log.debug("Using base branch for PR", { baseBranch });

    let mergeBase: string;
    let comparisonDescription: string;

    try {
      // Find common ancestor of the current branch and the base branch
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} merge-base origin/${baseBranch} ${branch}`
      );
      mergeBase = stdout.trim();
      comparisonDescription = `Showing changes from merge-base with ${baseBranch}`;
      log.debug("Found merge base with base branch", { baseBranch, mergeBase });
    } catch (err) {
      log.debug("Failed to find merge base", {
        error: err instanceof Error ? err.message : String(err),
        branch,
        baseBranch,
      });

      // If merge-base fails, get the first commit of the branch
      try {
        const { stdout } = await deps.execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
        mergeBase = stdout.trim();
        comparisonDescription = "Showing changes from first commit";
        log.debug("Using first commit as base", { mergeBase });
      } catch (err) {
        log.debug("Failed to find first commit", {
          error: err instanceof Error ? err.message : String(err),
          branch,
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
  private async generatePrMarkdown(
    workdir: string,
    branch: string,
    mergeBase: string,
    comparisonDescription: string,
    deps: PrDependencies
  ): Promise<string> {
    // Get git repository data
    const { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats } =
      await this.collectRepositoryData(workdir, branch, mergeBase, deps);

    // Format the commits for display
    const formattedCommits = this.formatCommits(commits);

    // Check if we have any working directory changes
    const hasWorkingDirChanges =
      untrackedFiles.trim().length > 0 || uncommittedChanges.trim().length > 0;

    return this.buildPrMarkdown(
      branch,
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
  private formatCommits(commits: string): string {
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

        for (const record of commitRecords) {
          // Split by field separator
          const fields = record.split("\x1f");
          if (fields.length > 1) {
            if (fields[0] !== undefined && fields[1] !== undefined) {
              const hash = fields[0].substring(0, 7);
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
    } catch (error) {
      // In case of any parsing errors, fall back to the raw commits data
      return commits;
    }
  }

  /**
   * Builds the PR markdown from all the components
   */
  private buildPrMarkdown(
    branch: string,
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
  private async collectRepositoryData(
    workdir: string,
    branch: string,
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
    const commits = await this.getCommitsOnBranch(workdir, branch, mergeBase, deps);

    // Get modified files and diff stats
    const { modifiedFiles, diffNameStatus } = await this.getModifiedFiles(
      workdir,
      branch,
      mergeBase,
      deps
    );

    // Get working directory changes
    const { uncommittedChanges, untrackedFiles } = await this.getWorkingDirectoryChanges(
      workdir,
      deps
    );

    // Get changes stats
    const stats = await this.getChangeStats(
      workdir,
      branch,
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
  private async getCommitsOnBranch(
    workdir: string,
    branch: string,
    mergeBase: string,
    deps: PrDependencies
  ): Promise<string> {
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} log --oneline ${mergeBase}..${branch}`,
        { maxBuffer: 1024 * 1024 }
      );
      return stdout;
    } catch (err) {
      // Return empty string on error
      return "";
    }
  }

  /**
   * Get modified files in the branch
   */
  private async getModifiedFiles(
    workdir: string,
    branch: string,
    mergeBase: string,
    deps: PrDependencies
  ): Promise<{ modifiedFiles: string; diffNameStatus: string }> {
    let modifiedFiles = "";
    let diffNameStatus = "";

    try {
      // Get modified files in name-status format for processing
      const { stdout: nameStatus } = await deps.execAsync(
        `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`,
        { maxBuffer: 1024 * 1024 }
      );
      diffNameStatus = nameStatus;

      // Get name-only format for display
      const { stdout: nameOnly } = await deps.execAsync(
        `git -C ${workdir} diff --name-only ${mergeBase}..${branch}`,
        { maxBuffer: 1024 * 1024 }
      );
      modifiedFiles = nameOnly;
    } catch (err) {
      // Return empty strings on error
    }

    return { modifiedFiles, diffNameStatus };
  }

  /**
   * Get uncommitted changes and untracked files
   */
  private async getWorkingDirectoryChanges(
    workdir: string,
    deps: PrDependencies
  ): Promise<{ uncommittedChanges: string; untrackedFiles: string }> {
    let uncommittedChanges = "";
    let untrackedFiles = "";

    try {
      // Get uncommitted changes
      const { stdout } = await deps.execAsync(`git -C ${workdir} diff --name-status`, {
        maxBuffer: 1024 * 1024,
      });
      uncommittedChanges = stdout;
    } catch (err) {
      // Ignore errors for uncommitted changes
    }

    try {
      // Get untracked files
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} ls-files --others --exclude-standard`,
        { maxBuffer: 1024 * 1024 }
      );
      untrackedFiles = stdout;
    } catch (err) {
      // Ignore errors for untracked files
    }

    return { uncommittedChanges, untrackedFiles };
  }

  /**
   * Get change statistics
   */
  private async getChangeStats(
    workdir: string,
    branch: string,
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
        { maxBuffer: 1024 * 1024 }
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
    } catch (err) {
      // Ignore errors for stats
    }

    return stats;
  }

  async getStatus(repoPath?: string): Promise<GitStatus> {
    const workdir = repoPath || process.cwd();

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
    const workdir = repoPath || process.cwd();
    await execAsync(`git -C ${workdir} add -A`);
  }

  async stageModified(repoPath?: string): Promise<void> {
    const workdir = repoPath || process.cwd();
    await execAsync(`git -C ${workdir} add .`);
  }

  async commit(message: string, repoPath?: string, amend: boolean = false): Promise<string> {
    const workdir = repoPath || process.cwd();
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
  async stashChanges(workdir: string): Promise<StashResult> {
    try {
      // Check if there are changes to stash
      const { stdout: status } = await execAsync(`git -C ${workdir} status --porcelain`);
      if (!status.trim()) {
        // No changes to stash
        return { workdir, stashed: false };
      }

      // Stash changes
      await execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(
        `Failed to stash changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async popStash(workdir: string): Promise<StashResult> {
    try {
      // Check if there's a stash to pop
      const { stdout: stashList } = await execAsync(`git -C ${workdir} stash list`);
      if (!stashList.trim()) {
        // No stash to pop
        return { workdir, stashed: false };
      }

      // Pop the stash
      await execAsync(`git -C ${workdir} stash pop`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(`Failed to pop stash: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async pullLatest(workdir: string, remote: string = "origin"): Promise<PullResult> {
    try {
      // Get current branch
      const { stdout: branch } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      const currentBranch = branch.trim();

      // Get current commit hash
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Pull latest changes
      await execAsync(`git -C ${workdir} pull ${remote} ${currentBranch}`);

      // Get new commit hash
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were pulled
      return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (err) {
      throw new Error(
        `Failed to pull latest changes: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async mergeBranch(workdir: string, branch: string): Promise<MergeResult> {
    try {
      // Get current commit hash
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch
      try {
        await execAsync(`git -C ${workdir} merge ${branch}`);
      } catch (err) {
        // Check if there are merge conflicts
        const { stdout: status } = await execAsync(`git -C ${workdir} status --porcelain`);
        if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
          // Abort the merge and report conflicts
          await execAsync(`git -C ${workdir} merge --abort`);
          return { workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were merged
      return { workdir, merged: beforeHash.trim() !== afterHash.trim(), conflicts: false };
    } catch (err) {
      throw new Error(
        `Failed to merge branch ${branch}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Push the current or session branch to a remote, supporting --session, --repo, --remote, and --force.
   */
  async push(options: PushOptions): Promise<PushResult> {
    await this.ensureBaseDir();
    let workdir: string;
    let branch: string;
    const remote = options.remote || "origin";

    // 1. Resolve workdir
    if (options.session) {
      const record = await this.sessionDb.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(repoName, options.session);
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
      return { workdir, pushed: true };
    } catch (err: any) {
      // Provide helpful error messages for common issues
      if (err.stderr && err.stderr.includes("[rejected]")) {
        throw new Error(
          "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
        );
      }
      if (err.stderr && err.stderr.includes("no upstream")) {
        throw new Error(
          "No upstream branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
        );
      }
      throw new Error(err.stderr || err.message || String(err));
    }
  }

  /**
   * Determine the task ID associated with the current operation
   */
  private async determineTaskId(
    options: PrOptions,
    workdir: string,
    branch: string,
    deps: PrDependencies
  ): Promise<string | undefined> {
    // 1. Use taskId directly from options if available
    if (options.taskId) {
      log.debug("Using provided task ID", { taskId: options.taskId });
      return options.taskId;
    }

    // 2. Try to get taskId from session
    if (options.session) {
      const session = await deps.getSession(options.session);
      if (session && session.taskId) {
        log.debug("Found task ID in session metadata", { taskId: session.taskId });
        return session.taskId;
      }
    }

    // 3. Try to extract taskId from branch name
    const taskIdMatch = branch.match(/task[#-]?(\d+)/i);
    if (taskIdMatch) {
      const taskId = taskIdMatch[1];
      log.debug("Parsed task ID from branch name", { taskId, branch });
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
  public async execInRepository(workdir: string, command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(command, { cwd: workdir });
      return stdout;
    } catch (error) {
      log.error("Command execution failed", {
        error: error instanceof Error ? error.message : String(error),
        command,
        workdir,
      });
      throw new MinskyError(
        `Failed to execute command in repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async preparePr(options: PreparePrOptions): Promise<PreparePrResult> {
    let workdir: string;
    let sourceBranch: string;
    const baseBranch = options.baseBranch || "main";

    // Determine working directory and current branch
    if (options.session) {
      const record = await this.sessionDb.getSession(options.session);
      if (!record) {
        throw new MinskyError(`Session '${options.session}' not found`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(repoName, options.session);
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

    log.debug("Creating PR branch using git branch as basis", {
      sourceBranch,
      prBranch,
      usedProvidedBranchName: Boolean(options.branchName),
    });

    // Verify base branch exists
    try {
      await execAsync(`git -C ${workdir} rev-parse --verify ${baseBranch}`);
    } catch (err) {
      throw new MinskyError(`Base branch '${baseBranch}' does not exist or is not accessible`);
    }

    // Make sure we have the latest from the base branch
    await execAsync(`git -C ${workdir} fetch origin ${baseBranch}`);

    // Create and checkout the PR branch from the current branch
    try {
      // Check if PR branch already exists locally
      try {
        await execAsync(`git -C ${workdir} rev-parse --verify ${prBranch}`);
        // If it exists, just check it out
        await execAsync(`git -C ${workdir} checkout ${prBranch}`);
      } catch {
        // If it doesn't exist, create it from the current branch
        await execAsync(`git -C ${workdir} checkout -b ${prBranch}`);
      }
    } catch (err) {
      throw new MinskyError(
        `Failed to create/checkout PR branch: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Stage all changes
    await this.stageAll(workdir);

    // Check if there are changes to commit
    const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
    if (statusOutput.trim()) {
      // Commit any staged changes if there are any
      const commitMsg = options.title || `Prepare PR branch ${prBranch}`;
      await this.commit(commitMsg, workdir);
    }

    // Push changes to the PR branch
    await this.push({
      repoPath: workdir,
      remote: "origin",
    });

    return {
      prBranch,
      baseBranch,
      title: options.title,
      body: options.body,
    };
  }

  /**
   * Convert a PR title to a branch name
   * e.g. "feat: add new feature" -> "feat-add-new-feature"
   */
  private titleToBranchName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
      .replace(/[^\w-]/g, "") // Remove any non-word characters except dashes
      .replace(/--+/g, "-") // Replace multiple dashes with single dash
      .replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }

  async mergePr(options: MergePrOptions): Promise<MergePrResult> {
    let workdir: string;
    const baseBranch = options.baseBranch || "main";

    // 1. Determine working directory
    if (options.session) {
      const record = await this.sessionDb.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(repoName, options.session);
    } else if (options.repoPath) {
      workdir = options.repoPath;
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
    }

    // 2. Make sure we're on the base branch
    await this.execInRepository(workdir, `git checkout ${baseBranch}`);

    // 3. Make sure we have the latest changes
    await this.execInRepository(workdir, `git pull origin ${baseBranch}`);

    // 4. Merge the PR branch
    await this.execInRepository(workdir, `git merge --no-ff ${options.prBranch}`);

    // 5. Get the commit hash of the merge
    const commitHash = (await this.execInRepository(workdir, "git rev-parse HEAD")).trim();

    // 6. Get merge date and author
    const mergeDate = new Date().toISOString();
    const mergedBy = (await this.execInRepository(workdir, "git config user.name")).trim();

    // 7. Push the merge to the remote
    await this.execInRepository(workdir, `git push origin ${baseBranch}`);

    // 8. Delete the PR branch from the remote
    await this.execInRepository(workdir, `git push origin --delete ${options.prBranch}`);

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
  async fetchDefaultBranch(repoPath: string): Promise<string> {
    try {
      // Try to get the default branch from the remote's HEAD ref
      const defaultBranchCmd = "git symbolic-ref refs/remotes/origin/HEAD --short";
      const defaultBranch = await this.execInRepository(repoPath, defaultBranchCmd);
      // Format is usually "origin/main", so we need to remove the "origin/" prefix
      const result = defaultBranch.trim().replace(/^origin\//, "");
      return result;
    } catch (error) {
      // Log error but don't throw
      console.error("Could not determine default branch, falling back to 'main'", {
        error: error instanceof Error ? error.message : String(error),
        repoPath,
      });
      // Fall back to main
      return "main";
    }
  }
}

/**
 * Interface-agnostic function to create a pull request
 * This implements the interface agnostic command architecture pattern
 */
export async function createPullRequestFromParams(params: {
  session?: string;
  repo?: string;
  branch?: string;
  taskId?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}): Promise<{ markdown: string; statusUpdateResult?: any }> {
  try {
    const git = new GitService();
    const result = await git.pr({
      session: params.session,
      repoPath: params.repo,
      branch: params.branch,
      taskId: params.taskId,
      debug: params.debug,
      noStatusUpdate: params.noStatusUpdate,
    });
    return result;
  } catch (error) {
    log.error("Error creating pull request", {
      session: params.session,
      repo: params.repo,
      branch: params.branch,
      taskId: params.taskId,
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
export async function commitChangesFromParams(params: {
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
  } catch (error) {
    log.error("Error committing changes", {
      session: params.session,
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
export async function preparePrFromParams(params: {
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
    const result = await git.preparePr({
      session: params.session,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      title: params.title,
      body: params.body,
      branchName: params.branchName,
      debug: params.debug,
    });
    return result;
  } catch (error) {
    log.error("Error preparing PR branch", {
      session: params.session,
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
export async function mergePrFromParams(params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
}): Promise<MergePrResult> {
  try {
    const git = new GitService();
    const result = await git.mergePr({
      prBranch: params.prBranch,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      session: params.session,
    });
    return result;
  } catch (error) {
    log.error("Error merging PR branch", {
      prBranch: params.prBranch,
      baseBranch: params.baseBranch,
      session: params.session,
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
export async function cloneFromParams(params: {
  url: string;
  session?: string;
  destination?: string;
  branch?: string;
}): Promise<CloneResult> {
  try {
    const git = new GitService();
    const result = await git.clone({
      repoUrl: params.url,
      session: params.session,
      destination: params.destination,
      branch: params.branch,
    });
    return result;
  } catch (error) {
    log.error("Error cloning repository", {
      url: params.url,
      session: params.session,
      destination: params.destination,
      branch: params.branch,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to create a branch
 */
export async function branchFromParams(params: {
  session: string;
  name: string;
}): Promise<BranchResult> {
  try {
    const git = new GitService();
    const result = await git.branch({
      session: params.session,
      branch: params.name,
    });
    return result;
  } catch (error) {
    log.error("Error creating branch", {
      session: params.session,
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
export async function pushFromParams(params: {
  session?: string;
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  try {
    const git = new GitService();
    const result = await git.push({
      session: params.session,
      repoPath: params.repo,
      remote: params.remote,
      force: params.force,
      debug: params.debug,
    });
    return result;
  } catch (error) {
    log.error("Error pushing changes", {
      session: params.session,
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
export function createGitService(options?: { baseDir?: string }): GitServiceInterface {
  return new GitService(options?.baseDir);
}
