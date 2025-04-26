import { join } from 'path';
import { mkdir, symlink } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

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

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();
    
    const session = options.session || this.generateSessionId();
    const workdir = join(this.baseDir, session);
    
    // Create the workdir
    await mkdir(workdir, { recursive: true });
    
    // Clone the repository
    await execAsync(`git clone ${options.repoUrl} ${workdir}`);
    
    return {
      workdir,
      session
    };
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = join(this.baseDir, options.session);
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
      workdir = join(this.baseDir, options.session);
    } else if (options.repoPath) {
      workdir = options.repoPath;
    } else {
      throw new Error('Either session or repoPath must be provided');
    }
    
    // Determine branch
    let branch = options.branch;
    if (!branch) {
      // Get current branch
      const { stdout } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
      branch = stdout.trim();
    }

    // Find the base branch to merge into (prefer remote HEAD, then upstream, then main, then master)
    let baseBranch = '';
    // 1. Remote HEAD branch
    try {
      const { stdout: remoteHead } = await execAsync(`git -C ${workdir} remote show origin | grep 'HEAD branch' | awk '{print $NF}'`);
      if (remoteHead && remoteHead.trim() && remoteHead.trim() !== branch) {
        baseBranch = remoteHead.trim();
      }
    } catch {}
    // 2. Upstream tracking branch
    if (!baseBranch) {
      try {
        const { stdout: upstream } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref ${branch}@{upstream}`);
        if (upstream && upstream.trim() && upstream.trim() !== branch) {
          baseBranch = upstream.trim();
        }
      } catch {}
    }
    // 3. Local main branch
    if (!baseBranch) {
      try {
        const { stdout: hasMain } = await execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/main && echo main || echo ''`);
        if (hasMain.trim() && hasMain.trim() !== branch) {
          baseBranch = 'main';
        }
      } catch {}
    }
    // 4. Local master branch
    if (!baseBranch) {
      try {
        const { stdout: hasMaster } = await execAsync(`git -C ${workdir} show-ref --verify --quiet refs/heads/master && echo master || echo ''`);
        if (hasMaster.trim() && hasMaster.trim() !== branch) {
          baseBranch = 'master';
        }
      } catch {}
    }
    // 5. If still not found, just use the first commit
    let mergeBase = '';
    let comparisonDescription = '';
    if (baseBranch) {
      try {
        const { stdout: mb } = await execAsync(`git -C ${workdir} merge-base ${branch} ${baseBranch}`);
        mergeBase = mb.trim();
        comparisonDescription = `Changes compared to merge-base with ${baseBranch}`;
      } catch {}
    }
    if (!mergeBase) {
      // fallback to first commit
      const { stdout: firstCommit } = await execAsync(`git -C ${workdir} rev-list --max-parents=0 ${branch}`);
      mergeBase = firstCommit.trim();
      comparisonDescription = `All changes since repository creation`;
    }

    // Get a list of all files changed
    const { stdout: filesOut } = await execAsync(
      `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`
    ).catch(() => ({ stdout: '' }));
    let files = filesOut.trim().split("\n").filter(Boolean);

    // Basic stats for committed changes
    const statCmd = `git -C ${workdir} diff --shortstat ${mergeBase} ${branch}`;
    const { stdout: statOut } = await execAsync(statCmd).catch(() => ({ stdout: '' }));
    // Also get working directory diff stats
    const { stdout: wdStatOut } = await execAsync(`git -C ${workdir} diff --shortstat`).catch(() => ({ stdout: '' }));
    // Debug output
    if (options.debug) {
      console.error(`[DEBUG] Using base branch: ${baseBranch}`);
      console.error(`[DEBUG] Using merge base: ${mergeBase}`);
      console.error(`[DEBUG] Running: ${statCmd}`);
      console.error(`[DEBUG] Stat output:`, statOut);
      console.error(`[DEBUG] Working directory stat:`, wdStatOut);
    }

    // Markdown output
    let md = `# Pull Request for branch \`${branch}\`\n\n`;
    md += `## Commits\n`;
    const { stdout: logOut } = await execAsync(
      `git -C ${workdir} log --reverse --pretty=format:"%H%x1f%s%x1f%b%x1e" ${branch}`
    );
    const commits = logOut
      .split("\x1e")
      .filter(Boolean)
      .map(line => {
        const [hash, title, body] = line.split("\x1f");
        return { hash, title, body };
      });
    for (const c of commits) {
      md += `- **${c.title}**\n`;
      if (c.body && c.body.trim()) md += `  \n  ${c.body.trim().replace(/\n/g, '  \n')}\n`;
    }
    
    md += `\n## Modified Files (${comparisonDescription})\n`;
    if (files.length === 0) {
      md += "*No modified files detected with the current comparison method*\n";
    } else {
      for (const f of files) {
        md += `- ${f}\n`;
      }
    }
    
    md += `\n## Stats\n`;
    if (statOut.trim()) {
      md += statOut.trim() + '\n';
    } else {
      md += "*No stats available with the current comparison method*\n";
    }
    if (wdStatOut.trim()) {
      md += `\n_Uncommitted changes in working directory:_\n` + wdStatOut.trim() + '\n';
    }
    
    return { markdown: md };
  }
}
