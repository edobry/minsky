import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { exec as childExec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecException } from 'node:child_process';
import { normalizeRepoName } from './repo-utils.js';
import { SessionDB } from './session.js';
import { createRepositoryBackend, RepositoryBackendType } from './repository/index.js';
import type { RepositoryBackendConfig } from './repository/index.js';

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;
const execAsync = promisify(childExec);

// Define missing interfaces
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
  branch?: string;
  debug?: boolean;
}

export interface PushResult {
  workdir: string;
  pushed: boolean;
  message?: string;
}

export interface PrDependencies {
  execAsync: (command: string) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
  getSessionByTaskId: (taskId: string) => Promise<any>;
}

export interface CloneOptions {
  repoUrl: string;
  session?: string;
  backend?: 'local' | 'remote' | 'github';
  branch?: string;
  github?: {
    token?: string;
    owner?: string;
    repo?: string;
  };
  remote?: {
    authMethod?: 'ssh' | 'https' | 'token';
    depth?: number;
  };
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
  baseBranch?: string;
  debug?: boolean;
}

export interface PrTestDependencies {
  execAsync: (command: string) => Promise<{ stdout: string; stderr: string }>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
  getSessionByTaskId: (taskId: string) => Promise<any>;
}

export interface PrResult {
  markdown: string;
}

