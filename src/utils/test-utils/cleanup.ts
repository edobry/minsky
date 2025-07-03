/**
 * Enhanced test cleanup utilities for improved test isolation and reliability.
 * 
 * This module provides comprehensive cleanup capabilities including:
 * - Robust temporary file and directory cleanup
 * - Timeout-based cleanup for hanging operations
 * - Cleanup verification and validation
 * - Centralized cleanup management across test suites
 * 
 * @module cleanup
 */

import * as fs from "fs";
import * as path from "path";
import { log } from "../logger";
import { afterEach } from "bun:test";

interface CleanupOptions {
  /** Timeout for cleanup operations in milliseconds */
  timeout?: number;
  /** Whether to verify cleanup completed successfully */
  verify?: boolean;
  /** Whether to continue on cleanup errors */
  continueOnError?: boolean;
  /** Maximum number of retry attempts for cleanup */
  maxRetries?: number;
}

interface CleanupItem {
  path: string;
  type: "file" | "directory";
  created: number; // timestamp
  description?: string;
}

/**
 * Central cleanup manager for test resources
 */
export class TestCleanupManager {
  private static instance: TestCleanupManager | null = null;
  private cleanupItems: CleanupItem[] = [];
  private cleanupFunctions: Array<() => Promise<void> | void> = [];
  private isSetup = false;

  private constructor() {}

  static getInstance(): TestCleanupManager {
    if (!TestCleanupManager.instance) {
      TestCleanupManager.instance = new TestCleanupManager();
    }
    return TestCleanupManager.instance;
  }

  /**
   * Setup automatic cleanup after each test
   */
  setupAutoCleanup(): void {
    if (this.isSetup) return;
    
    afterEach(async () => {
      await this.performCleanup();
    });
    
    this.isSetup = true;
  }

  /**
   * Register a temporary file or directory for cleanup
   */
  registerForCleanup(itemPath: string, type: "file" | "directory", description?: string): void {
    this.cleanupItems.push({
      path: itemPath,
      type,
      created: Date.now(),
      description
    });
  }

  /**
   * Register a custom cleanup function
   */
  registerCleanupFunction(cleanupFn: () => Promise<void> | void): void {
    this.cleanupFunctions.push(cleanupFn);
  }

  /**
   * Perform comprehensive cleanup with timeout and verification
   */
  async performCleanup(options: CleanupOptions = {}): Promise<void> {
    const {
      timeout = 5000,
      verify = true,
      continueOnError = true,
      maxRetries = 3
    } = options;

    const startTime = Date.now();
    const errors: string[] = [];

    // Run custom cleanup functions first
    for (const cleanupFn of this.cleanupFunctions) {
      try {
        await Promise.race([
          Promise.resolve(cleanupFn()),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Cleanup function timeout")), timeout)
          )
        ]);
      } catch (error) {
        const errorMsg = `Custom cleanup function failed: ${error instanceof Error ? error.message : String(error)}`;
        log.warn(errorMsg);
        errors.push(errorMsg);
        if (!continueOnError) break;
      }
    }

