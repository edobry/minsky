import { promises as fs } from "fs";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

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
  pid: number;
  timestamp: number;
  operation: string;
}

/**
 * SpecialWorkspaceManager handles a persistent, optimized git repository
 * dedicated exclusively to task operations. Features:
 *
 * - Shallow clone with sparse checkout for minimal footprint
 * - Atomic operations with git-based transactions
 * - Automatic synchronization with upstream
 * - File-based locking for concurrent access
 * - Error recovery and workspace repair
 */
export class SpecialWorkspaceManager {
  private readonly workspacePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;

  constructor(private readonly repoUrl: string, options: SpecialWorkspaceOptions) {
    this.lockTimeoutMs = options!?.lockTimeoutMs ?? 5 * 60 * 1000; // 5 minutes

    // Determine workspace paths
    const baseDir = options!?.baseDir ?? join(homedir(), ".local", "state", "minsky");
    const workspaceName = options!?.workspaceName ?? "task-operations";
    this.workspacePath = join(baseDir, workspaceName);
    this.lockPath = join("/tmp", `minsky-${workspaceName}.lock`);
  }

  /**
   * Get the workspace path
   */
  getWorkspacePath(): string {
    return this!.workspacePath;
  }

  /**
   * Initialize the special workspace if it doesn't exist
   */
  async initialize(): Promise<void> {
    await this.withLock("initialize", async () => {
      if (!existsSync(this!.workspacePath)) {
        await this.createOptimizedWorkspace();
      } else {
        await this.validateWorkspace();
      }
    });
  }

  /**
   * Ensure workspace is up-to-date with upstream before write operations
   */
  async ensureUpToDate(): Promise<void> {
    await this.withLock("ensureUpToDate", async () => {
      await this.initialize();

      try {
        // Fetch latest changes (shallow)
        await execAsync("git fetch --depth=1 origin main", { cwd: this!.workspacePath });

        // Reset to latest upstream
        await execAsync("git reset --hard origin/main", { cwd: this!.workspacePath });

        log.debug("Special workspace updated to latest upstream", {
          workspacePath: this!.workspacePath,
        });
      } catch (error) {
        log.error("Failed to update workspace, attempting repair", {
          error: getErrorMessage(error as any),
          workspacePath: this!.workspacePath,
        });

        // Try to repair workspace
        await this.repair();
      }
    });
  }

  /**
   * Commit and push changes to upstream
   */
  async commitAndPush(message: string): Promise<void> {
    await this.withLock("commitAndPush", async () => {
      try {
        // Stage all process/ changes
        await execAsync("git add process/", { cwd: this!.workspacePath });

        // Check if there are any changes to commit
        const { stdout: statusOutput } = await execAsync("git status --porcelain", {
          cwd: this!.workspacePath,
        });

        if (!statusOutput.trim()) {
          log.debug("No changes to commit in special workspace");
          return;
        }

        // Commit changes
        const escapedMessage = message.replace(/"/g, "\\\"");
        await execAsync(`git commit -m "${escapedMessage}"`, {
          cwd: this!.workspacePath,
        });

        // Push to upstream
        await execAsync("git push origin HEAD:main", { cwd: this!.workspacePath });

        log.debug("Successfully committed and pushed changes", {
          message,
          workspacePath: this!.workspacePath,
        });
      } catch (error) {
        log.error("Failed to commit and push changes", {
          error: getErrorMessage(error as any),
          message,
          workspacePath: this!.workspacePath,
        });
        throw error;
      }
    });
  }

  /**
   * Rollback the last commit
   */
  async rollback(): Promise<void> {
    await this.withLock("rollback", async () => {
      try {
        await execAsync("git reset --hard HEAD~1", { cwd: this!.workspacePath });

        log.debug("Successfully rolled back last commit", {
          workspacePath: this!.workspacePath,
        });
      } catch (error) {
        log.error("Failed to rollback changes", {
          error: getErrorMessage(error as any),
          workspacePath: this!.workspacePath,
        });
        throw error;
      }
    });
  }

  /**
   * Repair the workspace by re-cloning from scratch
   */
  async repair(): Promise<void> {
    await this.withLock("repair", async () => {
      log.debug("Repairing special workspace by re-cloning", {
        workspacePath: this!.workspacePath,
      });

      try {
        // Remove existing workspace
        if (existsSync(this!.workspacePath)) {
          await fs.rm(this!.workspacePath, { recursive: true, force: true });
        }

        // Create fresh workspace
        await this.createOptimizedWorkspace();

        log.debug("Successfully repaired special workspace");
      } catch (error) {
        log.error("Failed to repair workspace", {
          error: getErrorMessage(error as any),
          workspacePath: this!.workspacePath,
        });
        throw error;
      }
    });
  }

