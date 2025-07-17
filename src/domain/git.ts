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
import { getMinskyStateDir } from "../utils/paths";
import {
  ConflictDetectionService,
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
} from "./git/conflict-detection";
import { validateError, validateGitError } from "../schemas/error";
import { validateDirectoryContents, validateExecResult, validateProcess } from "../schemas/runtime";
import {
  execGitWithTimeout,
  gitFetchWithTimeout,
  gitMergeWithTimeout,
  gitPushWithTimeout,
} from "../utils/git-exec-enhanced";
import { 
  preparePrImpl, 
  type PreparePrOptions, 
  type PreparePrResult 
} from "./git/prepare-pr-operations";
import { 
  mergePrImpl, 
  type MergePrOptions, 
  type MergePrResult 
} from "./git/merge-pr-operations";
import { 
  mergeBranchImpl 
} from "./git/merge-branch-operations";
import { 
  prWithDependenciesImpl,
  type PrOptions,
  type PrResult 
} from "./git/pr-generation-operations";
import { 
  pushImpl,
  type PushOptions,
  type PushResult 
} from "./git/push-operations";
import { 
  cloneImpl,
  type CloneOptions,
  type CloneResult 
} from "./git/clone-operations";

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



export interface BranchOptions {
  session: string;
  branch: string;
}

export interface BranchResult {
  workdir: string;
  branch: string;
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





export interface GitResult {
  workdir: string;
}





export class GitService implements GitServiceInterface {
  private readonly baseDir: string;
  private sessionDb: SessionProviderInterface;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || getMinskyStateDir();
    this.sessionDb = createSessionProvider({ dbPath: (process as any).cwd() });
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

  getSessionWorkdir(session: string): string {
    // NEW: Simplified session-ID-based path structure
    // Before: /git/{repoName}/sessions/{sessionId}/
    // After:  /sessions/{sessionId}/
    return join(this.baseDir, "sessions", session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();

    const fs = await import("fs/promises");
    return cloneImpl(options, {
      execAsync,
      mkdir: fs.mkdir,
      readdir: fs.readdir,
      access: fs.access,
      rm: fs.rm,
      generateSessionId: this.generateSessionId.bind(this)
    });
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

    const workdir = this.getSessionWorkdir(options.session);
    log.debug("Branch: calculated workdir", { workdir });

    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return {
      workdir,
      branch: options.branch,
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

    const workdir = this.getSessionWorkdir(options.session);
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
      getSessionWorkdir: (session: string) => this.getSessionWorkdir(session),
      getSessionByTaskId: async (taskId: string) =>
        this.sessionDb.getSessionByTaskId?.(taskId),
    };

    const result = await this.prWithDependencies(options, deps);

    try {
      // Use the same logic as prWithDependencies to get workdir and branch
      const workdir = await this.getWorkingDirectoryForOptions(options, deps);
      const branch = await this.getCurrentBranchForOptions(workdir, options, deps);

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
            log.debug(`Failed to update task status: ${getErrorMessage(error as any)}`);
          }
        }
      }
    } catch (error) {
      if (options.debug) {
        log.debug(`Task status update skipped: ${getErrorMessage(error as any)}`);
      }
    }

