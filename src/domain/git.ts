import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeRepoName } from "./repo-utils.js";
import { SessionDB } from "./session.js";
import { TaskService, TASK_STATUS } from "./tasks.js";
import {
  GitPullRequestParams,
  GitCommitParams,
  CreatePrParams,
  CommitChangesParams,
  createPrParamsSchema,
  commitChangesParamsSchema,
} from "../schemas/git.js";
import { MinskyError, ValidationError } from "../errors/index.js";
import { z } from "zod";
import { resolveRepoPath } from "./repo-utils.js";
import { normalizeTaskId } from "../utils/task-utils.js";
import { CreatePrParamsSchema, CommitChangesParamsSchema } from "../schemas/git.js";
import { DEFAULT_PR_TEMPLATE } from "./templates.js";
import { GitPrOptions, PrDependencies, PrResult, PrOptions, GitResult } from "../schemas/git.js";

const execAsync = promisify(exec);

export interface CloneOptions {
  repoUrl: string;
  session?: string;
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

// Added new interface for dependency injection to make testing easier
export interface PrDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
  getSessionByTaskId?: (taskId: string) => Promise<any>;
}

export interface PrResult {
  markdown: string;
  statusUpdateResult?: {
    taskId: string;
    previousStatus: string | null;
    newStatus: string;
  };
}

export interface GitStatus {
  modified: string[];
  untracked: string[];
  deleted: string[];
}

// Add interfaces needed for the session update command
export interface GitResult {
  workdir: string;
}

export interface StashResult extends GitResult {
  stashed: boolean;
}

export interface PullResult extends GitResult {
  updated: boolean;
}

export interface MergeResult extends GitResult {
  merged: boolean;
  conflicts: boolean;
}

export interface PushResult extends GitResult {
  pushed: boolean;
}

export interface PushOptions {
  session?: string;
  repoPath?: string;
  remote?: string;
  force?: boolean;
}

export class GitService {
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

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  // Make this public as it's needed by the update command
  getSessionWorkdir(repoName: string, session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, repoName, "sessions", session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();

    const session = options.session || this.generateSessionId();
    const repoName = normalizeRepoName(options.repoUrl);

    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, repoName, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(repoName, session);

    // Clone the repository
    await execAsync(`git clone ${options.repoUrl} ${workdir}`);

    return {
      workdir,
      session,
    };
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    const record = await this.sessionDb.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    // Handle cases where repoName is missing in older records
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    const workdir = this.getSessionWorkdir(repoName, options.session);
    // Create the branch in the specified session's repo
    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return {
      workdir,
      branch: options.branch,
    };
  }

  async pr(options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();

    // Create dependencies object for easier testing
    const deps: PrDependencies = {
      execAsync,
      getSession: async (name) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName, session) => this.getSessionWorkdir(repoName, session),
      getSessionByTaskId: async (taskId) => this.sessionDb.getSessionByTaskId?.(taskId),
    };

    const result = await this.prWithDependencies(options, deps);

