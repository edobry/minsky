import { join } from 'path';
import { mkdir, symlink } from 'fs/promises';
import { exec as childExec } from 'child_process';
import { promisify } from 'util';
import type { ExecException } from 'child_process';
import { normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;
type ExecFunction = typeof childExec;
type PromisifiedExec = (command: string, options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

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
  branch?: string;
  baseBranch?: string;
  debug?: boolean;
}

export interface PrResult {
  markdown: string;
}

// Add a new interface for testing that allows dependency injection
export interface PrTestDependencies {
  execAsync: (command: string, options?: any) => Promise<{stdout: string, stderr: string}>;
  getSession: (sessionName: string) => Promise<any>;
  getSessionWorkdir: (repoName: string, session: string) => string;
}

export class GitService {
  private readonly baseDir: string;
  private sessionDb: SessionDB;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
    this.sessionDb = new SessionDB();
  }

  private generateSessionId(): string {
    return `test-${Math.random().toString(36).substring(2, 8)}`;
  }

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
    const repoName = normalizeRepoName(options.repoUrl);
    
    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, repoName, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    
    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(repoName, session);
    
    // Clone the repository
    await childExec(`git clone ${options.repoUrl} ${workdir}`);
    
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
    await childExec(`git -C ${workdir} checkout -b ${options.branch}`);
    return {
      workdir,
      branch: options.branch
    };
  }
  
  async pr(options: PrOptions): Promise<PrResult> {
    const execAsync = promisify(childExec);
    return this.prWithDependencies(options, {
      execAsync,
      getSession: async (name) => this.sessionDb.getSession(name),
      getSessionWorkdir: (repoName, session) => this.getSessionWorkdir(repoName, session)
    });
  }
  
  // Exposed for testing with dependency injection
  async prWithDependencies(options: PrOptions, deps: PrTestDependencies): Promise<PrResult> {
    await this.ensureBaseDir();
    
    if (!options.session && !options.repoPath) {
      throw new Error('Either session or repoPath must be provided');
    }
    
    // Determine the working directory
    let workdir: string;
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
    } else {
      throw new Error('Either session or repoPath must be provided');
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
    let comparisonDescription = 'Changes compared to merge-base with';
    
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
      
      // Check for main or master
      if (!baseBranch) {
        try {
          await deps.execAsync(`git -C ${workdir} show-ref --verify refs/heads/main`);
          baseBranch = 'main';
          if (options.debug) {
            console.error(`[DEBUG] Using 'main' as base branch`);
          }
        } catch (err) {
          try {
            await deps.execAsync(`git -C ${workdir} show-ref --verify refs/heads/master`);
            baseBranch = 'master';
            if (options.debug) {
              console.error(`[DEBUG] Using 'master' as base branch`);
            }
          } catch (err2) {
            if (options.debug) {
              console.error(`[DEBUG] Neither 'main' nor 'master' found`);
            }
          }
        }
      }
    }
    
    // Try to find merge base if we have a base branch
    if (baseBranch) {
      try {
        const { stdout } = await deps.execAsync(`git -C ${workdir} merge-base ${baseBranch} ${branch}`);
        mergeBase = stdout.trim();
        comparisonDescription = `Changes compared to merge-base with ${baseBranch}`;
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to find merge-base with ${baseBranch}: ${err}`);
        }
      }
    }
    if (!mergeBase) {
      // fallback to first commit
      const { stdout: firstCommit } = await deps.execAsync(`git -C ${workdir} rev-list --max-parents=0 ${branch}`);
      mergeBase = firstCommit.trim();
      comparisonDescription = 'All changes since repository creation';
    }

    if (options.debug) {
      console.error(`[DEBUG] Using base branch: ${baseBranch}`);
      console.error(`[DEBUG] Using merge base: ${mergeBase}`);
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
    const statCmd = `git -C ${workdir} diff --shortstat ${mergeBase} ${branch}`;
    const { stdout: statOut } = await deps.execAsync(statCmd).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get diff stats: ${err}`);
      }
      return { stdout: '' };
    });
    // Also get working directory diff stats
    const { stdout: wdStatOut } = await deps.execAsync(`git -C ${workdir} diff --shortstat`).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get working directory stats: ${err}`);
      }
      return { stdout: '' };
    });
    // Debug output
    if (options.debug) {
      console.error(`[DEBUG] Running: ${statCmd}`);
      console.error(`[DEBUG] Stat output:`, statOut);
      console.error(`[DEBUG] Working directory stat:`, wdStatOut);
    }

    // Markdown output
    let md = `# Pull Request for branch \`${branch}\`\n\n`;
    md += `## Commits\n`;
    
    // Get commits between merge base and current branch
    const logCmd = `git -C ${workdir} log --reverse --pretty=format:"%H%x1f%s%x1f%b%x1e" ${mergeBase}..${branch}`;
    if (options.debug) {
      console.error(`[DEBUG] Running: ${logCmd}`);
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
        const [hash, title, body] = line.split("\x1f");
        return { hash, title, body };
      });

    if (commits.length === 0) {
      md += '*No commits found between merge base and current branch*\n';
    } else {
      for (const c of commits) {
        md += `- **${c.title}**\n`;
        if (c.body && c.body.trim()) md += `  \n  ${c.body.trim().replace(/\n/g, '  \n')}\n`;
      }
    }
    
    md += `\n## Modified Files (${comparisonDescription})\n`;
    if (files.length === 0) {
      md += '*No modified files detected with the current comparison method*\n';
    } else {
      for (const f of files) {
        md += `- ${f}\n`;
      }
    }
    
    md += `\n## Stats\n`;
    if (statOut) {
      md += statOut;
    } else {
      md += '*No change statistics available*\n';
    }
    
    if (wdStatOut) {
      md += `\n_Uncommitted changes in working directory:_\n${wdStatOut}`;
    }
    
    return { markdown: md };
  }
}
