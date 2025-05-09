/**
 * Test utilities for ensuring consistent test environment setup and cleanup.
 */
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { SpawnSyncOptions, SpawnSyncReturns } from "child_process";

/**
 * Type definition for the directory structure returned by setupMinskyTestEnv
 */
export interface MinskyTestEnv {
  minskyDir: string;
  gitDir: string;
  sessionDbPath: string;
  processDir: string;
  tasksDir: string;
}

/**
 * Creates a unique test directory path to avoid conflicts with other tests.
 * @param prefix Descriptive prefix for the test directory
 * @returns Path to the unique test directory
 */
export function createUniqueTestDir(prefix = "minsky-test"): string {
  const testId = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  return `/tmp/${prefix}-${testId}`;
}

/**
 * Safely cleans up a test directory if it exists.
 * @param dirPath Path to the test directory to clean up
 */
export function cleanupTestDir(dirPath: string): void {
  if (existsSync(dirPath)) {
    rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Creates a standard minsky test environment with proper directory structure.
 * @param baseDir The base test directory
 * @returns Object containing paths to the various test directories
 */
export function setupMinskyTestEnv(baseDir: string): MinskyTestEnv {
  // Ensure the base directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  // Create minsky state directory structure
  const minskyDir = join(baseDir, "minsky");
  const gitDir = join(minskyDir, "git");
  const sessionDbPath = join(minskyDir, "session-db.json");
  
  // Create process directory structure for tasks
  const processDir = join(baseDir, "process");
  const tasksDir = join(processDir, "tasks");
  
  // Ensure all directories exist
  mkdirSync(minskyDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(processDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  
  return {
    minskyDir,
    gitDir,
    sessionDbPath,
    processDir,
    tasksDir
  };
}

/**
 * Creates an enhanced child process environment with test-specific settings.
 * @param testDir Base directory for the test
 * @param additionalEnv Additional environment variables to set
 * @returns Environment object to use with spawnSync
 */
export function createTestEnv(testDir: string, additionalEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_STATE_HOME: testDir,
    ...additionalEnv
  };
}

/**
 * Standard options to use with spawnSync to ensure consistent behavior.
 * @returns Options object to use with spawnSync
 */
export function standardSpawnOptions(): Partial<SpawnSyncOptions> {
  return {
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"]
  };
}

/**
 * Ensures the command result is valid and was executed successfully.
 * @param result Result from spawnSync
 * @throws Error If command execution failed
 */
export function ensureValidCommandResult(result: SpawnSyncReturns<string>): void {
  if (!result || result.status === null) {
    console.error("Command execution failed or was killed");
    throw new Error("Command execution failed");
  }
  
  if (result.status !== 0) {
    console.error(`Command failed with status ${result.status}`);
    console.error(`Stderr: ${result.stderr}`);
  }
} 