    try {
      // Get repo path and branch for task resolution
      const workdir = await this.determineWorkingDirectory(options, deps);
      const branch = await this.determineCurrentBranch(workdir, options, deps);

      // Determine the task ID (from options, session, or branch name)
      const taskId = await this.determineTaskId(options, workdir, branch, deps);

      // If task ID is found and status update is not disabled, update the task status
      if (taskId && !options.noStatusUpdate) {
        try {
          // Create task service
          const taskService = new TaskService({
            workspacePath: workdir,
            backend: "markdown",
          });

          // Get current status for reporting
          const previousStatus = await taskService.getTaskStatus(taskId);

          // Update to IN-REVIEW
          await taskService.setTaskStatus(taskId, TASK_STATUS.IN_REVIEW);

          // Add status update info to result
          result.statusUpdateResult = {
            taskId,
            previousStatus,
            newStatus: TASK_STATUS.IN_REVIEW,
          };

          if (options.debug) {
            console.error(
              `[DEBUG] Updated task ${taskId} status: ${previousStatus || "unknown"} → ${TASK_STATUS.IN_REVIEW}`
            );
          }
        } catch (error) {
          if (options.debug) {
            console.error(
              `[DEBUG] Failed to update task status: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          // Don't fail the PR generation if status update fails
        }
      }
    } catch (error) {
      if (options.debug) {
        console.error(
          `[DEBUG] Task status update skipped: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  }

  /**
   * Implementation of PR generation with injectable dependencies for testing
   */
  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    await this.ensureBaseDir();

    // Determine the working directory
    const workdir = await this.determineWorkingDirectory(options, deps);

    if (options.debug) {
      console.error(`[DEBUG] Using workdir: ${workdir}`);
    }

    // Determine branch
    const branch = await this.determineCurrentBranch(workdir, options, deps);

    if (options.debug) {
      console.error(`[DEBUG] Using branch: ${branch}`);
    }

    // Find the base branch and merge base
    const { baseBranch, mergeBase, comparisonDescription } =
      await this.determineBaseBranchAndMergeBase(workdir, branch, options, deps);

    if (options.debug) {
      console.error(`[DEBUG] Using merge base: ${mergeBase}`);
      console.error(`[DEBUG] Comparison: ${comparisonDescription}`);
    }

    // Create the PR markdown
    const markdown = await this.generatePrMarkdown(
      workdir,
      branch,
      mergeBase,
      comparisonDescription,
      deps
    );

    return { markdown };
  }

  /**
   * Determine the working directory based on options
   */
  private async determineWorkingDirectory(
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.repoPath) {
      return options.repoPath;
    }

    if (options.session) {
      const session = await deps.getSession(options.session);
      if (!session) {
        throw new Error(`Session '${options.session}' not found`);
      }
      return deps.getSessionWorkdir(session.repoName, session.session);
    }

    if (options.taskId) {
      const session = await deps.getSessionByTaskId?.(options.taskId);
      if (!session) {
        throw new Error(`No session found for task '${options.taskId}'`);
      }
      return deps.getSessionWorkdir(session.repoName, session.session);
    }

    throw new Error("Either session, repoPath, or taskId must be provided");
  }

  /**
   * Determine the current branch or use the provided branch
   */
  private async determineCurrentBranch(
    workdir: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    if (options.branch) {
      return options.branch;
    }

    // Get current branch
    const { stdout } = await deps.execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
    return stdout.trim();
  }

  /**
   * Find the base branch using multiple strategies
   */
  private async findBaseBranch(
    workdir: string,
    branch: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<string> {
    // Try different strategies to find a base branch

    // 1. Remote HEAD branch
    try {
      // Use the exact command that the test is expecting
      const { stdout: remoteHeadOutput } = await deps.execAsync(
        `git -C ${workdir} remote show origin`
      );

      // Parse the remote head branch name
      const match = remoteHeadOutput.match(/HEAD branch: (.+)/);
      if (match && match[1]) {
        const baseBranch = match[1].trim();
        if (baseBranch && baseBranch !== branch) {
          if (options.debug) {
            console.error(`[DEBUG] Found remote HEAD branch: ${baseBranch}`);
          }
          return baseBranch;
        }
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get remote HEAD: ${err}`);
      }
    }

    // 2. Upstream tracking branch
    try {
      const { stdout: upstream } = await deps.execAsync(
        `git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`
      );
      if (upstream && upstream.trim() && upstream.trim() !== branch) {
        const baseBranch = upstream.trim();
        if (options.debug) {
          console.error(`[DEBUG] Found upstream branch: ${baseBranch}`);
        }
        return baseBranch;
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get upstream branch: ${err}`);
      }
    }

    // 3. Local main branch
    try {
      const { stdout: hasMain } = await deps.execAsync(
        `git -C ${workdir} show-ref --verify --quiet refs/heads/main && echo main || echo ''`
      );
      if (hasMain.trim() && hasMain.trim() !== branch) {
        if (options.debug) {
          console.error("[DEBUG] Using main as base branch");
        }
        return "main";
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to check main branch: ${err}`);
      }
    }

    // 4. Local master branch
    try {
      const { stdout: hasMaster } = await deps.execAsync(
        `git -C ${workdir} show-ref --verify --quiet refs/heads/master && echo master || echo ''`
      );
      if (hasMaster.trim() && hasMaster.trim() !== branch) {
        if (options.debug) {
          console.error("[DEBUG] Using master as base branch");
        }
        return "master";
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to check master branch: ${err}`);
      }
    }

    return "";
  }

  /**
   * Find the base branch to merge into and the merge base commit
   */
  private async determineBaseBranchAndMergeBase(
    workdir: string,
    branch: string,
    options: PrOptions,
    deps: PrDependencies
  ): Promise<{ baseBranch: string; mergeBase: string; comparisonDescription: string }> {
    let baseBranch = "";
    let mergeBase = "";
    let comparisonDescription = "";

    // 1. Try to determine the base branch
    baseBranch = await this.findBaseBranch(workdir, branch, options, deps);

    if (options.debug && baseBranch) {
      console.error(`[DEBUG] Using base branch: ${baseBranch}`);
    }

    // 2. Find the merge base between the branches
    if (baseBranch) {
      try {
        // Use the exact command format that the test expects
        const { stdout: mb } = await deps.execAsync(
          `git -C ${workdir} merge-base ${baseBranch} ${branch}`
        );
        mergeBase = mb.trim();
        comparisonDescription = `Changes compared to merge-base with ${baseBranch}`;
        if (options.debug) {
          console.error(`[DEBUG] Found merge base with ${baseBranch}: ${mergeBase}`);
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to find merge base: ${err}`);
        }
      }
    }

    // 3. If no merge base found, use first commit
    if (!mergeBase) {
      try {
        const { stdout: firstCommit } = await deps.execAsync(
          `git -C ${workdir} rev-list --max-parents=0 HEAD`
        );
        mergeBase = firstCommit.trim();
        comparisonDescription = "All changes since repository creation";
        if (options.debug) {
          console.error(`[DEBUG] Using first commit as base: ${mergeBase}`);
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to find first commit: ${err}`);
        }
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

    // Format the commits data for display
    let formattedCommits = "No commits yet";
    if (commits && commits.trim()) {
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
            formattedCommits = formattedEntries.join("\n");
          }
        } else {
          // Use as-is if not in the expected format
          formattedCommits = commits;
        }
      } catch (error) {
        // In case of any parsing errors, fall back to the raw commits data
        formattedCommits = commits;
      }
    }

