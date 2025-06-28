import { promises as fs } from "fs";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";

/**
 * Configuration options for SpecialWorkspaceManager
 */
export interface SpecialWorkspaceOptions {
  /** Repository URL to clone from */
  repoUrl: string;
  /** Base directory for special workspace (defaults to ~/.local/state/minsky) */
  baseDir?: string;
  /** Workspace name (defaults to 'task-operations') */
  workspaceName?: string;
  /** Lock timeout in milliseconds (defaults to 5 minutes) */
  lockTimeoutMs?: number;
}

/**
 * Lock file information
 */
interface LockInfo {
  operation: string;
  timestamp: number;
  processId: number;
}

/**
 * SpecialWorkspaceManager manages a persistent, git-synchronized workspace
 * for task operations that need to be isolated and atomic across different
 * execution contexts (main workspace, session workspaces, CLI calls).
 */
export class SpecialWorkspaceManager {
  private readonly workspacePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;

  constructor(private options: SpecialWorkspaceOptions) {
    const baseDir = options.baseDir || join(homedir(), ".local", "state", "minsky");
    const workspaceName = options.workspaceName || "task-operations";
    
    this.workspacePath = join(baseDir, workspaceName);
    this.lockPath = join(this.workspacePath, ".minsky-lock");
    this.lockTimeoutMs = options.lockTimeoutMs || 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Get the workspace path, ensuring it's properly initialized
   */
  async getWorkspacePath(): Promise<string> {
    await this.ensureWorkspaceExists();
    return this.workspacePath;
  }

  /**
   * Perform an operation with proper locking and synchronization
   */
  async performOperation<T>(
    operation: string,
    callback: (workspacePath: string) => Promise<T>
  ): Promise<T> {
    await this.acquireLock(operation);
    
    try {
      // Ensure workspace is up to date
      await this.updateWorkspace();
      
      // Execute the operation
      const result = await callback(this.workspacePath);
      
      // Commit and push changes
      await this.commitAndPushChanges(operation);
      
      return result;
    } catch (error) {
      // Attempt to rollback on error
      await this.rollbackChanges();
      throw error;
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Update workspace to latest upstream changes
   */
  private async updateWorkspace(): Promise<void> {
    try {
      await execAsync("git pull --rebase origin main", { cwd: this.workspacePath });
      log.debug({
        message: "Special workspace updated to latest upstream",
        workspacePath: this.workspacePath
      });
    } catch (error) {
      // If update fails, try to repair the workspace
      await this.repairWorkspace();
    }
  }

  /**
   * Commit and push changes to upstream
   */
  private async commitAndPushChanges(operation: string): Promise<void> {
    try {
      // Check if there are changes to commit
      const { stdout: statusOutput } = await execAsync("git status --porcelain", {
        cwd: this.workspacePath
      });
      
      if (statusOutput.trim()) {
        // Stage all changes
        await execAsync("git add -A", { cwd: this.workspacePath });
        
        // Commit with operation description
        const timestamp = new Date().toISOString();
        const commitMessage = `${operation} - ${timestamp}`;
        await execAsync(`git commit -m "${commitMessage}"`, { cwd: this.workspacePath });
        
        // Push changes
        await execAsync("git push origin main", { cwd: this.workspacePath });
        
        log.debug({
          message: "Successfully committed and pushed changes",
          operation,
          workspacePath: this.workspacePath
        });
      }
    } catch (error) {
      log.error("Failed to commit and push changes", { error, operation });
      throw error;
    }
  }

  /**
   * Rollback the last commit if something goes wrong
   */
  private async rollbackChanges(): Promise<void> {
    try {
      // Reset to previous commit
      await execAsync("git reset --hard HEAD~1", { cwd: this.workspacePath });
      
      // Force push to remote (dangerous but necessary for rollback)
      await execAsync("git push --force origin main", { cwd: this.workspacePath });
      
      log.debug({
        message: "Successfully rolled back last commit",
        workspacePath: this.workspacePath
      });
    } catch (error) {
      log.error("Failed to rollback changes", { error });
      // Don't throw here - original error is more important
    }
  }

  /**
   * Repair workspace by re-cloning if git operations fail
   */
  private async repairWorkspace(): Promise<void> {
    try {
      log.debug({
        message: "Repairing special workspace by re-cloning",
        workspacePath: this.workspacePath
      });
      
      // Remove corrupted workspace
      await fs.rm(this.workspacePath, { recursive: true, force: true });
      
      // Re-create the workspace
      await this.createWorkspace();
      
      log.debug({
        message: "Successfully repaired special workspace"
      });
    } catch (error) {
      log.error("Failed to repair workspace", { error });
      throw error;
    }
  }

  /**
   * Acquire a lock for the operation
   */
  private async acquireLock(operation: string): Promise<void> {
    const maxRetries = Math.ceil(this.lockTimeoutMs / 1000); // Check every second
    let retries = 0;

    while (retries < maxRetries) {
      try {
        // Check if lock file exists
        if (existsSync(this.lockPath)) {
          const lockContent = await fs.readFile(this.lockPath, "utf8");
          const lockInfo: LockInfo = JSON.parse(lockContent);
          
          // Check if lock is stale (older than timeout)
          const now = Date.now();
          if (now - lockInfo.timestamp > this.lockTimeoutMs) {
            // Remove stale lock
            await fs.unlink(this.lockPath);
          } else {
            // Wait and retry
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries++;
            continue;
          }
        }

        // Create lock file
        const lockInfo: LockInfo = {
          operation,
          timestamp: Date.now(),
          processId: Bun?.pid || process.pid || 0
        };
        
        await fs.writeFile(this.lockPath, JSON.stringify(lockInfo, null, 2));
        return; // Successfully acquired lock
        
      } catch (error) {
        if (retries >= maxRetries - 1) {
          throw error;
        }
        retries++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`Failed to acquire lock for operation "${operation}" within timeout`);
  }

  /**
   * Release the lock
   */
  private async releaseLock(): Promise<void> {
    try {
      if (existsSync(this.lockPath)) {
        await fs.unlink(this.lockPath);
      }
    } catch (error) {
      log.error("Failed to release lock", { error });
      // Don't throw - this is cleanup
    }
  }

  /**
   * Ensure the special workspace exists and is properly initialized
   */
  private async ensureWorkspaceExists(): Promise<void> {
    if (!existsSync(this.workspacePath)) {
      await this.createWorkspace();
    } else {
      // Verify it's a valid git repository
      const gitDir = join(this.workspacePath, ".git");
      if (!existsSync(gitDir)) {
        await this.createWorkspace();
      }
    }
  }

  /**
   * Create the special workspace with optimizations
   */
  private async createWorkspace(): Promise<void> {
    try {
      // Ensure parent directory exists
      await fs.mkdir(dirname(this.workspacePath), { recursive: true });
      
      log.debug({
        message: "Creating optimized special workspace",
        workspacePath: this.workspacePath,
        repoUrl: this.options.repoUrl
      });
      
      // Clone with optimizations for speed
      const cloneCommand = [
        "git clone",
        "--depth 1",              // Shallow clone for speed
        "--single-branch",        // Only main branch
        "--branch main",          // Specify main branch
        this.options.repoUrl,
        this.workspacePath
      ].join(" ");
      
      await execAsync(cloneCommand);
      
      // Configure git for automated commits
      await execAsync("git config user.name 'Minsky Task Operations'", {
        cwd: this.workspacePath
      });
      await execAsync("git config user.email 'minsky@localhost'", {
        cwd: this.workspacePath
      });
      
      log.debug({
        message: "Successfully created optimized workspace",
        workspacePath: this.workspacePath
      });
      
    } catch (error) {
      log.error("Failed to create special workspace", { error });
      throw error;
    }
  }

  /**
   * Create a SpecialWorkspaceManager instance with default configuration
   */
  static async create(repoUrl: string, options?: Partial<SpecialWorkspaceOptions>): Promise<SpecialWorkspaceManager> {
    const fullOptions: SpecialWorkspaceOptions = {
      repoUrl,
      ...options
    };
    
    const manager = new SpecialWorkspaceManager(fullOptions);
    await manager.ensureWorkspaceExists();
    return manager;
  }
} 
