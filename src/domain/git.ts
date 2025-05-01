import { join } from 'path';
import { mkdir, symlink } from 'fs/promises';
import { exec as childExec } from 'child_process';
import { promisify } from 'util';
import type { ExecException } from 'child_process';
import { normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';
import { createRepositoryBackend } from './repository';
import type { RepositoryBackendConfig } from './repository';

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

export interface CloneOptions {
  repoUrl: string;
  session?: string;
  backend?: 'local' | 'github';
  github?: {
    token?: string;
    owner?: string;
    repo?: string;
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

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
    this.sessionDb = new SessionDB();
  }

  private generateSessionId = generateSessionId;

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private getSessionWorkdir(repoName: string, session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, repoName, 'sessions', session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();
    
    const session = options.session || this.generateSessionId();
    
    // Create repository backend configuration
    const backendConfig: RepositoryBackendConfig = {
      type: options.backend || 'local',
      repoUrl: options.repoUrl,
      github: options.github
    };
    
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
      type: backendType as 'local' | 'github',
      repoUrl: record.repoUrl,
      github: record.github
    };
    
    // Create backend instance
    const backend = await createRepositoryBackend(backendConfig);
    
    // Create the branch using the backend
    return await backend.branch(options.session, options.branch);
  }
  
  async pr(options: PrOptions): Promise<PrResult> {
    const execAsync = promisify(childExec);
    return this.prWithDependencies(options, {
      execAsync,
      getSession: async (name) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName, session) => this.getSessionWorkdir(repoName, session),
      getSessionByTaskId: async (taskId) => this.sessionDb.getSessionByTaskId(taskId)
    });
  }
  
  // Exposed for testing with dependency injection
  async prWithDependencies(options: PrOptions, deps: PrTestDependencies): Promise<PrResult> {
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
      // Handle cases where repoName is missing in older records
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
      
      if (options.debug) {
        console.error(`[DEBUG] Using session '${sessionRecord.session}' for task '${normalizedTaskId}'`);
      }
    } else {
      throw new Error('Either session, repoPath, or taskId must be provided');
    }
    
    // Determine the branch name
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
          if (options.debug) {
            console.error(`[DEBUG] Found remote HEAD branch: ${baseBranch}`);
          }
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to get remote HEAD: ${err}`);
        }
      }
      
      // Try to find upstream branch if no remote HEAD
      if (!baseBranch) {
        try {
          const { stdout: upstream } = await deps.execAsync(`git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`);
          if (upstream && !upstream.includes("fatal:")) {
            baseBranch = upstream.replace(/^origin\//, "").trim();
            if (options.debug) {
              console.error(`[DEBUG] Found upstream branch: ${baseBranch}`);
            }
          }
        } catch (err) {
          if (options.debug) {
            console.error(`[DEBUG] Failed to get upstream branch: ${err}`);
          }
        }
      }
      
      // Try 'main' if it exists
      if (!baseBranch) {
        try {
          const { stdout: mainExists } = await deps.execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/main || echo "not found"`);
          if (!mainExists.includes("not found")) {
            baseBranch = 'main';
            if (options.debug) {
              console.error(`[DEBUG] Using 'main' as base branch`);
            }
          }
        } catch (err) {
          if (options.debug) {
            console.error(`[DEBUG] Failed to check for 'main' branch: ${err}`);
          }
        }
      }
      
      // Try 'master' if it exists and 'main' doesn't
      if (!baseBranch) {
        try {
          const { stdout: masterExists } = await deps.execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/master || echo "not found"`);
          if (!masterExists.includes("not found")) {
            baseBranch = 'master';
            if (options.debug) {
              console.error(`[DEBUG] Using 'master' as base branch`);
            }
          }
        } catch (err) {
          if (options.debug) {
            console.error(`[DEBUG] Failed to check for 'master' branch: ${err}`);
          }
        }
      }
    }
    
    // Find the merge base if we have a base branch
    if (baseBranch) {
      try {
        const { stdout: mergeBaseOut } = await deps.execAsync(`git -C ${workdir} merge-base ${baseBranch} ${branch}`);
        mergeBase = mergeBaseOut.trim();
        comparisonDescription = `Changes compared to \`${baseBranch}\``;
        if (options.debug) {
          console.error(`[DEBUG] Found merge base with ${baseBranch}: ${mergeBase}`);
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to find merge base: ${err}`);
        }
      }
    }

    // If no merge base found, use first commit
    if (!mergeBase) {
      try {
        const { stdout: firstCommit } = await deps.execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
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
      `git -C ${workdir} ls-files --others --exclude-standard --full-name`
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
      .map(file => `A\t${file}`);
    
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

    // Debug output
    if (options.debug) {
      console.error(`[DEBUG] Running diff stats command: git -C ${workdir} diff --shortstat ${mergeBase} ${branch}`);
      console.error(`[DEBUG] Stat output:`, statOut);
      console.error(`[DEBUG] Working directory stat:`, wdStatOut);
    }

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
}