    // Check if we have any working directory changes
    const hasWorkingDirChanges =
      untrackedFiles.trim().length > 0 || uncommittedChanges.trim().length > 0;

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
    const { stdout: commits } = await deps.execAsync(
      `git -C ${workdir} log --oneline ${mergeBase}..${branch}`,
      { maxBuffer: 1024 * 1024 }
    );

    // Get modified files in the branch - use name-status format for test compatibility
    const { stdout: diffNameStatus } = await deps.execAsync(
      `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`,
      { maxBuffer: 1024 * 1024 }
    );

    // Also get name-only format for display
    const { stdout: modifiedFiles } = await deps.execAsync(
      `git -C ${workdir} diff --name-only ${mergeBase}..${branch}`,
      { maxBuffer: 1024 * 1024 }
    );

    // Get uncommitted changes
    let uncommittedChanges = "";
    try {
      const { stdout } = await deps.execAsync(`git -C ${workdir} diff --name-status`, {
        maxBuffer: 1024 * 1024,
      });
      uncommittedChanges = stdout;
    } catch (err) {
      // Ignore errors
    }

    // Get untracked files
    let untrackedFiles = "";
    try {
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} ls-files --others --exclude-standard`,
        { maxBuffer: 1024 * 1024 }
      );
      untrackedFiles = stdout;
    } catch (err) {
      // Ignore errors for untracked files
    }

    // Get changes stats
    let stats = "No changes";
    try {
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
      // Ignore errors
    }

    return { commits, modifiedFiles, untrackedFiles, uncommittedChanges, stats };
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
    // 1. Use the explicitly provided task ID if available
    if (options.taskId) {
      if (options.debug) {
        console.error(`[DEBUG] Using provided task ID: ${options.taskId}`);
      }
      return options.taskId;
    }

    // 2. Try to get task ID from session metadata
    if (options.session) {
      const session = await deps.getSession(options.session);
      if (session && session.taskId) {
        if (options.debug) {
          console.error(`[DEBUG] Found task ID in session metadata: ${session.taskId}`);
        }
        return session.taskId;
      }
    }

    // 3. Try to parse task ID from branch name (format: task#XXX)
    const taskIdMatch = branch.match(/task#(\d+)/);
    if (taskIdMatch && taskIdMatch[1]) {
      const taskId = `#${taskIdMatch[1]}`;
      if (options.debug) {
        console.error(`[DEBUG] Parsed task ID from branch name: ${taskId}`);
      }
      return taskId;
    }

    // No task ID could be determined
    if (options.debug) {
      console.error("[DEBUG] No task ID could be determined");
    }
    return undefined;
  }
}

/**
 * Creates a pull request document based on parameters
 */
export async function createPullRequestFromParams(
  params: any
): Promise<{
  markdown: string;
  statusUpdateResult?: { taskId: string; previousStatus?: string; newStatus: string };
}> {
  try {
    // Setup GitService
    const gitService = new GitService();

    // Forward the request to GitService.pr with the appropriate parameters
    const result = await gitService.pr({
      session: params.session,
      repoPath: params.repo,
      branch: params.branch,
      taskId: params.taskId,
      debug: params.debug,
      noStatusUpdate: params.noStatusUpdate,
    });

    return result;
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

/**
 * Commits changes based on parameters
 */
export async function commitChangesFromParams(
  params: any
): Promise<{ commitHash: string; message: string }> {
  try {
    // Resolve repository path
    const repoPath = await resolveRepoPath({
      session: params.session,
      repo: params.repo,
    });

    // Setup GitService
    const gitService = new GitService();
    const sessionDb = new SessionDB();

    // If we have a session, get session record to check for task ID
    let prefix = "";
    if (params.session) {
      const sessionRecord = await sessionDb.getSession(params.session);
      if (sessionRecord?.taskId) {
        // Add task ID as prefix to commit message
        const taskId = normalizeTaskId(sessionRecord.taskId);
        prefix = `${taskId}: `;
      }
    }

    // Stage changes if noStage was not set
    if (!params.noStage) {
      if (params.all) {
        await gitService.stageAll(repoPath);
      } else {
        await gitService.stageModified(repoPath);
      }
    }

    // Add prefix to commit message and commit changes
    const fullMessage = prefix + params.message;
    const commitHash = await gitService.commit(fullMessage, repoPath, params.amend);

    return {
      commitHash,
      message: fullMessage,
    };
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to commit changes: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
