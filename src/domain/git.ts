import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ExecException } from "node:child_process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRepoName } from "./repo-utils";
import {
  createSessionProvider,
  type SessionRecord,
  type SessionProviderInterface,
} from "./session";
import { TaskService, TASK_STATUS } from "./tasks";
import {
  MinskyError,
  createSessionNotFoundMessage,
  createErrorContext,
  getErrorMessage,
} from "../errors/index";
import { log } from "../utils/logger";
import {
  ConflictDetectionService,
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
} from "./git/conflict-detection";
import {
  execGitWithTimeout,
  gitFetchWithTimeout,
  gitMergeWithTimeout,
  gitPushWithTimeout,
} from "../utils/git-exec-enhanced";
import { preparePr as preparePrImpl } from "./git/prepare-pr";
import { cloneRepository } from "./git/clone-operations";
import { mergeBranchImpl } from "./git/merge-branch-operations";
import { pushImpl } from "./git/push-operations";
import { mergePrImpl } from "./git/merge-pr-operations";

const execAsync = promisify(exec);

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

/**
 * Interface for git service operations
 * This defines the contract for git-related functionality
 */
export interface GitServiceInterface {
  /**
   * Clone a repository and set up a session workspace
   */
  clone(options: CloneOptions): Promise<CloneResult>;

  /**
   * Create and checkout a new branch
   */
  branch(options: BranchOptions): Promise<BranchResult>;

  /**
   * Create and checkout a new branch without requiring session in database
   */
  branchWithoutSession(options: {
    repoName: string;
    session: string;
    branch: string;
  }): Promise<BranchResult>;

  /**
   * Execute a git command in a repository
   */
  execInRepository(workdir: string, command: string): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(session: string): string;

  /**
   * Stash changes in a repository
   */
  stashChanges(repoPath: string): Promise<StashResult>;

  /**
   * Pull latest changes from a remote
   */
  pullLatest(repoPath: string, remote?: string): Promise<PullResult>;

  /**
   * Merge a branch into the current branch
   */
  mergeBranch(repoPath: string, branch: string): Promise<MergeResult>;

  /**
   * Push changes to a remote
   */
  push(options: PushOptions): Promise<PushResult>;

  /**
   * Apply stashed changes
   */
  popStash(repoPath: string): Promise<StashResult>;

  /**
   * Get the status of a repository
   */
  getStatus(repoPath?: string): Promise<GitStatus>;

  /**
   * Get the current branch name
   */
  getCurrentBranch(repoPath: string): Promise<string>;

  /**
   * Check if repository has uncommitted changes
   */
  hasUncommittedChanges(repoPath: string): Promise<boolean>;

  /**
   * Fetch the default branch for a repository
   */
  fetchDefaultBranch(repoPath: string): Promise<string>;

  /**
   * Predict conflicts before performing merge operations
   */
  predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction>;

  /**
   * Analyze branch divergence between session and base branches
   */
  analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis>;

  /**
   * Enhanced merge with conflict prediction and better handling
   */
  mergeWithConflictPrevention(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult>;

  /**
   * Smart session update that detects already-merged changes
   */
  smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult>;
}

// Define PrTestDependencies first so PrDependencies can extend it
export interface PrTestDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (session: string) => string;
  getSessionByTaskId?: (taskId: string) => Promise<any>;
}

// PrDependencies now extends the proper interface
export interface PrDependencies extends PrTestDependencies {}

export interface BasicGitDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
}

export interface ExtendedGitDependencies extends BasicGitDependencies {
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (session: string) => string;
  mkdir: (path: string, options?: any) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
  access: (path: string) => Promise<void>;
}

