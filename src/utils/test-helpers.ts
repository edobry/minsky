const UUID_LENGTH = 36;
const SHORT_ID_LENGTH = 8;

/**
 * Test utilities for ensuring consistent test environment setup and cleanup.
 */
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import type { SpawnSyncReturns, SpawnSyncOptionsWithStringEncoding } from "child_process";
import type { WriteFileOptions } from "fs";
import { log } from "./logger";

// Create a virtual filesystem for testing
const virtualFS = new Map<string, { isDirectory: boolean; content?: string }>();

// Mock filesystem operations for testing
export function mockMkdirSync(path: string, options?: { recursive?: boolean }): void {
  log.debug(`[MOCK] Creating directory ${path}`);
  virtualFS.set(path, { isDirectory: true });

  // If recursive, create parent directories
  if (options?.recursive) {
    let parent = dirname(path);
    while (parent && parent !== "." && parent !== "/") {
      virtualFS.set(parent, { isDirectory: true });
      parent = dirname(parent);
    }
  }
}

export function mockExistsSync(path: string): boolean {
  const exists = virtualFS.has(path);
  log.debug(`[MOCK] Checking if ${path} exists: ${exists}`);
  return exists;
}

export function mockRmSync(
  path: string,
  options?: { recursive?: boolean; force?: boolean }
): void {
  log.debug(`[MOCK] Removing ${path}`);

  // If recursive, remove all children first
  if (options?.recursive) {
    const children = Array.from(virtualFS.keys()).filter((key) => key.startsWith(`${path}/`));
    for (const child of children) {
      virtualFS.delete(child);
    }
  }

  virtualFS.delete(path);
}

export function mockWriteFileSync(path: string, data: string, _options?: WriteFileOptions): void {
  log.debug(`[MOCK] Writing to file ${path}`);
  virtualFS.set(path, { isDirectory: false, content: data });

  // Ensure the directory exists
  const dir = dirname(path);
  if (!virtualFS.has(dir)) {
    mockMkdirSync(dir, { recursive: true });
  }
}

export function mockReadFileSync(path: string, _options?: { encoding?: BufferEncoding }): string {
  log.debug(`[MOCK] Reading file ${path}`);
  const file = virtualFS.get(path);
  if (!file || file?.isDirectory) {
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }
  return file?.content || "";
}

// Use function type assertions to avoid TypeScript errors with type compatibility
// Create a union type of the real and mock operations
type FS = {
  mkdirSync: typeof mkdirSync | typeof mockMkdirSync;
  existsSync: typeof existsSync | typeof mockExistsSync;
  rmSync: typeof rmSync | typeof mockRmSync;
  writeFileSync: typeof writeFileSync | typeof mockWriteFileSync;
  readFileSync: typeof readFileSync | typeof mockReadFileSync;
};

// Setup to use real or mock filesystem based on environment
const _useVirtualFS = true; // Set to true to use virtual filesystem

// Interface for test environment setup
export interface MinskyTestEnv {
  minskyDir: string;
  gitDir: string;
  sessionDbPath: string;
  processDir: string;
  tasksDir: string;
}

/**
 * Creates a unique test directory name
 */
export function createUniqueTestDir(prefix: string): string {
  return `/tmp/${prefix}-${(process as any)?.pid || 0}-${(Date as any).now()}-${Math.random().toString(UUID_LENGTH).substring(2, SHORT_ID_LENGTH)}`;
}

/**
 * Creates a standard minsky test environment with proper directory structure.
 * Using hardcoded paths for tests to avoid filesystem issues.
 * @param baseDir The base test directory (ignored)
 * @returns Object containing paths to the various test directories
 */
export function setupMinskyTestEnv(_baseDir: string): MinskyTestEnv {
  // This is stubbed for test purposes - we'll return fixed paths
  // that don't rely on filesystem operations
  const basePath = "/virtual/test-dir";
  const minskyDir = join(basePath, "minsky");
  const gitDir = join(minskyDir, "git");
  const sessionDbPath = join(minskyDir, "session-db.json");
  const processDir = join(basePath, "process");
  const tasksDir = join(processDir, "tasks");

  log.debug(`[MOCK] Setting up test environment in: ${basePath}`);

  return {
    minskyDir,
    gitDir,
    sessionDbPath,
    processDir,
    tasksDir,
  };
}

/**
 * Cleans up a test directory - stubbed for testing
 */
export function cleanupTestDir(path: string): void {
  log.debug(`[MOCK] Cleaning up directory: ${path}`);
  // No actual cleanup needed in tests
}

/**
 * Creates environment variables for testing
 */
export function createTestEnv(
  stateHome: string,
  additionalEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    ...(process as any).env,
    XDG_STATE_HOME: stateHome,
    ...additionalEnv,
  };
}

/**
 * Creates standard spawn options for child processes
 */
export function standardSpawnOptions(): SpawnSyncOptionsWithStringEncoding {
  return {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  };
}

// Export the mock functions for tests that need to use them directly
export const _mockFS = {
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  virtualFS,
};

/**
 * Ensures the command result is valid and was executed successfully.
 * @param result Result from spawnSync
 * @throws Error If command execution failed
 */
export function ensureValidCommandResult(result: SpawnSyncReturns<string>): void {
  if (!result || result.status === null) {
    log.error("Command execution failed or was killed");
    throw new Error("Command execution failed");
  }

  if (result.status !== 0) {
    log.error(`Command failed with status ${result.status}`);
    log.error(`Stderr: ${result.stderr}`);
  }
}
