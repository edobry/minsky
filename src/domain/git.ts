import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";

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
}

export interface GitStatus {
  modified: string[];
  untracked: string[];
  deleted: string[];
}

export class GitService {
  private readonly baseDir: string;
  private sessionDb: SessionDB;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = join(xdgStateHome, "minsky", "git");
    this.sessionDb = new SessionDB();
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  private getSessionWorkdir(repoName: string, session: string): string {
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
      session
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
      branch: options.branch
    };
  }

  async pr(options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();
    
    // Create dependencies object for easier testing
    const deps: PrDependencies = {
      execAsync,
      getSession: async (name) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName, session) => this.getSessionWorkdir(repoName, session),
      getSessionByTaskId: async (taskId) => this.sessionDb.getSessionByTaskId?.(taskId)
    };
    
    return this.prWithDependencies(options, deps);
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
    const markdown = await this.generatePrMarkdown(workdir, branch, mergeBase, comparisonDescription, deps);
    
    return { markdown };
  }

  /**
   * Determine the working directory based on session, repoPath, or taskId
   */
  private async determineWorkingDirectory(options: PrOptions, deps: PrDependencies): Promise<string> {
    if (options.session) {
      const record = await deps.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      // Handle cases where repoName is missing in older records
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      return deps.getSessionWorkdir(repoName, options.session);
    } else if (options.repoPath) {
      return options.repoPath;
    } else if (options.taskId && deps.getSessionByTaskId) {
      // First, normalize the task ID by removing the hash prefix if it exists
      const normalizedTaskId = options.taskId.startsWith('#') ? options.taskId : `#${options.taskId}`;
      
      // Use the sessionDb to find a session associated with this task
      const sessionRecord = await deps.getSessionByTaskId(normalizedTaskId);
      if (!sessionRecord) {
        throw new Error(`No session found for task '${normalizedTaskId}'.`);
      }
      
      const repoName = sessionRecord.repoName || normalizeRepoName(sessionRecord.repoUrl);
      const workdir = deps.getSessionWorkdir(repoName, sessionRecord.session);
      
      if (options.debug) {
        console.error(`[DEBUG] Using session '${sessionRecord.session}' for task '${normalizedTaskId}'`);
      }
      
      return workdir;
    } else {
      throw new Error("Either session, repoPath, or taskId must be provided");
    }
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
          console.error(`[DEBUG] Using 'main' as base branch`);
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
          console.error(`[DEBUG] Using 'master' as base branch`);
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
        const { stdout: mb } = await deps.execAsync(`git -C ${workdir} merge-base ${baseBranch} ${branch}`);
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
        const { stdout: firstCommit } = await deps.execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
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
        if (commits.includes('\x1f')) {
          // Parse the commits data with delimiters
          // Split by record separator
          const commitRecords = commits.split('\x1e').filter(Boolean);
          const formattedEntries: string[] = [];
          
          for (const record of commitRecords) {
            // Split by field separator
            const fields = record.split('\x1f');
            if (fields.length > 1) {
              // Format as "hash message"
              const hash = fields[0].substring(0, 7);
              const message = fields[1];
              formattedEntries.push(`${hash} ${message}`);
            } else {
              // Use the record as-is if it doesn't have the expected format
              formattedEntries.push(record.trim());
            }
          }
          
          if (formattedEntries.length > 0) {
            formattedCommits = formattedEntries.join('\n');
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
    const hasWorkingDirChanges = untrackedFiles.trim().length > 0 || uncommittedChanges.trim().length > 0;
    
    // Generate the PR markdown
    let sections = [
      `# Pull Request for branch \`${branch}\`\n`,
      `## Commits\n${formattedCommits}\n`
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
      const { stdout } = await deps.execAsync(
        `git -C ${workdir} diff --name-status`, 
        { maxBuffer: 1024 * 1024 }
      );
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
        const lines = diffNameStatus.trim().split('\n');
        if (lines.length > 0) {
          stats = `${lines.length} files changed`;
        }
      }
      // If we have uncommitted changes but no stats for the branch,
      // we should make sure those are reflected in the output
      else if (uncommittedChanges.trim()) {
        const lines = uncommittedChanges.trim().split('\n');
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
    const { stdout: untrackedOutput } = await execAsync(`git -C ${workdir} ls-files --others --exclude-standard`);
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
}
