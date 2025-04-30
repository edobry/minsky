import { join } from 'path';
import { mkdir, symlink } from 'fs/promises';
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
  private readonly sessionDB: SessionDB;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
    this.sessionDB = new SessionDB();
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
    const repoName = normalizeRepoName(options.repoUrl);
    
    // Create the repository path with the new sessions subdirectory structure
    const workdir = await this.sessionDB.getNewSessionRepoPath(repoName, session);
    
    // Create the workdir's parent directories
    await mkdir(join(workdir, '..'), { recursive: true });
    
    // Clone the repository
    await execAsync(`git clone ${options.repoUrl} ${workdir}`);
    
    // Add the session to the database
    await this.sessionDB.addSession({
      session,
      repoUrl: options.repoUrl,
      repoName,
      repoPath: workdir,
      createdAt: new Date().toISOString()
    });
    
    return {
      workdir,
      session
    };
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    const record = await this.sessionDB.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    
    // Get the session's working directory using the SessionDB, which will check both old and new paths
    const workdir = await this.sessionDB.getSessionWorkdir(options.session);
    
    // Create the branch in the specified session's repo
    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    
    // Update the session record with the branch information
    await this.sessionDB.updateSession(options.session, {
      branch: options.branch
    });
    
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
      const record = await this.sessionDB.getSession(options.session);
      if (!record) {
        throw new Error(`Session '${options.session}' not found.`);
      }
      workdir = await this.sessionDB.getSessionWorkdir(options.session);
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
      // fallback to first commit
      const { stdout: firstCommit } = await execAsync(`git -C ${workdir} rev-list --max-parents=0 ${branch}`);
      mergeBase = firstCommit.trim();
      comparisonDescription = `All changes since repository creation`;
    }

    if (options.debug) {
      console.error(`[DEBUG] Using base branch: ${baseBranch}`);
      console.error(`[DEBUG] Using merge base: ${mergeBase}`);
    }

    // Get a list of all files changed
    const { stdout: filesOut } = await execAsync(
      `git -C ${workdir} diff --name-status ${mergeBase} ${branch}`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get changed files: ${err}`);
      }
      return { stdout: '' };
    });
    
    // Get uncommitted changes
    const { stdout: uncommittedOut } = await execAsync(
      `git -C ${workdir} diff --name-status`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get uncommitted changes: ${err}`);
      }
      return { stdout: '' };
    });

    // Get untracked files
    const { stdout: untrackedOut } = await execAsync(
      `git -C ${workdir} ls-files --others --exclude-standard --full-name`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get untracked files: ${err}`);
      }
      return { stdout: '' };
    });

    // Get a list of all commits
    const { stdout: commitsOut } = await execAsync(
      `git -C ${workdir} log --oneline ${mergeBase}..${branch}`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get commits: ${err}`);
      }
      return { stdout: '' };
    });

    // Simple stats
    const { stdout: statsOut } = await execAsync(
      `git -C ${workdir} diff --stat ${mergeBase} ${branch}`
    ).catch((err) => {
      if (options.debug) {
        console.error(`[DEBUG] Failed to get stats: ${err}`);
      }
      return { stdout: '' };
    });

    // Format the changes
    const filesByType = filesOut.split('\n')
      .filter(Boolean)
      .reduce<Record<string, string[]>>((acc, line: string) => {
        const type = line[0];
        if (type) {
          const file = line.substring(2);
          if (!acc[type]) acc[type] = [];
          acc[type].push(file);
        }
        return acc;
      }, {});

    const commits = commitsOut.split('\n').filter(Boolean);

    let markdownOutput = `# Pull Request for branch \`${branch}\`\n\n`;

    // Add commits
    markdownOutput += `## Commits\n`;
    if (commits.length) {
      for (const commit of commits) {
        markdownOutput += `- ${commit}\n`;
      }
    } else {
      markdownOutput += `- **${workdir}**\n`;
    }

    // Add changed files
    markdownOutput += `\n## Modified Files (${comparisonDescription})\n`;
    
    if (Object.keys(filesByType).length) {
      for (const [type, files] of Object.entries(filesByType)) {
        for (const file of files) {
          let typeChar = '';
          switch (type) {
            case 'A': typeChar = 'A'; break; // Added
            case 'M': typeChar = 'M'; break; // Modified
            case 'D': typeChar = 'D'; break; // Deleted
            case 'R': typeChar = 'R'; break; // Renamed
            case 'C': typeChar = 'C'; break; // Copied
            case 'U': typeChar = 'U'; break; // Unmerged
            case 'T': typeChar = 'T'; break; // Type changed
            default: typeChar = '?';
          }
          markdownOutput += `- ${typeChar === '?' ? type : typeChar}\t${file}\n`;
        }
      }
    } else {
      markdownOutput += `- ${workdir}\n`;
    }

    // Add stats
    markdownOutput += `\n## Stats\n${statsOut.trim() || workdir}`;

    // Add uncommitted changes
    if (uncommittedOut.trim() || untrackedOut.trim()) {
      markdownOutput += `\n\n_Uncommitted changes in working directory:_\n`;
      if (uncommittedOut.trim()) {
        markdownOutput += uncommittedOut.split('\n').filter(Boolean).map(line => {
          const type = line[0];
          const file = line.substring(2);
          let typeChar = '';
          switch (type) {
            case 'A': typeChar = 'A'; break; // Added
            case 'M': typeChar = 'M'; break; // Modified
            case 'D': typeChar = 'D'; break; // Deleted
            case 'R': typeChar = 'R'; break; // Renamed
            case 'C': typeChar = 'C'; break; // Copied
            default: typeChar = '?';
          }
          return `- ${typeChar === '?' ? type : typeChar}\t${file}`;
        }).join('\n');
      }
      if (untrackedOut.trim()) {
        if (uncommittedOut.trim()) markdownOutput += '\n';
        markdownOutput += untrackedOut.split('\n').filter(Boolean).map(file => `- U\t${file}`).join('\n');
      }
    }

    return {
      markdown: markdownOutput
    };
  }
}
