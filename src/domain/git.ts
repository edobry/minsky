import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRepoName } from "./repo-utils";
import { createSessionProvider, type SessionProviderInterface } from "./session";

import { MinskyError, NothingToCommitError, getErrorMessage } from "../errors/index";
import { log } from "../utils/logger";
import { getMinskyStateDir } from "../utils/paths";
import {
  ConflictDetectionService,
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
} from "./git/conflict-detection";
import { preparePrImpl } from "./git/prepare-pr-operations";
import { mergePrImpl } from "./git/merge-pr-operations";
import { mergeBranchImpl } from "./git/merge-branch-operations";
import { prWithDependenciesImpl } from "./git/pr-generation-operations";
import { pushImpl } from "./git/push-operations";
import { cloneImpl, type CloneDependencies } from "./git/clone-operations";

// Re-export all types from the dedicated types module
export type {
  GitServiceInterface,
  PrTestDependencies,
  PrDependencies,
  BasicGitDependencies,
  ExtendedGitDependencies,
  BranchOptions,
  BranchResult,
  GitStatus,
  StashResult,
  PullResult,
  MergeResult,
  GitResult,
  CloneOptions,
  CloneResult,
  PrOptions,
  PrResult,
  PushOptions,
  PushResult,
  PreparePrOptions,
  PreparePrResult,
  MergePrOptions,
  MergePrResult,
  ExecCallback,
} from "./git/types";

// Re-export *FromParams facade functions
export {
  createPullRequestFromParams,
  commitChangesFromParams,
  preparePrFromParams,
  mergePrFromParams,
  cloneFromParams,
  branchFromParams,
  pushFromParams,
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
} from "./git/git-params-facade";

// Import types needed by GitService implementation
import type {
  GitServiceInterface,
  PrDependencies,
  BasicGitDependencies,
  BranchOptions,
  BranchResult,
  GitStatus,
  StashResult,
  PullResult,
  MergeResult,
  CloneOptions,
  CloneResult,
  PrOptions,
  PrResult,
  PushOptions,
  PushResult,
  PreparePrOptions,
  PreparePrResult,
  MergePrOptions,
  MergePrResult,
} from "./git/types";

const execAsync = promisify(exec);

/**
 * Returns true when a caught git exec error represents "nothing to commit".
 * Extracted to avoid duplicating this check in `commit` and `commitWithDependencies`.
 */
function classifyNothingToCommit(err: unknown): boolean {
  const msg = (
    (err as any)?.stderr ||
    (err as any)?.stdout ||
    (err as any)?.message ||
    ""
  ).toString();
  return msg.includes("nothing to commit") || msg.includes("nothing added to commit");
}

/**
 * Extracts the commit hash from git commit output (stdout + stderr).
 * Falls back to `git log -1` via the provided async resolver when the hash
 * cannot be parsed from the raw output (e.g. when hooks redirect git's output).
 */
async function extractCommitHash(
  stdout: string,
  stderr: string,
  logFallback: () => Promise<string>
): Promise<string> {
  const combinedOutput = `${stdout}\n${stderr || ""}`;
  const match = combinedOutput.match(/\[.*\s+([a-f0-9]+)\]/);
  if (match?.[1]) {
    return match[1];
  }

  try {
    const logOutput = await logFallback();
    const hash = logOutput.trim();
    if (hash && /^[a-f0-9]{7,40}$/.test(hash)) {
      return hash;
    }
  } catch (_logErr) {
    // ignore log fallback error
  }

  throw new Error("Failed to extract commit hash from git output");
}

