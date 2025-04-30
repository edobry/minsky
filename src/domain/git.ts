import { join } from 'path';
import { mkdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { normalizeRepoName } from './repo-utils';
import { SessionDB } from './session';

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
  branch?: string;
  debug?: boolean;
}

export interface PrResult {
  markdown: string;
}

export class GitService {
  private readonly baseDir: string;
  private sessionDb: SessionDB;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
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
    
    // Determine the working directory
    let workdir: string;
    if (options.session) {
      const record = await this.sessionDb.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      // Handle cases where repoName is missing in older records
      const repoName = record.repoName || normalizeRepoName(record.repoUrl);
      workdir = this.getSessionWorkdir(repoName, options.session);
    } else if (options.repoPath) {
      workdir = options.repoPath;
    } else {
      throw new Error('Either session or repoPath must be provided');
    }
    
    if (options.debug) {
      console.error(`[DEBUG] Using workdir: ${workdir}`);
    }
    
    // Determine branch
    let branch = options.branch;
    if (!branch) {
      // Get current branch
      const { stdout } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      branch = stdout.trim();
    }
    
    if (options.debug) {
      console.error(`[DEBUG] Using branch: ${branch}`);
    }

    // Find the base branch to merge into (prefer remote HEAD, then upstream, then main, then master)
    let baseBranch = '';
    // 1. Remote HEAD branch
    try {
      const { stdout: remoteHead } = await execAsync(`git -C ${workdir} remote show origin | grep 'HEAD branch' | awk '{print $NF}'`);
      if (remoteHead && remoteHead.trim() && remoteHead.trim() !== branch) {
        baseBranch = remoteHead.trim();
      }
    } catch (err) {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get remote HEAD: ${err}`);
      }
    }
    // 2. Upstream tracking branch
    if (!baseBranch) {
      try {
        const { stdout: upstream } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`);
        if (upstream && upstream.trim() && upstream.trim() !== branch) {
          baseBranch = upstream.trim();
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to get upstream branch: ${err}`);
        }
      }
    }
    // 3. Local main branch
    if (!baseBranch) {
      try {
        const { stdout: hasMain } = await execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/main && echo main || echo ''`);
        if (hasMain.trim() && hasMain.trim() !== branch) {
          baseBranch = 'main';
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to check main branch: ${err}`);
        }
      }
    }
    // 4. Local master branch
    if (!baseBranch) {
      try {
        const { stdout: hasMaster } = await execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/master && echo master || echo ''`);
        if (hasMaster.trim() && hasMaster.trim() !== branch) {
          baseBranch = 'master';
        }
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to check master branch: ${err}`);
        }
      }
    }
    // 5. If still not found, just use the first commit
    let mergeBase = '';
    let comparisonDescription = '';
    if (baseBranch) {
      try {
        const { stdout: mb } = await execAsync(`git -C ${workdir} merge-base ${branch} ${baseBranch}`);
        mergeBase = mb.trim();
        comparisonDescription = `Changes compared to merge-base with ${baseBranch}`;
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to get merge base: ${err}`);
        }
      }
    }
    if (!mergeBase) {
      try {
        const { stdout: firstCommit } = await execAsync(`git -C ${workdir} rev-list --max-parents=0 HEAD`);
        mergeBase = firstCommit.trim();
        comparisonDescription = 'All changes since repository creation';
      } catch (err) {
        if (options.debug) {
          console.error(`[DEBUG] Failed to get first commit: ${err}`);
        }
      }
    }
    
    if (options.debug) {
      console.error(`[DEBUG] Using merge base: ${mergeBase}`);
      console.error(`[DEBUG] Comparison: ${comparisonDescription}`);
    }

    // Create the PR markdown
    const markdown = await this.generatePrMarkdown(workdir, branch, mergeBase, comparisonDescription);
    
    return { markdown };
  }

  private async generatePrMarkdown(workdir: string, branch: string, mergeBase: string, comparisonDescription: string): Promise<string> {
    // Get commits on the branch
    const { stdout: commits } = await execAsync(`git -C ${workdir} log --oneline ${mergeBase}..${branch}`, { maxBuffer: 1024 * 1024 });
    
    // Get modified files in the branch
    const { stdout: modifiedFiles } = await execAsync(`git -C ${workdir} diff --name-only ${mergeBase}..${branch}`, { maxBuffer: 1024 * 1024 });
    
    // Get untracked files (only if merge base is not the first commit)
    let untrackedFiles = '';
    try {
      const { stdout } = await execAsync(`git -C ${workdir} ls-files --others --exclude-standard`, { maxBuffer: 1024 * 1024 });
      untrackedFiles = stdout;
    } catch (err) {
      // Ignore errors for untracked files
    }
    
    // Get changes stats
    const { stdout: stats } = await execAsync(`git -C ${workdir} diff --stat ${mergeBase}..${branch}`, { maxBuffer: 1024 * 1024 });
    
    // Generate the PR markdown
    return [
      `# Pull Request for branch \`${branch}\`\n`,
      `## Commits\n${commits || 'No commits yet'}\n`,
      `## Modified Files (${comparisonDescription})\n${modifiedFiles || untrackedFiles || 'No changes'}\n`,
      `## Stats\n${stats || 'No changes'}`
    ].join('\n');
  }
}