    // Clean up registered items
    for (const item of this.cleanupItems) {
      let retries = 0;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          await this.cleanupItem(item, { timeout });
          success = true;
        } catch (error) {
          retries++;
          const errorMsg = `Failed to cleanup ${item.path} (attempt ${retries}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`;
          log.warn(errorMsg);
          
          if (retries >= maxRetries) {
            errors.push(errorMsg);
            if (!continueOnError) break;
          } else {
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 100 * retries));
          }
        }
      }
    }

    // Verify cleanup if requested
    if (verify) {
      const verificationErrors = await this.verifyCleanup();
      errors.push(...verificationErrors);
    }

    // Clear the registrations
    this.cleanupItems = [];
    this.cleanupFunctions = [];

    const cleanupTime = Date.now() - startTime;
    if (process.env.DEBUG_TEST_UTILS) {
      log.debug(`Test cleanup completed in ${cleanupTime}ms with ${errors.length} errors`);
    }

    if (errors.length > 0 && !continueOnError) {
      throw new Error(`Cleanup failed with errors: ${errors.join("; ")}`);
    }
  }

  /**
   * Clean up a specific item with timeout protection
   */
  private async cleanupItem(item: CleanupItem, options: { timeout: number }): Promise<void> {
    return Promise.race([
      this.performItemCleanup(item),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Cleanup timeout for ${item.path}`)), options.timeout)
      )
    ]);
  }

  /**
   * Perform the actual cleanup of an item
   */
  private async performItemCleanup(item: CleanupItem): Promise<void> {
    if (!fs.existsSync(item.path)) {
      return; // Already cleaned up
    }

    try {
      if (item.type === "directory") {
        // Use recursive removal with force option
        fs.rmSync(item.path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(item.path);
      }
    } catch (error) {
      // Some systems may need additional time for file handles to close
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Retry once more
      try {
        if (item.type === "directory") {
          fs.rmSync(item.path, { recursive: true, force: true });
        } else {
          fs.unlinkSync(item.path);
        }
      } catch (retryError) {
        throw new Error(`Failed to cleanup ${item.path}: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }
  }

  /**
   * Verify that all cleanup operations succeeded
   */
  private async verifyCleanup(): Promise<string[]> {
    const errors: string[] = [];
    
    for (const item of this.cleanupItems) {
      if (fs.existsSync(item.path)) {
        errors.push(`Cleanup verification failed: ${item.path} still exists`);
      }
    }

    return errors;
  }

  /**
   * Get statistics about current cleanup items
   */
  getCleanupStats(): { itemCount: number, functionCount: number, oldestItem?: number } {
    const now = Date.now();
    const oldestItem = this.cleanupItems.length > 0 
      ? Math.min(...this.cleanupItems.map(item => item.created))
      : undefined;

    return {
      itemCount: this.cleanupItems.length,
      functionCount: this.cleanupFunctions.length,
      oldestItem: oldestItem ? now - oldestItem : undefined
    };
  }

  /**
   * Force cleanup of all registered items (for emergency situations)
   */
  async forceCleanup(): Promise<void> {
    await this.performCleanup({
      timeout: 1000,
      verify: false,
      continueOnError: true,
      maxRetries: 1
    });
  }
}

/**
 * Enhanced temporary directory creation with automatic cleanup registration
 */
export function createCleanTempDir(prefix = "test-", description?: string): string {
  const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), prefix));
  
  // Register for automatic cleanup
  const manager = TestCleanupManager.getInstance();
  manager.registerForCleanup(tempDir, "directory", description);
  
  return tempDir;
}

/**
 * Enhanced temporary file creation with automatic cleanup registration
 */
export function createCleanTempFile(prefix = "test-", suffix = ".tmp", content = "", description?: string): string {
  const tempDir = require("os").tmpdir();
  const tempFile = path.join(tempDir, prefix + Date.now() + Math.random().toString(36).substring(7) + suffix);
  
  fs.writeFileSync(tempFile, content);
  
  // Register for automatic cleanup
  const manager = TestCleanupManager.getInstance();
  manager.registerForCleanup(tempFile, "file", description);
  
  return tempFile;
}

/**
 * Setup comprehensive test cleanup for a test suite
 */
export function setupTestCleanup(): TestCleanupManager {
  const manager = TestCleanupManager.getInstance();
  manager.setupAutoCleanup();
  return manager;
}

/**
 * Utility function to clean up leftover test files from previous runs
 */
export async function cleanupLeftoverTestFiles(basePaths: string[] = []): Promise<void> {
  const defaultPaths = [
    path.join(process.cwd(), "test-tmp"),
    "/tmp",
    require("os").tmpdir()
  ];
  
  const pathsToClean = [...defaultPaths, ...basePaths];
  
  for (const basePath of pathsToClean) {
    if (!fs.existsSync(basePath)) continue;
    
    try {
      const items = fs.readdirSync(basePath);
      for (const item of items) {
        if (item.includes("test-") || item.includes("minsky-test-")) {
          const fullPath = path.join(basePath, item);
          const stats = fs.statSync(fullPath);
          
          // Clean up items older than 1 hour
          if (Date.now() - stats.mtime.getTime() > 60 * 60 * 1000) {
            try {
              if (stats.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(fullPath);
              }
              if (process.env.DEBUG_TEST_UTILS) {
                log.debug(`Cleaned up leftover test item: ${fullPath}`);
              }
            } catch (error) {
              log.warn(`Failed to cleanup leftover test item ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    } catch (error) {
      log.warn(`Failed to scan directory ${basePath} for leftover test files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Global instance for easy access
export const cleanupManager = TestCleanupManager.getInstance(); 