function generateSessionId(): string {
  return `session-${Date.now().toString(36)}`;
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

  private generateSessionId = generateSessionId;

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  getSessionWorkdir(repoName: string, session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, repoName, 'sessions', session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();

    const session = options.session || this.generateSessionId();
    
    // Create repository backend configuration
    const backendConfig: RepositoryBackendConfig = {
      type: options.backend === 'remote' 
        ? 'remote'
        : options.backend === 'github'
          ? 'github'
          : 'local',
      repoUrl: options.repoUrl,
      branch: options.branch,
    };
    
    // Add GitHub specific config if backend is GitHub
    if (options.backend === 'github' && options.github) {
      backendConfig.github = {
        token: options.github.token,
        owner: options.github.owner,
        repo: options.github.repo
      };
    }
    
    // Add Remote options if backend is Remote or GitHub
    if ((options.backend === 'remote' || options.backend === 'github') && options.remote) {
      backendConfig.remote = {
        authMethod: options.remote.authMethod,
        depth: options.remote.depth
      };
    }

    // Create backend instance
    const backend = await createRepositoryBackend(backendConfig);
    
    // Validate repository configuration
    await backend.validate();
    
    // Clone the repository using the backend
    return await backend.clone(session);
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    const record = await this.sessionDb.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    
    // Get backend type from session record or default to 'local'
    const backendType = record.backendType || 'local';
    
    // Create repository backend configuration
    const backendConfig: RepositoryBackendConfig = {
      type: backendType as 'local' | 'remote' | 'github',
      repoUrl: record.repoUrl,
    };

    if (backendType === 'github' && record.github) {
      backendConfig.github = {
        owner: record.github.owner,
        repo: record.github.repo,
        token: record.github.token
      };
    }
    
    // Add Remote options if specified in the session record
    if ((backendType === 'remote' || backendType === 'github') && record.remote) {
      backendConfig.remote = {
        authMethod: record.remote.authMethod,
        depth: record.remote.depth
      };
    }
    
    // Create backend instance
    const backend = await createRepositoryBackend(backendConfig);
    
    // Create the branch using the backend
    return await backend.branch(options.session, options.branch);
  }
  
  async pr(options: PrOptions): Promise<PrResult> {
    const execAsync = promisify(childExec);
    const deps = {
      execAsync,
      getSession: async (name) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName, session) => this.getSessionWorkdir(repoName, session),
      getSessionByTaskId: async (taskId) => this.sessionDb.getSessionByTaskId(taskId)
    };
    
    return this.prWithDependencies(options, deps);
  }

  // Exposed for testing with dependency injection
  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    await this.ensureBaseDir();
    
    if (!options.session && !options.repoPath && !options.taskId) {
      throw new Error('Either session, repoPath, or taskId must be provided');
    }
    
    // Determine the working directory
    let workdir: string;
    
    // Precedence: session > repoPath > taskId
    if (options.session) {
      const record = await deps.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = deps.getSessionWorkdir(repoName, options.session);
    } else if (options.repoPath) {
      workdir = options.repoPath;
    } else if (options.taskId) {
      // First, normalize the task ID by removing the hash prefix if it exists
      const normalizedTaskId = options.taskId.startsWith('#') ? options.taskId : `#${options.taskId}`;
      
      // Use the sessionDb to find a session associated with this task
      const sessionRecord = await deps.getSessionByTaskId(normalizedTaskId);
      if (!sessionRecord) {
        throw new Error(`No session found for task '${normalizedTaskId}'.`);
      }
      
      const repoName = sessionRecord.repoName || normalizeRepoName(sessionRecord.repoUrl);
      workdir = deps.getSessionWorkdir(repoName, sessionRecord.session);
    } else {
      throw new Error('Either session, repoPath, or taskId must be provided');
    }
    
    // Determine branch
    let branch = options.branch;
    if (!branch) {
      // Try to get the current branch
      const { stdout: branchOut } = await deps.execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      branch = branchOut.trim();
    }

    // Determine base branch for comparison
    // Priority:
    // 1. User specified base branch
    // 2. Remote HEAD branch (e.g. 'main' or 'master' from remote)
    // 3. Upstream branch, if set
    // 4. 'main', then 'master' if they exist
    // 5. First commit in the repository
    
    let baseBranch = options.baseBranch;
    let mergeBase: string | null = null;
    let comparisonDescription = '';
    
    if (!baseBranch) {
      // Try to find remote HEAD
      try {
        const { stdout: remoteHead } = await deps.execAsync(`git -C ${workdir} remote show origin`);
        const headMatch = remoteHead.match(/HEAD branch: (.+)/);
        if (headMatch && headMatch[1]) {
          baseBranch = headMatch[1];
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to get remote HEAD: ${err}`);
        }
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
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to check master branch: ${err}`);
      }
    }
    
    // Find the merge base if we have a base branch
    if (baseBranch) {
      try {
        const { stdout: mergeBaseOut } = await deps.execAsync(`git -C ${workdir} merge-base ${baseBranch} ${branch}`);
        mergeBase = mergeBaseOut.trim();
        comparisonDescription = `Changes compared to \`${baseBranch}\``;
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
        comparisonDescription = 'All changes since repository creation';
        if (options.debug) {
          console.error(`[DEBUG] Using first commit as base: ${mergeBase}`);
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to find first commit: ${err}`);
        }
        throw new Error('Could not determine a base for comparison');
      }
    }

    // Get a list of all files changed
    const { stdout: filesOut } = await deps.execAsync(
      `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get changed files: ${err}`);
      }
      return { stdout: '' };
    });
    
    // Get uncommitted changes
    const { stdout: uncommittedOut } = await deps.execAsync(
      `git -C ${workdir} diff --name-status`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get uncommitted changes: ${err}`);
      }
      return { stdout: '' };
    });

    // Get untracked files
    const { stdout: untrackedOut } = await deps.execAsync(
      `git -C ${workdir} ls-files --others --exclude-standard`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get untracked files: ${err}`);
      }
      return { stdout: '' };
    });
    
    // Format untracked files to match git diff format (prefix with A for added)
    const untrackedFiles = untrackedOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((file: string) => `A\t${file}`);
    
    // Combine committed, uncommitted and untracked changes
    const allChanges = new Set([
      ...filesOut.trim().split("\n").filter(Boolean),
      ...uncommittedOut.trim().split("\n").filter(Boolean),
      ...untrackedFiles
    ]);
    const files = Array.from(allChanges);

    // Basic stats for committed changes
    const { stdout: statOut } = await deps.execAsync(
      `git -C ${workdir} diff --shortstat ${mergeBase} ${branch}`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get diff stats: ${err}`);
      }
      return { stdout: '' };
    });

    // Also get working directory diff stats
    const { stdout: wdStatOut } = await deps.execAsync(
      `git -C ${workdir} diff --shortstat`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get working directory stats: ${err}`);
      }
      return { stdout: '' };
    });

    // Markdown output
    let md = `# Pull Request for branch \`${branch}\`\n\n`;
    
    // Get commits between merge base and current branch
    const logCmd = `git -C ${workdir} log --reverse --pretty=format:"%H%x1f%s%x1f%b%x1e" ${mergeBase}..${branch}`;
    if (options.debug) {
      console.error(`[DEBUG] Running log command: ${logCmd}`);
    }
    
    const { stdout: logOut } = await deps.execAsync(logCmd).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get commit log: ${err}`);
      }
      return { stdout: '' };
    });
    
    const commits = logOut
      .split("\x1e")
      .filter(Boolean)
      .map(line => {
        const parts = line.split("\x1f");
        const hash = parts[0] || '';
        const title = parts[1] || '';
        const body = parts[2] || '';
        return { hash, title, body };
      });

    md += `## Commits\n`;
    if (commits.length > 0) {
      commits.forEach(commit => {
        md += `- \`${commit.hash.substring(0, 7)}\` ${commit.title}\n`;
      });
    } else {
      md += `*No commits yet*\n`;
    }
    
    md += `\n## Summary\n\n`;
    md += `${comparisonDescription}\n\n`;
    
    // Include stats if available
    if (statOut) {
      md += `${statOut.trim()}\n\n`;
    }
    
    // Include working directory changes if any
    if (wdStatOut && wdStatOut.trim()) {
      md += `*Plus uncommitted changes: ${wdStatOut.trim()}*\n\n`;
    }
    
    // Add file list
    md += `## Files Changed\n\n`;
    if (files.length > 0) {
      files.forEach(file => {
        const parts = file.split('\t');
        const status = parts[0] || '';
        const path = parts[1] || '';
        let statusEmoji = '';
        
        switch (status[0]) {
          case 'A':
            statusEmoji = '✨ Added';
            break;
          case 'M':
            statusEmoji = '🔄 Modified';
            break;
          case 'D':
            statusEmoji = '🗑️ Deleted';
            break;
          case 'R':
            statusEmoji = '📋 Renamed';
            break;
          default:
            statusEmoji = `${status}`;
        }
        
        md += `- ${statusEmoji}: \`${path}\`\n`;
      });
    } else {
      md += `*No files changed*\n`;
    }
    
    return { markdown: md };
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
      throw new Error(`Failed to stash changes: ${err instanceof Error ? err.message : String(err)}`);
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
      throw new Error(`Failed to pull latest changes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async mergeBranch(workdir: string, branch: string): Promise<MergeResult> {
    try {
      // Get current commit hash
      const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);

      // Try to merge the branch
      try {
        await execAsync(`git -C ${workdir} merge ${branch}`);
        
        // Get new commit hash
        const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);
        
        // Return whether any changes were merged
        return {
          workdir,
          merged: beforeHash.trim() !== afterHash.trim()
        };
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
    } catch (err) {
      throw new Error(`Failed to merge branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
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
      branch = options.branch || options.session; // Session branch is named after the session
    } else if (options.repoPath) {
      workdir = options.repoPath;
      // Get current branch from repo
      const { stdout: branchOut } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      branch = branchOut.trim();
    } else {
      // Try to infer from current directory
      workdir = process.cwd();
      // Get current branch from cwd
      const { stdout: branchOut } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      branch = branchOut.trim();
    }

    // 2. Validate remote exists
    const { stdout: remotesOut } = await execAsync(`git -C ${workdir} remote`);
    const remotes = remotesOut
      .split("\n")
      .map((r: string) => r.trim())
      .filter(Boolean);
    if (!remotes.includes(remote)) {
      throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
    }

    // 3. Prepare push command
    const forceFlag = options.force ? " --force" : "";
    const pushCmd = `git -C ${workdir} push ${remote} ${branch}${forceFlag}`;

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
    const gitService = new GitService();

    const options = {
      session: params.session,
      repoPath: params.repo,
      branch: params.branch,
      taskId: params.taskId,
      debug: params.debug ?? false,
      noStatusUpdate: params.noStatusUpdate ?? false,
    };

    return await gitService.pr(options);
  } catch (error) {
    console.error("Error creating pull request:", error);
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
    const gitService = new GitService();

    // Resolve repo path
    let repoPath = params.repo;
    if (params.session) {
      const sessionDb = new SessionDB();
      const session = await sessionDb.getSession(params.session);
      if (!session) {
        throw new Error(`Session '${params.session}' not found`);
      }

      // Get the repo path from session
      const repoName = session.repoName || normalizeRepoName(session.repoUrl);
      repoPath = gitService.getSessionWorkdir(repoName, params.session);
    }

    // Stage changes if needed
    if (!params.noStage) {
      if (params.all) {
        await gitService.stageAll(repoPath);
      } else {
        await gitService.stageModified(repoPath);
      }
    }

    // Commit the changes
    const commitHash = await gitService.commit(params.message, repoPath, params.amend ?? false);

    return {
      commitHash,
      message: params.message,
    };
  } catch (error) {
    console.error("Error committing changes:", error);
    throw error;
  }
}