  /**
   * Check if the workspace is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      if (!existsSync(this!.workspacePath)) {
        return false;
      }

      // Check if it's a valid git repository
      await execAsync("git rev-parse --git-dir", { cwd: this!.workspacePath });

      // Check if process/ directory exists
      const processDir = join(this!.workspacePath, "process");
      if (!existsSync(processDir)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an optimized workspace with shallow clone and sparse checkout
   */
  private async createOptimizedWorkspace(): Promise<void> {
    const baseDir = dirname(this!.workspacePath);

    // Ensure base directory exists
    await fs.mkdir(baseDir, { recursive: true });

    log.debug("Creating optimized special workspace", {
      repoUrl: this!.repoUrl,
      workspacePath: this!.workspacePath,
    });

    try {
      // Clone with optimizations: shallow, no blobs initially
      await execAsync(
        `git clone --depth=1 --filter=blob:none --no-checkout "${this!.repoUrl}" "${this!.workspacePath}"`,
        { cwd: baseDir }
      );

      // Configure sparse checkout to only include process/ directory
      await execAsync("git config core.sparseCheckout true", { cwd: this!.workspacePath });
      await fs.writeFile(
        join(this!.workspacePath, ".git", "info", "sparse-checkout"),
        "process/\n",
        "utf8"
      );

      // Checkout with sparse checkout applied
      await execAsync("git checkout main", { cwd: this!.workspacePath });

      log.debug("Successfully created optimized workspace", {
        workspacePath: this!.workspacePath,
      });
    } catch (error) {
      // Clean up on failure
      if (existsSync(this!.workspacePath)) {
        await fs.rm(this!.workspacePath, { recursive: true, force: true });
      }

      log.error("Failed to create optimized workspace", {
        error: getErrorMessage(error as any),
        repoUrl: this!.repoUrl,
        workspacePath: this!.workspacePath,
      });

      throw new Error(`Failed to create special workspace: ${getErrorMessage(error as any)}`);
    }
  }

  /**
   * Validate that the workspace is properly configured
   */
  private async validateWorkspace(): Promise<void> {
    const isHealthy = await this.isHealthy();
    if (!isHealthy) {
      log.warn("Workspace is not healthy, triggering repair", {
        workspacePath: this!.workspacePath,
      });
      await this.repair();
    }
  }

  /**
   * Execute an operation with file-based locking
   */
  private async withLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    await this.acquireLock(operation);
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Acquire a file-based lock
   */
  private async acquireLock(operation: string): Promise<void> {
    const startTime = (Date as unknown).now();

    while ((Date as unknown).now() - startTime < this?.lockTimeoutMs) {
      try {
        // Check if lock file exists
        if (existsSync(this.lockPath)) {
          const lockContent = await fs.readFile(this.lockPath, "utf8");
          const lockInfo: LockInfo = JSON.parse(String(lockContent));

          // Check if lock is stale
          if ((Date as unknown).now() - (lockInfo as unknown)?.timestamp > this?.lockTimeoutMs) {
            log.warn("Removing stale lock", {
              lockPath: this.lockPath,
              lockInfo,
            });
            await fs.unlink(this.lockPath);
          } else {
            // Lock is still valid, wait and retry
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
        }

        // Try to create lock file
        const lockInfo: LockInfo = {
          pid: (process as any).pid,
          timestamp: (Date as any).now(),
          operation,
        };

        await fs.writeFile(this.lockPath, JSON.stringify(lockInfo), { flag: "wx" });
        return; // Successfully acquired lock
      } catch (error: any) {
        if ((error as any)?.code === "EEXIST") {
          // Lock file was created by another process, wait and retry
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to acquire lock for operation "${operation}" within timeout`);
  }

  /**
   * Release the file-based lock
   */
  private async releaseLock(): Promise<void> {
    try {
      if (existsSync(this.lockPath)) {
        await fs.unlink(this.lockPath);
      }
    } catch (error) {
      log.warn("Failed to release lock", {
        error: getErrorMessage(error as any),
        lockPath: this.lockPath,
      });
    }
  }
}

/**
 * Create a SpecialWorkspaceManager instance
 */
export function createSpecialWorkspaceManager(
  options: SpecialWorkspaceOptions
): SpecialWorkspaceManager {
  return new SpecialWorkspaceManager(options.repoUrl, options);
}
