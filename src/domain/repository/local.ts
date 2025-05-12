import { join } from 'path';
import { mkdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SessionDB } from '../session.js';
import { normalizeRepoName } from '../repo-utils.js';
import type { RepositoryBackend, RepositoryBackendConfig, CloneResult, BranchResult, Result, RepoStatus } from './index.js';

const execAsync = promisify(exec);

/**
 * Local Git Repository Backend implementation
 * This is the default backend that uses a local git repository
 */
export class LocalGitBackend implements RepositoryBackend {
  private readonly baseDir: string;
  private readonly repoUrl: string;
  private readonly repoName: string;
  private sessionDb: SessionDB;
  private config: any;

  /**
   * Create a new LocalGitBackend instance
   * @param config Backend configuration
   */
  constructor(config: any) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
    this.repoUrl = config.repoUrl;
    this.repoName = normalizeRepoName(config.repoUrl);
    this.sessionDb = new SessionDB();
    this.config = config;
  }

  /**
   * Get the backend type
   * @returns Backend type identifier
   */
  getType(): string {
    return 'local';
  }

  /**
   * Ensure the base directory exists
   */
  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the session working directory path
   * @param session Session identifier
   * @returns Full path to the session working directory
   */
  private getSessionWorkdir(session: string): string {
    // Use the new path structure with sessions subdirectory
    return join(this.baseDir, this.repoName, 'sessions', session);
  }

  /**
   * Clone the repository for a session
   * @param session Session identifier
   * @returns Clone result with workdir and session
   */
  async clone(session: string): Promise<CloneResult> {
    await this.ensureBaseDir();
    
    // Create the repo/sessions directory structure
    const sessionsDir = join(this.baseDir, this.repoName, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    
    // Get the workdir with sessions subdirectory
    const workdir = this.getSessionWorkdir(session);
    
    // Clone the repository
    await execAsync(`git clone ${this.repoUrl} ${workdir}`);
    
    return {
      workdir,
      session
    };
  }

  /**
   * Create a branch in the repository
   * @param session Session identifier
   * @param branch Branch name
   * @returns Branch result with workdir and branch
   */
  async branch(session: string, branch: string): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = this.getSessionWorkdir(session);
    
    // Create the branch in the specified session's repo
    await execAsync(`git -C ${workdir} checkout -b ${branch}`);
    
    return {
      workdir,
      branch
    };
  }

  /**
   * Get repository status
   * @param session Session identifier
   * @returns Object with repository status information
   */
  async getStatus(session: string): Promise<RepoStatus> {
    const workdir = this.getSessionWorkdir(session);
    const { stdout: branchOutput } = await execAsync(`git -C ${workdir} rev-parse --abbrev-ref HEAD`);
    const currentBranch = branchOutput.trim();
    const { stdout: statusOutput } = await execAsync(`git -C ${workdir} status --porcelain`);
    const modifiedFiles = statusOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3)
      }));
    return {
      currentBranch,
      modifiedFiles,
      workdir
    } as unknown as RepoStatus;
  }

  /**
   * Get the repository path for a session
   * @param session Session identifier
   * @returns Full path to the repository
   */
  async getPath(session: string): Promise<string> {
    return this.getSessionWorkdir(session);
  }

  /**
   * Validate the repository configuration
   * @returns Promise that resolves if the repository is valid
   */
  async validate(): Promise<Result> {
    try {
      // If the repo is a local path, check if it has a .git directory
      if (!this.repoUrl.includes('://') && !this.repoUrl.includes('@')) {
        const { stdout } = await execAsync(`test -d "${this.repoUrl}/.git" && echo "true" || echo "false"`);
        if (stdout.trim() !== 'true') {
          throw new Error(`Not a git repository: ${this.repoUrl}`);
        }
      }
      
      // For remote repositories, we can't easily validate them without cloning
      // For now, we'll just assume they're valid
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { success: false, message: `Invalid git repository: ${error.message}` };
    }
    return { success: true, message: 'Repository is valid' };
  }

  async push(): Promise<Result> {
    // TODO: Implement local git push logic
    return { success: false, message: 'Not implemented' };
  }

  async pull(): Promise<Result> {
    // TODO: Implement local git pull logic
    return { success: false, message: 'Not implemented' };
  }
} 