export class GitService implements GitServiceInterface {
  private readonly baseDir: string;
  private sessionDb: SessionProviderInterface | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || getMinskyStateDir();
  }

  private async getSessionDb(): Promise<SessionProviderInterface> {
    if (!this.sessionDb) {
      this.sessionDb = await createSessionProvider({ dbPath: process.cwd() });
    }
    return this.sessionDb;
  }

  // Add public method to get session record
  public async getSessionRecord(sessionName: string): Promise<any | undefined> {
    const db = await this.getSessionDb();
    return db.getSession(sessionName);
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
      generateSessionId: this.generateSessionId.bind(this),
    });
  }

  /**
   * Testable version of clone with dependency injection
   */
  async cloneWithDependencies(
    options: CloneOptions,
    deps: CloneDependencies
  ): Promise<CloneResult> {
    await this.ensureBaseDir();
    return cloneImpl(options, deps);
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    log.debug("Getting session for branch", { session: options.session });

    const record = await (await this.getSessionDb()).getSession(options.session);
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
      getSession: async (name: string) => (await this.getSessionDb()).getSession(name),
      getSessionWorkdir: (session: string) => this.getSessionWorkdir(session),
      getSessionByTaskId: async (taskId: string) =>
        (await this.getSessionDb()).getSessionByTaskId?.(taskId),
    };

    // Git layer should only handle git operations, not task management
    // Task status updates are the responsibility of the session layer
    return await this.prWithDependencies(options, deps);
  }

  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    const extendedDeps = {
      ...deps,
      ensureBaseDir: () => this.ensureBaseDir(),
    };

    return await prWithDependenciesImpl(options, extendedDeps);
  }

  private async getWorkingDirectoryForOptions(
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
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

  private async getCurrentBranchForOptions(
    workdir: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.branch) {
      return options.branch;
    }

    const { stdout } = await deps.execAsync(`git -C ${workdir} branch --show-current`);
    return stdout.trim();
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

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execAsync(
        `git -C ${workdir} commit ${amendFlag} -m "${message}"`
      ));
    } catch (err: unknown) {
      if (classifyNothingToCommit(err)) {
        throw new NothingToCommitError();
      }
      throw err;
    }

    return extractCommitHash(stdout, stderr, async () => {
      const { stdout: logOutput } = await execAsync(`git -C ${workdir} log -1 --pretty=format:%H`);
      return logOutput;
    });
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

  async fetchLatest(workdir: string, remote: string = "origin"): Promise<PullResult> {
    try {
      // Get current commit hash before fetch
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Fetch latest changes from remote (don't merge anything)
      // This gets all refs from remote without merging anything
      await execAsync(`git -C ${workdir} fetch ${remote}`);

      // Get commit hash after fetch (should be the same since we only fetched)
      const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Return whether local working directory changed (should be false for fetch-only)
      // The 'updated' flag indicates if remote refs were updated, but we can't easily detect that
      // For session updates, the subsequent merge step will show if changes were applied
      return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
    } catch (err) {
      throw new Error(`Failed to fetch latest changes: ${getErrorMessage(err as any)}`);
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
      getSession: async (sessionName: string) =>
        (await this.getSessionDb()).getSession(sessionName),
      getSessionWorkdir: (sessionName: string) => this.getSessionWorkdir(sessionName),
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
      const taskId = taskIdMatch[1] || "";
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
      // Log at debug level to avoid showing expected command failures to users
      // Many git operations (like checking if branches exist) are expected to fail
      log.debug("Command execution failed", {
        error: getErrorMessage(error as any),
        command,
        workdir,
      });

      // Extract clean error message - avoid verbose output from hooks/linting
      const fullError = getErrorMessage(error as any);
      const cleanError = this.extractCleanGitError(fullError, command);

      throw new MinskyError(`Failed to execute command in repository: ${cleanError}`);
    }
  }

  /**
   * Extract a clean, concise error message from git command failures
   * Filters out verbose linting/hook output
   */
  private extractCleanGitError(fullError: string, command: string): string {
    // Look for common git error patterns first
    const gitErrorPatterns = [/fatal: (.+)/i, /error: (.+)/i, /Command failed: (.+?)(?:\n|$)/i];

    for (const pattern of gitErrorPatterns) {
      const match = fullError.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    // If no pattern matches, extract just the command that failed
    if (fullError.includes("Command failed:")) {
      const commandMatch = fullError.match(/Command failed: (.+?)(?:\s|$)/);
      if (commandMatch) {
        return commandMatch[1] || "";
      }
    }

    // Fallback: return first line that's not hook/linting output
    const lines = fullError.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.includes("husky") &&
        !trimmed.includes("eslint") &&
        !trimmed.includes("prettier") &&
        !trimmed.includes("gitleaks") &&
        !trimmed.includes("🔍") &&
        !trimmed.includes("✅") &&
        !trimmed.includes("❌")
      ) {
        return trimmed;
      }
    }

    // Ultimate fallback
    return `Command "${command}" failed`;
  }

  async preparePr(options: PreparePrOptions): Promise<PreparePrResult> {
    return preparePrImpl(options, {
      sessionDb: await this.getSessionDb(),
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
      .replace(/[^\w-]/g, "")
      .replace(/--+/g, "-")
      .replace(/^-|-$/g, ""); // Remove leading and trailing dashes
  }

  async mergePr(options: MergePrOptions): Promise<MergePrResult> {
    return mergePrImpl(options, {
      sessionDb: await this.getSessionDb(),
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

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await deps.execAsync(
        `git -C ${workdir} commit ${amendFlag} -m "${message}"`
      ));
    } catch (err: unknown) {
      if (classifyNothingToCommit(err)) {
        throw new NothingToCommitError();
      }
      throw err;
    }

    return extractCommitHash(stdout, stderr, async () => {
      const { stdout: logOutput } = await deps.execAsync(
        `git -C ${workdir} log -1 --pretty=format:%H`
      );
      return logOutput;
    });
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
      const { stdout: status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
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
      const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch using dependency-injected execution
      try {
        await deps.execAsync(`git -C ${workdir} merge ${branch}`);
      } catch (err) {
        // Check if the error indicates merge conflicts
        if (
          err instanceof Error &&
          (err.message.includes("Merge Conflicts Detected") || err.message.includes("CONFLICT"))
        ) {
          // The error message indicates conflicts
          return { workdir, merged: false, conflicts: true };
        }

        // Check if there are merge conflicts using traditional method as fallback
        const { stdout: status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
        if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
          // Abort the merge and report conflicts
          await deps.execAsync(`git -C ${workdir} merge --abort`);
          return { workdir, merged: false, conflicts: true };
        }
        throw err;
      }

      // Get new commit hash
      const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

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
   * Pull latest changes from a remote
   */
  async pullLatest(repoPath: string, remote: string = "origin"): Promise<PullResult> {
    return this.pullLatestWithDependencies(repoPath, { execAsync }, remote);
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
      const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Fetch latest changes from remote using dependency-injected execution
      await deps.execAsync(`git -C ${workdir} fetch ${remote}`);

      // Get commit hash after fetch (should be the same since we only fetched)
      const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

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
    return ConflictDetectionService.analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);
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
 * Creates a default GitService implementation
 * This factory function provides a consistent way to get a git service with optional customization
 *
 * @param options Optional configuration options for the git service
 * @returns A GitServiceInterface implementation
 */
export function createGitService(options?: { baseDir?: string }): GitServiceInterface {
  return new GitService(options?.baseDir);
}