    return result;
  }

  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    const extendedDeps = {
      ...deps,
      ensureBaseDir: () => this.ensureBaseDir()
    };
    
    return await prWithDependenciesImpl(options, extendedDeps);
  }

  private async getWorkingDirectoryForOptions(options: PrOptions, deps: PrDependencies): Promise<string> {
    if (options.repoPath) {
      return options.repoPath;
    }

    let sessionName = options.session;
    if (!sessionName && options.taskId) {
      if (!deps.getSessionByTaskId) {
        throw new Error("getSessionByTaskId dependency not available");
      }
      const sessionRecord = await deps.getSessionByTaskId(options.taskId);
      if (!sessionRecord) {
        throw new Error(`No session found for task ID "${options.taskId}"`);
      }
      sessionName = sessionRecord.session;
    }

    if (!sessionName) {
      throw new Error("No session name available");
    }

    return deps.getSessionWorkdir(sessionName);
  }

  private async getCurrentBranchForOptions(workdir: string, options: PrOptions, deps: PrDependencies): Promise<string> {
    if (options.branch) {
      return options.branch;
    }

    const { stdout } = await deps.execAsync(`git -C ${workdir} branch --show-current`);
    return stdout.trim();
  }

  async getStatus(repoPath?: string): Promise<GitStatus> {
    const workdir = repoPath || (process as any).cwd();

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
      if (!status.trim()) {
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
      if (!stashList.trim()) {
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
      return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (err) {
      throw new Error(`Failed to pull latest changes: ${getErrorMessage(err as any)}`);
    }
  }

  async mergeBranch(workdir: string, branch: string): Promise<MergeResult> {
    return mergeBranchImpl(workdir, branch, {
      execAsync
    });
  }

  /**
   * Push the current or session branch to a remote, supporting --session, --repo, --remote, and --force.
   */
  async push(options: PushOptions): Promise<PushResult> {
    await this.ensureBaseDir();
    
    return pushImpl(options, {
      execAsync,
      getSession: (sessionName: string) => this.sessionDb.getSession(sessionName),
      getSessionWorkdir: (sessionName: string) => this.getSessionWorkdir(sessionName)
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
      const { stdout } = await execAsync(command!, { cwd: workdir });
      return stdout;
    } catch (error) {
      log.error("Command execution failed", {
        error: getErrorMessage(error as any),
        command,
        workdir,
      });
      throw new MinskyError(
        `Failed to execute command in repository: ${getErrorMessage(error as any)}`
      );
    }
  }

  async preparePr(options: PreparePrOptions): Promise<PreparePrResult> {
    return preparePrImpl(options, {
      sessionDb: this.sessionDb,
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
      execInRepository: this.execInRepository.bind(this),
      push: this.push.bind(this),
    });
  }

  /**
   * Convert a PR title to a branch name
   * e.g. "feat: add new feature" -> "feat-add-new-feature"
   */
  private titleToBranchName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
      .replace(/[^\w-]/g, "").replace(/--+/g, "-").replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }

  async mergePr(options: MergePrOptions): Promise<MergePrResult> {
    return mergePrImpl(options, {
      sessionDb: this.sessionDb,
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
      execInRepository: this.execInRepository.bind(this),
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
      const result = defaultBranch.trim().replace(/^origin\//, "");
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
      const { stdout } = await deps.execAsync(
        `git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD --short`
      );
      // Format is usually "origin/main", so we need to remove the "origin/" prefix
      const result = stdout.trim().replace(/^origin\//, "");
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
  async stashChangesWithDependencies(
    workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    try {
      // Check if there are changes to stash
      const { stdout: status } = await deps.execAsync(
        `git -C ${workdir} status --porcelain`
      );
      if (!status.trim()) {
        // No changes to stash
        return { workdir, stashed: false };
      }

      // Stash changes
      await deps.execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
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
      const { stdout: stashList } = await deps.execAsync(`git -C ${workdir} stash list`);
      if (!stashList.trim()) {
        // No stash to pop
        return { workdir, stashed: false };
      }

      // Pop the stash
      await deps.execAsync(`git -C ${workdir} stash pop`);
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
      const { stdout: beforeHash } = await deps.execAsync(
        `git -C ${workdir} rev-parse HEAD`
      );

      // Try to merge the branch using dependency-injected execution
      try {
        await deps.execAsync(`git -C ${workdir} merge ${branch}`);
      } catch (err) {
        // Check if the error indicates merge conflicts
        if (
          err instanceof Error &&
          (err.message.includes("Merge Conflicts Detected") ||
            err.message.includes("CONFLICT"))
        ) {
          // The error message indicates conflicts
          return { workdir, merged: false, conflicts: true };
        }

        // Check if there are merge conflicts using traditional method as fallback
        const { stdout: status } = await deps.execAsync(
          `git -C ${workdir} status --porcelain`
        );
        if (
          status.includes("UU") ||
          status.includes("AA") ||
          status.includes("DD")
        ) {
          // Abort the merge and report conflicts
          await deps.execAsync(`git -C ${workdir} merge --abort`);
          return { workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await deps.execAsync(
        `git -C ${workdir} rev-parse HEAD`
      );

      // Return whether any changes were merged
      return {
        workdir,
        merged: beforeHash.trim() !== afterHash.trim(),
        conflicts: false,
      };
    } catch (err) {
      throw new Error(`Failed to merge branch ${branch}: ${getErrorMessage(err as any)}`);
    }
  }

  /**
   * Testable version of stageAll with dependency injection
   */
  async stageAllWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    await deps.execAsync(`git -C ${workdir} add -A`);
  }

  /**
   * Testable version of stageModified with dependency injection
   */
  async stageModifiedWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    await deps.execAsync(`git -C ${workdir} add .`);
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
      const { stdout: beforeHash } = await deps.execAsync(
        `git -C ${workdir} rev-parse HEAD`
      );

      // Fetch latest changes from remote using dependency-injected execution
      await deps.execAsync(`git -C ${workdir} fetch ${remote}`);

      // Get commit hash after fetch (should be the same since we only fetched)
      const { stdout: afterHash } = await deps.execAsync(
        `git -C ${workdir} rev-parse HEAD`
      );

      // Return whether local working directory changed (should be false for fetch-only)
      // The 'updated' flag indicates if remote refs were updated, but we can't easily detect that
      // For session updates, the subsequent merge step will show if changes were applied
      return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (err) {
      throw new Error(`Failed to pull latest changes: ${getErrorMessage(err as any)}`);
    }
  }



  /**
   * Testable version of branch with dependency injection
   */
  async branchWithDependencies(
    options: BranchOptions,
    deps: PrDependencies
  ): Promise<BranchResult> {
    const record = await deps.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }

    const workdir = deps.getSessionWorkdir(options.session);

    await deps.execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return {
      workdir,
      branch: options.branch,
    };
  }



  /**
   * Get the current branch name
   */
  async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
    return stdout.trim();
  }

  /**
   * Check if repository has uncommitted changes
   */
  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const { stdout } = await execAsync(`git -C ${repoPath} status --porcelain`);
    return stdout.trim().length > 0;
  }

  /**
   * Predict conflicts before performing merge operations
   */
  async predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    return ConflictDetectionService.predictConflicts(repoPath, sourceBranch, targetBranch);
  }

  /**
   * Analyze branch divergence between session and base branches
   */
  async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    return ConflictDetectionService.analyzeBranchDivergence(
      repoPath,
      sessionBranch,
      baseBranch
    );
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
    return ConflictDetectionService.mergeWithConflictPrevention(
      repoPath,
      sourceBranch,
      targetBranch,
      options
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
    return ConflictDetectionService.smartSessionUpdate(
      repoPath,
      sessionBranch,
      baseBranch,
      options
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

    if (!params.noStage) {
      if (params.all) {
        await git.stageAll(params.repo);
      } else {
        await git.stageModified(params.repo);
      }
    }

    const commitHash = await git.commit(
      params.message,
      params.repo,
      params.amend
    );

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
    session: params.session,
    repoPath: params.repo,
    baseBranch: params.baseBranch,
    title: params.title,
    body: params.body,
    branchName: params.branchName,
    debug: params.debug,
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
      repoUrl: params.url,
      workdir: params.workdir,
      session: params.session,
      branch: params.branch,
    });
    return result;
  } catch (error) {
    log.error("Error cloning repository", {
      url: params.url,
      session: params.session,
      branch: params.branch,
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
    const result = await git.branch({
      session: params.session,
      branch: params.name,
    });
    return result;
  } catch (error) {
    log.error("Error creating branch", {
      session: params.session,
      name: params.name,
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
  return new GitService(options?.baseDir);
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
        skipConflictCheck: false,
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
  warning?: { wouldLoseChanges: boolean; recommendedAction: string };
}> {
  try {
    const git = new GitService();
    const repoPath = params.repo || git.getSessionWorkdir(params.session || "");

    // Use ConflictDetectionService to check for branch switch conflicts
    const { ConflictDetectionService } = await import("./git/conflict-detection");

    if (params.preview) {
      // Just preview the operation
      const warning = await ConflictDetectionService.checkBranchSwitchConflicts(
        repoPath,
        params.branch
      );
      return {
        workdir: repoPath,
        switched: false,
        conflicts: warning.wouldLoseChanges,
        conflictDetails: warning.wouldLoseChanges
          ? `Switching to ${params.branch} would lose uncommitted changes. ${warning.recommendedAction}`
          : undefined,
        warning: {
          wouldLoseChanges: warning.wouldLoseChanges,
          recommendedAction: warning.recommendedAction,
        },
      };
    }

    // Perform actual checkout
    await git.execInRepository(repoPath, `checkout ${params.branch}`);

    return {
      workdir: repoPath,
      switched: true,
      conflicts: false,
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
          overallComplexity: prediction.overallComplexity,
        },
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
          overallComplexity: prediction.overallComplexity,
        },
      };
    } else {
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: true,
        conflictDetails:
          "Rebase would create conflicts. Use --preview to see details or --auto-resolve to attempt automatic resolution.",
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity,
        },
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