export interface CloneOptions {
  repoUrl: string;
  workdir: string; // Explicit path where to clone, provided by caller
  session?: string;
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
    previousStatus: string | undefined;
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
  private sessionDb: SessionProviderInterface;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ||
      join((process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state"), "minsky");
    this.sessionDb = createSessionProvider({ dbPath: (process as any).cwd() });
  }

  // Add public method to get session record
  public async getSessionRecord(sessionName: string): Promise<any | undefined> {
    return (this.sessionDb as any).getSession(sessionName);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return (Math.random().toString(36) as any).substring(2, 8);
  }

  getSessionWorkdir(session: string): string {
    // NEW: Simplified session-ID-based path structure
    // Before: /git/{repoName}/sessions/{sessionId}/
    // After:  /sessions/{sessionId}/
    return join(this.baseDir, "sessions", session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();
    
    return cloneRepository(options, {
      mkdir,
      execAsync,
      access: async (path: string) => {
        const fs = await import("fs/promises");
        await fs.access(path);
      },
      readdir: async (path: string) => {
        const fs = await import("fs/promises");
        return fs.readdir(path);
      },
      rm: async (path: string, options?: any) => {
        const fs = await import("fs/promises");
        await fs.rm(path, options);
      },
    }, this.generateSessionId.bind(this));
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    log.debug("Getting session for branch", { session: (options as any).session });

    const record = await (this.sessionDb as any).getSession((options as any).session);
    if (!record) {
      throw new Error(`Session '${(options as any).session}' not found.`);
    }

    // Make sure to use the normalized repo name for consistency
    const repoName = (record as any).repoName || normalizeRepoName((record as any).repoUrl);
    log.debug("Branch: got repoName", { repoName });

    const workdir = this.getSessionWorkdir((options as any).session);
    log.debug("Branch: calculated workdir", { workdir });

    await execAsync(`git -C ${workdir} checkout -b ${(options as any).branch}`);
    return {
      workdir,
      branch: (options as any).branch,
    };
  }

  /**
   * Create a branch without requiring session record to exist in database
   * Used during session creation when session hasn't been added to DB yet
   */
  async branchWithoutSession(options: {
    repoName: string;
    session: string;
    branch: string;
  }): Promise<BranchResult> {
    await this.ensureBaseDir();

    const workdir = this.getSessionWorkdir((options as any).session);
    await execAsync(`git -C ${workdir} checkout -b ${(options as any).branch}`);

    return {
      workdir,
      branch: (options as any).branch,
    };
  }

  async pr(options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();

    const deps: PrDependencies = {
      execAsync,
      getSession: async (name: string) => (this.sessionDb as any).getSession(name),
      getSessionWorkdir: (session: string) => this.getSessionWorkdir(session),
      getSessionByTaskId: async (taskId: string) => (this.sessionDb as any).getSessionByTaskId?.(taskId),
    };

    const result = await this.prWithDependencies(options as any, deps);

    try {
      const workdir = await this.determineWorkingDirectory(options as any, deps);
      const branch = await this.determineCurrentBranch(workdir, options as any, deps);

      const taskId = await this.determineTaskId(options as any, workdir, branch, deps);

      if (taskId && !(options as any).noStatusUpdate) {
        try {
          const taskService = new TaskService({
            workspacePath: workdir,
            backend: "markdown",
          });

          const previousStatus = await (taskService as any).getTaskStatus(taskId);

          await (taskService as any).setTaskStatus(taskId, TASK_STATUS.IN_REVIEW);

          (result as any).statusUpdateResult = {
            taskId,
            previousStatus,
            newStatus: TASK_STATUS.IN_REVIEW,
          };

          if ((options as any).debug) {
            log.debug(
              `Updated task ${taskId} status: ${previousStatus || "unknown"} → ${TASK_STATUS.IN_REVIEW}`
            );
          }
        } catch (error) {
          if ((options as any).debug) {
            log.debug(`Failed to update task status: ${getErrorMessage(error as any)}`);
          }
        }
      }
    } catch (error) {
      if ((options as any).debug) {
        log.debug(`Task status update skipped: ${getErrorMessage(error as any)}`);
      }
    }

    return result;
  }

  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    await this.ensureBaseDir();

    const workdir = await this.determineWorkingDirectory(options as any, deps);

    if ((options as any).debug) {
      log.debug(`Using workdir: ${workdir}`);
    }

    const branch = await this.determineCurrentBranch(workdir, options as any, deps);

    if ((options as any).debug) {
      log.debug(`Using branch: ${branch}`);
    }

    const { baseBranch, mergeBase, comparisonDescription } =
      await this.determineBaseBranchAndMergeBase(workdir, branch, options as any, deps);

    if ((options as any).debug) {
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
    if ((options as any).repoPath) {
      return (options as any).repoPath;
    }

    // Try to resolve session from taskId if provided
    let sessionName = (options as any).session;
    if (!sessionName && (options as any).taskId) {
      if (!(deps as any).getSessionByTaskId) {
        throw new Error("getSessionByTaskId dependency not available");
      }
      const sessionRecord = await (deps as any).getSessionByTaskId((options as any).taskId);
      if (!sessionRecord) {
        throw new Error(`No session found for task ID "${(options as any).taskId}"`);
      }
      sessionName = (sessionRecord as any).session;
      log.debug("Resolved session from task ID", { taskId: (options as any).taskId, session: sessionName });
    }

    if (!sessionName) {
      throw new MinskyError(`
🚫 Cannot create PR - missing required information

You need to specify one of these options to identify the target repository:

📝 Specify a session name:
   minsky git pr --session "my-session"

🎯 Use a task ID (to auto-detect session):
   minsky git pr --task-id "123"

📁 Target a specific repository:
   minsky git pr --repo-path "/path/to/repo"

💡 If you're working in a session workspace, try running from the main workspace:
   cd /path/to/main/workspace
   minsky git pr --session "session-name"

📋 To see available sessions:
   minsky sessions list
`);
    }

    const session = await (deps as any).getSession(sessionName);
    if (!session) {
      const context = (createErrorContext().addCommand("minsky git pr") as any).build();

      throw new MinskyError(createSessionNotFoundMessage(sessionName, context as any));
    }
    const workdir = (deps as any).getSessionWorkdir(sessionName);

    log.debug("Using workdir for PR", { workdir, session: sessionName });
    return workdir;
  }

  private async determineCurrentBranch(
    workdir: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if ((options as any).branch) {
      log.debug("Using specified branch for PR", { branch: (options as any).branch });
      return (options as any).branch;
    }

    const { stdout } = await (deps as any).execAsync(`git -C ${workdir} branch --show-current`);
    const branch = (stdout as any).trim();

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
      const { stdout } = await (deps as any).execAsync(
        `git -C ${workdir} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      const baseBranch = ((stdout as any).trim() as any).replace("origin/", "");
      log.debug("Found remote HEAD branch", { baseBranch });
      return baseBranch;
    } catch (err) {
      log.debug("Failed to get remote HEAD", {
        error: getErrorMessage(err as any),
        branch,
      });
    }

    // Try to get the upstream branch
    try {
      const { stdout } = await (deps as any).execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`
      );
      const baseBranch = ((stdout as any).trim() as any).replace("origin/", "");
      log.debug("Found upstream branch", { baseBranch });
      return baseBranch;
    } catch (err) {
      log.debug("Failed to get upstream branch", {
        error: getErrorMessage(err as any),
        branch,
      });
    }

    // Check if main exists
    try {
      await (deps as any).execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/main`);
      log.debug("Using main as base branch");
      return "main";
    } catch (err) {
      log.debug("Failed to check main branch", {
        error: getErrorMessage(err as any),
      });
    }

    // Check if master exists
    try {
      await (deps as any).execAsync(`git -C ${workdir} show-ref --verify refs/remotes/origin/master`);
      log.debug("Using master as base branch");
      return "master";
    } catch (err) {
      log.debug("Failed to check master branch", {
        error: getErrorMessage(err as any),
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
    const baseBranch = await this.findBaseBranch(workdir, branch, options as any, deps);
    log.debug("Using base branch for PR", { baseBranch });

    let mergeBase: string;
    let comparisonDescription: string;

    try {
      // Find common ancestor of the current branch and the base branch
      const { stdout } = await (deps as any).execAsync(
        `git -C ${workdir} merge-base origin/${baseBranch} ${branch}`
      );
      mergeBase = (stdout as any).trim();
      comparisonDescription = `Showing changes from merge-base with ${baseBranch}`;
      log.debug("Found merge base with base branch", { baseBranch, mergeBase });
    } catch (err) {
      log.debug("Failed to find merge base", {
        error: getErrorMessage(err as any),
        branch,
        baseBranch,
      });

      // If merge-base fails, get the first commit of the branch
      try {
        const { stdout } = await (deps as any).execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
        mergeBase = (stdout as any).trim();
        comparisonDescription = "Showing changes from first commit";
        log.debug("Using first commit as base", { mergeBase });
      } catch (err) {
        log.debug("Failed to find first commit", {
          error: getErrorMessage(err as any),
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
      ((untrackedFiles as any).trim() as any).length > 0 || ((uncommittedChanges as any).trim() as any).length > 0;

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
    if (!commits || !(commits as any).trim()) {
      return "No commits yet";
    }

    try {
      // Check if the commits are in the expected format with delimiters
      if ((commits as any).includes("\x1f")) {
        // Parse the commits data with delimiters
        // Split by record separator
        const commitRecords = ((commits as any).split("\x1e") as any).filter(Boolean);
        const formattedEntries: string[] = [];

        for (const record of commitRecords) {
          // Split by field separator
          const fields = (record as any).split("\x1f");
          if ((fields as any).length > 1) {
            if (fields[0] !== undefined && fields[1] !== undefined) {
              const hash = (fields[0] as any).substring(0, 7);
              const message = fields[1];
              (formattedEntries as any).push(`${hash} ${message}`);
            }
          } else {
            // Use the record as-is if it doesn't have the expected format
            (formattedEntries as any).push((record as any).trim());
          }
        }

        if ((formattedEntries as any).length > 0) {
          return (formattedEntries as any).join("\n");
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
    (sections as any).push(modifiedFilesSection);

    // Add stats section
    (sections as any).push(`## Stats\n${stats || "No changes"}`);

    // Add working directory changes section if needed
    if (hasWorkingDirChanges) {
      let wdChanges = "## Uncommitted changes in working directory\n";
      if ((uncommittedChanges as any).trim()) {
        wdChanges += `${uncommittedChanges}\n`;
      }
      if ((untrackedFiles as any).trim()) {
        wdChanges += `${untrackedFiles}\n`;
      }
      (sections as any).push(wdChanges);
    }

    return (sections as any).join("\n");
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
      const { stdout } = await (deps as any).execAsync(
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
      const { stdout: nameStatus } = await (deps as any).execAsync(
        `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`,
        { maxBuffer: 1024 * 1024 }
      );
      diffNameStatus = nameStatus;

      // Get name-only format for display
      const { stdout: nameOnly } = await (deps as any).execAsync(
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
      const { stdout } = await (deps as any).execAsync(`git -C ${workdir} diff --name-status`, {
        maxBuffer: 1024 * 1024,
      });
      uncommittedChanges = stdout;
    } catch (err) {
      // Ignore errors for uncommitted changes
    }

    try {
      // Get untracked files
      const { stdout } = await (deps as any).execAsync(
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
      const { stdout: statOutput } = await (deps as any).execAsync(
        `git -C ${workdir} diff --stat ${mergeBase}..${branch}`,
        { maxBuffer: 1024 * 1024 }
      );

      // If we got stats from git, use them
      if (statOutput && (statOutput as any).trim()) {
        stats = (statOutput as any).trim();
      }
      // Otherwise, try to infer stats from the diff status
      else if (diffNameStatus && (diffNameStatus as any).trim()) {
        const lines = ((diffNameStatus as any).trim() as any).split("\n");
        if ((lines as any).length > 0) {
          stats = `${(lines as any).length} files changed`;
        }
      }
      // If we have uncommitted changes but no stats for the branch,
      // we should make sure those are reflected in the output
      else if ((uncommittedChanges as any).trim()) {
        const lines = ((uncommittedChanges as any).trim() as any).split("\n");
        if ((lines as any).length > 0) {
          stats = `${(lines as any).length} uncommitted files changed`;
        }
      }
    } catch (err) {
      // Ignore errors for stats
    }

    return stats;
  }

  async getStatus(repoPath?: string): Promise<GitStatus> {
    const workdir = repoPath || (process as any).cwd();

    // Get modified files
    const { stdout: modifiedOutput } = await execAsync(`git -C ${workdir} diff --name-only`);
    const modified = ((modifiedOutput.trim() as any).split("\n") as any).filter(Boolean);

    // Get untracked files
    const { stdout: untrackedOutput } = await execAsync(
      `git -C ${workdir} ls-files --others --exclude-standard`
    );
    const untracked = ((untrackedOutput.trim() as any).split("\n") as any).filter(Boolean);

    // Get deleted files
    const { stdout: deletedOutput } = await execAsync(`git -C ${workdir} ls-files --deleted`);
    const deleted = ((deletedOutput.trim() as any).split("\n") as any).filter(Boolean);

    return { modified, untracked, deleted };
  }

  async stageAll(repoPath?: string): Promise<void> {
    const workdir = repoPath || (process as any).cwd();
    await execAsync(`git -C ${workdir} add -A`);
  }

  async stageModified(repoPath?: string): Promise<void> {
    const workdir = repoPath || (process as any).cwd();
    await execAsync(`git -C ${workdir} add .`);
  }

  async commit(message: string, repoPath?: string, amend: boolean = false): Promise<string> {
    const workdir = repoPath || (process as any).cwd();
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
      if (!(status as any).trim()) {
        // No changes to stash
        return { workdir, stashed: false };
      }

      // Stash changes
      await execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(`Failed to stash changes: ${getErrorMessage(err as any)}`);
    }
  }

  async popStash(workdir: string): Promise<StashResult> {
    try {
      // Check if there's a stash to pop
      const { stdout: stashList } = await execAsync(`git -C ${workdir} stash list`);
      if (!(stashList as any).trim()) {
        // No stash to pop
        return { workdir, stashed: false };
      }

      // Pop the stash
      await execAsync(`git -C ${workdir} stash pop`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(`Failed to pop stash: ${getErrorMessage(err as any)}`);
    }
  }

  async pullLatest(workdir: string, remote: string = "origin"): Promise<PullResult> {
    try {
      // Get current commit hash before fetch
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Fetch latest changes from remote (don't pull current branch)
      // This gets all refs from remote without merging anything
      await execAsync(`git -C ${workdir} fetch ${remote}`);

      // Get commit hash after fetch (should be the same since we only fetched)
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether local working directory changed (should be false for fetch-only)
      // The 'updated' flag indicates if remote refs were updated, but we can't easily detect that
      // For session updates, the subsequent merge step will show if changes were applied
      return { workdir, updated: (beforeHash as any).trim() !== (afterHash as any).trim() };
    } catch (err) {
      throw new Error(`Failed to pull latest changes: ${getErrorMessage(err as any)}`);
    }
  }

  async mergeBranch(workdir: string, branch: string): Promise<MergeResult> {
    return mergeBranchImpl(workdir, branch, {
      execAsync,
    });
  }

  /**
   * Push the current or session branch to a remote, supporting --session, --repo, --remote, and --force.
   */
  async push(options: PushOptions): Promise<PushResult> {
    await this.ensureBaseDir();
    return pushImpl(options, {
      execAsync,
      getSession: this.sessionDb.getSession.bind(this.sessionDb),
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
    });
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
    if ((options as any).taskId) {
      log.debug("Using provided task ID", { taskId: (options as any).taskId });
      return (options as any).taskId;
    }

    // 2. Try to get taskId from session
    if ((options as any).session) {
      const session = await (deps as any).getSession((options as any).session);
      if (session && (session as any).taskId) {
        log.debug("Found task ID in session metadata", { taskId: (session as any).taskId });
        return (session as any).taskId;
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
      const { stdout } = await execAsync(command!, { cwd: workdir });
      return stdout;
    } catch (error) {
      log.error("Command execution failed", {
        error: getErrorMessage(error as any),
        command,
        workdir,
      });
      throw new MinskyError(`Failed to execute command in repository: ${getErrorMessage(error as any)}`);
    }
  }

  async preparePr(options: PreparePrOptions): Promise<PreparePrResult> {
    return preparePrImpl(options, {
      sessionDb: this.sessionDb,
      execInRepository: this.execInRepository.bind(this),
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
    });
  }

  /**
   * Convert a PR title to a branch name
   * e.g. "feat: add new feature" -> "feat-add-new-feature"
   */
  private titleToBranchName(title: string): string {
    return ((title
      .toLowerCase()
      .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
      .replace(/[^\w-]/g, "") as any).replace(/--+/g, "-") as any).replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }

  async mergePr(options: MergePrOptions): Promise<MergePrResult> {
    return mergePrImpl(options, {
      execInRepository: this.execInRepository.bind(this),
      getSession: this.sessionDb.getSession.bind(this.sessionDb),
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
    });
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
      const result = ((defaultBranch as any).trim() as any).replace(/^origin\//, "");
      return result;
    } catch (error) {
      // Log error but don't throw
      log.error("Could not determine default branch, falling back to 'main'", {
        error: getErrorMessage(error as any),
        repoPath,
      });
      // Fall back to main
      return "main";
    }
  }

  /**
   * Testable version of fetchDefaultBranch with dependency injection
   */
  async fetchDefaultBranchWithDependencies(
    repoPath: string,
    deps: {
      execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
    }
  ): Promise<string> {
    try {
      // Try to get the default branch from the remote's HEAD ref
      const { stdout } = await (deps as any).execAsync(
        `git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      // Format is usually "origin/main", so we need to remove the "origin/" prefix
      const result = ((stdout as any).trim() as any).replace(/^origin\//, "");
      return result;
    } catch (error) {
      // Log error but don't throw
      log.error("Could not determine default branch, falling back to 'main'", {
        error: getErrorMessage(error as any),
        repoPath,
      });
      // Fall back to main
      return "main";
    }
  }

  /**
   * Testable version of commit with dependency injection
   */
  async commitWithDependencies(
    message: string,
    workdir: string,
    deps: {
      execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
    },
    amend: boolean = false
  ): Promise<string> {
    const amendFlag = amend ? "--amend" : "";
    const { stdout } = await (deps as any).execAsync(
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
  async stashChangesWithDependencies(
    workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    try {
      // Check if there are changes to stash
      const { stdout: status } = await (deps as any).execAsync(`git -C ${workdir} status --porcelain`);
      if (!(status as any).trim()) {
        // No changes to stash
        return { workdir, stashed: false };
      }

      // Stash changes
      await (deps as any).execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(`Failed to stash changes: ${getErrorMessage(err as any)}`);
    }
  }

  /**
   * Testable version of popStash with dependency injection
   */
  async popStashWithDependencies(
    workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    try {
      // Check if there's a stash to pop
      const { stdout: stashList } = await (deps as any).execAsync(`git -C ${workdir} stash list`);
      if (!(stashList as any).trim()) {
        // No stash to pop
        return { workdir, stashed: false };
      }

      // Pop the stash
      await (deps as any).execAsync(`git -C ${workdir} stash pop`);
      return { workdir, stashed: true };
    } catch (err) {
      throw new Error(`Failed to pop stash: ${getErrorMessage(err as any)}`);
    }
  }

  /**
   * Testable version of mergeBranch with dependency injection
   */
  async mergeBranchWithDependencies(
    workdir: string,
    branch: string,
    deps: BasicGitDependencies
  ): Promise<MergeResult> {
    try {
      // Get current commit hash
      const { stdout: beforeHash } = await (deps as any).execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch using enhanced git execution with timeout and conflict detection
      try {
        await gitMergeWithTimeout(branch, {
          workdir,
          timeout: 60000, // 60 second timeout for merge operations
          context: [
            { label: "Target branch", value: branch },
            { label: "Working directory", value: workdir },
          ],
        });
      } catch (err) {
        // Enhanced git execution will throw MinskyError with detailed conflict information
        if (err instanceof MinskyError && (err.message as any).includes("Merge Conflicts Detected")) {
          // The enhanced error message is already formatted, so we know there are conflicts
          return { workdir, merged: false, conflicts: true };
        }

        // Check if there are merge conflicts using traditional method as fallback
        const { stdout: status } = await (deps as any).execAsync(`git -C ${workdir} status --porcelain`);
        if ((status as any).includes("UU") || (status as any).includes("AA") || (status as any).includes("DD")) {
          // Abort the merge and report conflicts
          await (deps as any).execAsync(`git -C ${workdir} merge --abort`);
          return { workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await (deps as any).execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether any changes were merged
      return { workdir, merged: (beforeHash as any).trim() !== (afterHash as any).trim(), conflicts: false };
    } catch (err) {
      throw new Error(`Failed to merge branch ${branch}: ${getErrorMessage(err as any)}`);
    }
  }

  /**
   * Testable version of stageAll with dependency injection
   */
  async stageAllWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    await (deps as any).execAsync(`git -C ${workdir} add -A`);
  }

  /**
   * Testable version of stageModified with dependency injection
   */
  async stageModifiedWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    await (deps as any).execAsync(`git -C ${workdir} add .`);
  }

  /**
   * Testable version of pullLatest with dependency injection
   */
  async pullLatestWithDependencies(
    workdir: string,
    deps: BasicGitDependencies,
    remote: string = "origin"
  ): Promise<PullResult> {
    try {
      // Get current commit hash before fetch
      const { stdout: beforeHash } = await (deps as any).execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Fetch latest changes from remote using enhanced git execution with timeout
      await gitFetchWithTimeout(remote, undefined, {
        workdir,
        timeout: 30000, // 30 second timeout for fetch operations
        context: [
          { label: "Remote", value: remote },
          { label: "Working directory", value: workdir },
        ],
      });

      // Get commit hash after fetch (should be the same since we only fetched)
      const { stdout: afterHash } = await (deps as any).execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether local working directory changed (should be false for fetch-only)
      // The 'updated' flag indicates if remote refs were updated, but we can't easily detect that
      // For session updates, the subsequent merge step will show if changes were applied
      return { workdir, updated: (beforeHash as any).trim() !== (afterHash as any).trim() };
    } catch (err) {
      throw new Error(`Failed to pull latest changes: ${getErrorMessage(err as any)}`);
    }
  }

  /**
   * Testable version of clone with dependency injection
   */
  async cloneWithDependencies(
    options: CloneOptions,
    deps: ExtendedGitDependencies
  ): Promise<CloneResult> {
    await (deps as any).mkdir(this.baseDir, { recursive: true });

    const session = (options as any).session || this.generateSessionId();
    const repoName = normalizeRepoName((options as any).repoUrl);
    const normalizedRepoName = (repoName as any).replace(/[^a-zA-Z0-9-_]/g, "-");

    const sessionsDir = join(this.baseDir, normalizedRepoName, "sessions");
    await (deps as any).mkdir(sessionsDir, { recursive: true });

    const workdir = this.getSessionWorkdir(session);

    try {
      // Validate repo URL
      if (!(options as any).repoUrl || (options.repoUrl as any).trim() === "") {
        throw new Error("Repository URL is required for cloning");
      }

      // Check if destination already exists and is not empty
      try {
        const dirContents = await (deps as any).readdir(workdir);
        if ((dirContents as any).length > 0) {
          log.warn("Destination directory is not empty", { workdir, contents: dirContents });
        }
      } catch (err) {
        // Directory doesn't exist or can't be read - this is expected
        log.debug("Destination directory doesn't exist or is empty", { workdir });
      }

      // Clone the repository
      const cloneCmd = `git clone ${(options as any).repoUrl} ${workdir}`;
      await (deps as any).execAsync(cloneCmd);

      // Verify the clone was successful by checking for .git directory
      try {
        const gitDir = join(workdir, ".git");
        await (deps as any).access(gitDir);
      } catch (accessErr) {
        throw new Error("Git repository was not properly cloned: .git directory not found");
      }

      return { workdir, session };
    } catch (error) {
      throw new Error(`Failed to clone git repository: ${getErrorMessage(error as any)}`);
    }
  }

  /**
   * Testable version of branch with dependency injection
   */
  async branchWithDependencies(
    options: BranchOptions,
    deps: PrDependencies
  ): Promise<BranchResult> {
    const record = await (deps as any).getSession((options as any).session);
    if (!record) {
      throw new Error(`Session '${(options as any).session}' not found.`);
    }

    const workdir = (deps as any).getSessionWorkdir((options as any).session);

    await (deps as any).execAsync(`git -C ${workdir} checkout -b ${(options as any).branch}`);
    return {
      workdir,
      branch: (options as any).branch,
    };
  }

  /**
   * Testable version of push with dependency injection
   */
  async pushWithDependencies(options: PushOptions, deps: PrDependencies): Promise<PushResult> {
    let workdir: string;
    let branch: string;
    const remote = (options as any).remote || "origin";

    // 1. Resolve workdir
    if ((options as any).session) {
      const record = await (deps as any).getSession((options as any).session);
      if (!record) {
        throw new Error(`Session '${(options as any).session}' not found.`);
      }
      workdir = (deps as any).getSessionWorkdir((options as any).session);
      branch = (options as any).session; // Session branch is named after the session
    } else if ((options as any).repoPath) {
      workdir = (options as any).repoPath;
      // Get current branch from repo
      const { stdout: branchOut } = await (deps as any).execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = (branchOut as any).trim();
    } else {
      // Try to infer from current directory
      workdir = (process as any).cwd();
      // Get current branch from cwd
      const { stdout: branchOut } = await (deps as any).execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref HEAD`
      );
      branch = (branchOut as any).trim();
    }

    // 2. Validate remote exists
    const { stdout: remotesOut } = await (deps as any).execAsync(`git -C ${workdir} remote`);
    const remotes = ((remotesOut
      .split("\n") as any).map((r) => r.trim()) as any).filter(Boolean);
    if (!(remotes as any).includes(remote)) {
      throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
    }

    // 3. Build push command
    let pushCmd = `git -C ${workdir} push ${remote} ${branch}`;
    if ((options as any).force) {
      pushCmd += " --force";
    }

    // 4. Execute push
    try {
      await (deps as any).execAsync(pushCmd);
      return { workdir, pushed: true };
    } catch (err: any) {
      // Provide helpful error messages for common issues
      if ((err as any).stderr && (err.stderr as any).includes("[rejected]")) {
        throw new Error(
          "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
        );
      }
      if ((err as any).stderr && (err.stderr as any).includes("no upstream")) {
        throw new Error(
          "No upstream branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
        );
      }
      throw new Error((err as any).stderr || (err as any).message || String(err as any));
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
    return (stdout as any).trim();
  }

  /**
   * Check if repository has uncommitted changes
   */
  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const { stdout } = await execAsync(`git -C ${repoPath} status --porcelain`);
    return ((stdout as any).trim() as any).length > 0;
  }

  /**
   * Predict conflicts before performing merge operations
   */
  async predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    return (ConflictDetectionService as any).predictConflicts(repoPath, sourceBranch, targetBranch);
  }

  /**
   * Analyze branch divergence between session and base branches
   */
  async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    return (ConflictDetectionService as any).analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);
  }

  /**
   * Enhanced merge with conflict prediction and better handling
   */
  async mergeWithConflictPrevention(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult> {
    return (ConflictDetectionService as any).mergeWithConflictPrevention(
      repoPath,
      sourceBranch,
      targetBranch,
      options as any
    );
  }

  /**
   * Smart session update that detects already-merged changes
   */
  async smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult> {
    return (ConflictDetectionService as any).smartSessionUpdate(
      repoPath,
      sessionBranch,
      baseBranch,
      options as any
    );
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
      session: (params as any).session,
      repoPath: (params as any).repo,
      branch: (params as any).branch,
      taskId: (params as any).taskId,
      debug: (params as any).debug,
      noStatusUpdate: (params as any).noStatusUpdate,
    });
    return result;
  } catch (error) {
    log.error("Error creating pull request", {
      session: (params as any).session,
      repo: (params as any).repo,
      branch: (params as any).branch,
      taskId: (params as any).taskId,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
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

    if (!(params as any).noStage) {
      if ((params as any).all) {
        await git.stageAll((params as any).repo);
      } else {
        await git.stageModified((params as any).repo);
      }
    }

    const commitHash = await (git as any).commit((params as any).message, (params as any).repo, (params as any).amend);

    return {
      commitHash,
      message: (params as any).message,
    };
  } catch (error) {
    log.error("Error committing changes", {
      session: (params as any).session,
      repo: (params as any).repo,
      message: (params as any).message,
      all: (params as any).all,
      amend: (params as any).amend,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
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
  const git = new GitService();
  return await git.preparePr({
    session: (params as any).session,
    repoPath: (params as any).repo,
    baseBranch: (params as any).baseBranch,
    title: (params as any).title,
    body: (params as any).body,
    branchName: (params as any).branchName,
    debug: (params as any).debug,
  });
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
      prBranch: (params as any).prBranch,
      repoPath: (params as any).repo,
      baseBranch: (params as any).baseBranch,
      session: (params as any).session,
    });
    return result;
  } catch (error) {
    log.error("Error merging PR branch", {
      prBranch: (params as any).prBranch,
      baseBranch: (params as any).baseBranch,
      session: (params as any).session,
      repo: (params as any).repo,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to clone a repository
 */
export async function cloneFromParams(params: {
  url: string;
  workdir: string; // Explicit workdir path
  session?: string;
  branch?: string;
}): Promise<CloneResult> {
  try {
    const git = new GitService();
    const result = await git.clone({
      repoUrl: (params as any).url,
      workdir: (params as any).workdir,
      session: (params as any).session,
      branch: (params as any).branch,
    });
    return result;
  } catch (error) {
    log.error("Error cloning repository", {
      url: (params as any).url,
      session: (params as any).session,
      branch: (params as any).branch,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
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
    const result = await (git as any).branch({
      session: (params as any).session,
      branch: (params as any).name,
    });
    return result;
  } catch (error) {
    log.error("Error creating branch", {
      session: (params as any).session,
      name: (params as any).name,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
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
      session: (params as any).session,
      repoPath: (params as any).repo,
      remote: (params as any).remote,
      force: (params as any).force,
      debug: (params as any).debug,
    });
    return result;
  } catch (error) {
    log.error("Error pushing changes", {
      session: (params as any).session,
      repo: (params as any).repo,
      remote: (params as any).remote,
      force: (params as any).force,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? (error as any).stack : undefined,
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
  return new GitService((options as any).baseDir);
}

/**
 * Interface-agnostic function to merge branches with conflict detection
 */
export async function mergeFromParams(params: {
  sourceBranch: string;
  targetBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<EnhancedMergeResult> {
  try {
    const git = new GitService();
    const repoPath = params.repo || git.getSessionWorkdir(params.session || "");
    const targetBranch = params.targetBranch || "HEAD";
    
    const result = await git.mergeWithConflictPrevention(
      repoPath,
      params.sourceBranch,
      targetBranch,
      {
        dryRun: params.preview,
        autoResolveDeleteConflicts: params.autoResolve,
        skipConflictCheck: false
      }
    );
    
    return result;
  } catch (error) {
    log.error("Error merging branches", {
      sourceBranch: params.sourceBranch,
      targetBranch: params.targetBranch,
      session: params.session,
      repo: params.repo,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to checkout/switch branches with conflict detection
 */
export async function checkoutFromParams(params: {
  branch: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{ 
  workdir: string; 
  switched: boolean; 
  conflicts: boolean; 
  conflictDetails?: string; 
  warning?: { wouldLoseChanges: boolean; recommendedAction: string } 
}> {
  try {
    const git = new GitService();
    const repoPath = params.repo || git.getSessionWorkdir(params.session || "");
    
    // Use ConflictDetectionService to check for branch switch conflicts
    const { ConflictDetectionService } = await import("./git/conflict-detection");
    
    if (params.preview) {
      // Just preview the operation
      const warning = await ConflictDetectionService.checkBranchSwitchConflicts(repoPath, params.branch);
      return {
        workdir: repoPath,
        switched: false,
        conflicts: warning.wouldLoseChanges,
        conflictDetails: warning.wouldLoseChanges ? 
          `Switching to ${params.branch} would lose uncommitted changes. ${warning.recommendedAction}` : 
          undefined,
        warning: {
          wouldLoseChanges: warning.wouldLoseChanges,
          recommendedAction: warning.recommendedAction
        }
      };
    }
    
    // Perform actual checkout
    await git.execInRepository(repoPath, `checkout ${params.branch}`);
    
    return {
      workdir: repoPath,
      switched: true,
      conflicts: false
    };
  } catch (error) {
    log.error("Error checking out branch", {
      branch: params.branch,
      session: params.session,
      repo: params.repo,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Interface-agnostic function to rebase branches with conflict detection
 */
export async function rebaseFromParams(params: {
  baseBranch: string;
  featureBranch?: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{
  workdir: string;
  rebased: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  prediction?: {
    canAutoResolve: boolean;
    recommendations: string[];
    overallComplexity: string;
  };
}> {
  try {
    const git = new GitService();
    const repoPath = params.repo || git.getSessionWorkdir(params.session || "");
    const featureBranch = params.featureBranch || "HEAD";
    
    // Use ConflictDetectionService to predict rebase conflicts
    const { ConflictDetectionService } = await import("./git/conflict-detection");
    
    const prediction = await ConflictDetectionService.predictRebaseConflicts(
      repoPath,
      params.baseBranch,
      featureBranch
    );
    
    if (params.preview) {
      // Just preview the operation
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: !prediction.canAutoResolve,
        conflictDetails: prediction.recommendations.join("\n"),
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity
        }
      };
    }
    
    // Perform actual rebase if no conflicts or auto-resolve enabled
    if (prediction.canAutoResolve || params.autoResolve) {
      await git.execInRepository(repoPath, `rebase ${params.baseBranch}`);
      return {
        workdir: repoPath,
        rebased: true,
        conflicts: false,
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity
        }
      };
    } else {
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: true,
        conflictDetails: "Rebase would create conflicts. Use --preview to see details or --auto-resolve to attempt automatic resolution.",
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity
        }
      };
    }
  } catch (error) {
    log.error("Error rebasing branch", {
      baseBranch: params.baseBranch,
      featureBranch: params.featureBranch,
      session: params.session,
      repo: params.repo,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
