/**
 * Test Cleanup Patterns Utility
 *
 * Cleanup patterns for test isolation to eliminate global state
 * interference and ensure tests pass individually and in full suite.
 */

import { tmpdir } from "os";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { processChdir } from "../process";

/**
 * Working Directory Cleanup Pattern
 *
 * Manages process.cwd() isolation for tests that depend on or modify the current working directory.
 * Prevents working directory changes from affecting other tests.
 */
export class WorkingDirectoryCleanup {
  private originalCwd: string;
  private cwdMockRestore?: () => void;

  constructor() {
    this.originalCwd = process.cwd();
  }

  /**
   * Save the current working directory before test
   */
  saveWorkingDirectory(): void {
    this.originalCwd = process.cwd();
  }

  /**
   * Restore the original working directory after test
   */
  restoreWorkingDirectory(): void {
    try {
      processChdir(this.originalCwd);
    } catch (error) {
      // If the original directory no longer exists, fallback to a safe directory
      processChdir(tmpdir());
    }
  }

  /**
   * Mock process.cwd() to return a specific path (for testing)
   */
  mockWorkingDirectory(mockPath: string): void {
    const originalCwd = process.cwd;
    (process as Record<string, unknown>)["cwd"] = () => mockPath;
    this.cwdMockRestore = () => {
      (process as Record<string, unknown>)["cwd"] = originalCwd;
    };
  }

  /**
   * Safely change working directory for a test
   */
  changeWorkingDirectory(newPath: string): void {
    if (existsSync(newPath)) {
      processChdir(newPath);
    } else {
      throw new Error(`Cannot change to directory: ${newPath} (does not exist)`);
    }
  }

  /**
   * Create a temporary directory and change to it
   */
  createAndChangeToTempDir(prefix: string = "test-cwd"): string {
    const tempDir = join(tmpdir(), `${prefix}-${Date.now()}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    processChdir(tempDir);
    return tempDir;
  }

  /**
   * Clean up working directory state
   */
  cleanup(): void {
    if (this.cwdMockRestore) {
      this.cwdMockRestore();
      this.cwdMockRestore = undefined;
    }
    this.restoreWorkingDirectory();
  }
}

/**
 * Working directory isolation test pattern
 */
export function withDirectoryIsolation() {
  const cwdCleanup = new WorkingDirectoryCleanup();

  return {
    cwd: cwdCleanup,
    beforeEach: () => {
      cwdCleanup.saveWorkingDirectory();
    },
    afterEach: () => {
      cwdCleanup.cleanup();
    },
  };
}
