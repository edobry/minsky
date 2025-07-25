import { promises as fs } from "fs";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { execAsync } from "../../utils/exec";
import { execGitWithTimeout, gitFetchWithTimeout, gitPushWithTimeout } from "../../utils/git-exec";
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
  private currentLockTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repoUrl: string,
    options: SpecialWorkspaceOptions
  ) {
    // Reduce lock timeout for CLI operations to prevent hanging
    // 5 minutes is way too long for CLI commands that should complete quickly
    this.lockTimeoutMs = options!?.lockTimeoutMs ?? 30 * 1000; // 30 seconds instead of 5 minutes

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
      if (!existsSync(this.workspacePath)) {
        await this.createOptimizedWorkspace();
      } else {
        await this.validateWorkspace();
      }
    });
  }

  /**
   * Initialize for read-only operations - skips locking for better performance
   * Only checks if workspace exists and creates it if needed, but doesn't validate/repair
   */
  async initializeReadOnly(): Promise<void> {
    if (!existsSync(this.workspacePath)) {
      // For read operations, if workspace doesn't exist, we can't read anything
      // Fall back to creating it (this is the only case where we might need to write)
      log.debug("Workspace doesn't exist for read operation, creating it");
      await this.withLock("initialize-read-fallback", async () => {
        if (!existsSync(this.workspacePath)) {
          await this.createOptimizedWorkspace();
        }
      });
    } else {
      // Workspace exists, just do a quick health check without locking
      const isHealthy = await this.isHealthy();
      if (!isHealthy) {
        log.warn(
          "Workspace appears unhealthy for read operation, but skipping repair to avoid hanging"
        );
        // For read operations, we'll try to use it anyway rather than hang on repair
      }
    }
  }

  /**
   * Ensure workspace is up-to-date with upstream before write operations
   */
  async ensureUpToDate(): Promise<void> {
    await this.withLock("ensureUpToDate", async () => {
      await this.initialize();

      try {
        // Fetch latest changes (shallow)
        await gitFetchWithTimeout("origin", "main", {
          workdir: this!.workspacePath,
          timeout: 30000,
        });

        // Reset to latest upstream
        await execGitWithTimeout("reset to upstream", "reset --hard origin/main", {
          workdir: this!.workspacePath,
        });

        log.debug("Special workspace updated to latest upstream", {
          workspacePath: this!.workspacePath,
        });
      } catch (error) {
        log.error("Failed to update workspace, attempting repair", {
          workspacePath: this!.workspacePath,
          error: getErrorMessage(error),
        });
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
        await execGitWithTimeout("stage process changes", "add process/", {
          workdir: this!.workspacePath,
        });

        // Check if there are any changes to commit
        const { stdout: statusOutput } = await execGitWithTimeout(
          "check git status",
          "status --porcelain",
          { workdir: this!.workspacePath }
        );

        if (!statusOutput.trim()) {
          log.debug("No changes to commit in special workspace");
          return;
        }

        // Commit changes
        const escapedMessage = message.replace(/"/g, '\\"');
        await execGitWithTimeout("commit changes", `commit -m "${escapedMessage}"`, {
          workdir: this!.workspacePath,
        });

        // Push to upstream
        await gitPushWithTimeout(this!.workspacePath);

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
        await execGitWithTimeout("rollback last commit", "reset --hard HEAD~1", {
          workdir: this!.workspacePath,
        });

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
      await execGitWithTimeout("rev-parse", "rev-parse --git-dir", {
        workdir: this!.workspacePath,
      });

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
      await execGitWithTimeout("configure sparse checkout", "config core.sparseCheckout true", {
        workdir: this!.workspacePath,
      });
      await fs.writeFile(
        join(this!.workspacePath, ".git", "info", "sparse-checkout"),
        "process/\n",
        "utf8"
      );

      // Checkout with sparse checkout applied
      await execGitWithTimeout("checkout main branch", "checkout main", {
        workdir: this!.workspacePath,
      });

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
    const startTime = Date.now();

    while (Date.now() - startTime < this?.lockTimeoutMs) {
      try {
        // Check if lock file exists
        if (existsSync(this.lockPath)) {
          const lockContent = await fs.readFile(this.lockPath, "utf8");
          const lockInfo: LockInfo = JSON.parse(String(lockContent));

          // Check if lock is stale
          if (Date.now() - lockInfo?.timestamp > this?.lockTimeoutMs) {
            log.warn("Removing stale lock", {
              lockPath: this.lockPath,
              lockInfo,
            });
            await fs.unlink(this.lockPath);
          } else {
            // Lock is still valid, wait and retry
            await this.waitWithCleanup(100);
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
          await this.waitWithCleanup(100);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to acquire lock for operation "${operation}" within timeout`);
  }

  /**
   * Wait with proper timer cleanup tracking
   */
  private async waitWithCleanup(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Clear any existing timer
      if (this.currentLockTimer) {
        clearTimeout(this.currentLockTimer);
      }

      // Set new timer and track it
      this.currentLockTimer = setTimeout(() => {
        this.currentLockTimer = null;
        resolve();
      }, ms);
    });
  }

  /**
   * Release the file-based lock
   */
  private async releaseLock(): Promise<void> {
    try {
      // Clear any pending timers
      if (this.currentLockTimer) {
        clearTimeout(this.currentLockTimer);
        this.currentLockTimer = null;
      }

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
