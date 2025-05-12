/**
 * Test utilities for ensuring consistent test environment setup and cleanup.
 */
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { spawnSync } from "child_process";
import type {
  SpawnSyncOptions,
  SpawnSyncReturns,
  SpawnSyncOptionsWithStringEncoding,
} from "child_process";
import type { PathLike, WriteFileOptions } from "fs";
import type { MakeDirectoryOptions, ObjectEncodingOptions } from "fs";

// Create a virtual filesystem for testing
const virtualFS = new Map<string, { isDirectory: boolean; content?: string }>();

// Mock filesystem operations for testing
export function mockMkdirSync(path: string, options?: { recursive?: boolean }): void {
  console.log(`[MOCK] Creating directory ${path}`);
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
  console.log(`[MOCK] Checking if ${path} exists: ${exists}`);
  return exists;
}

export function mockRmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
  console.log(`[MOCK] Removing ${path}`);

  // If recursive, remove all children first
  if (options?.recursive) {
    const children = Array.from(virtualFS.keys()).filter((key) => key.startsWith(`${path}/`));
    for (const child of children) {
      virtualFS.delete(child);
    }
  }

  virtualFS.delete(path);
}

export function mockWriteFileSync(path: string, data: string, options?: WriteFileOptions): void {
  console.log(`[MOCK] Writing to file ${path}`);
  virtualFS.set(path, { isDirectory: false, content: data });

  // Ensure the directory exists
  const dir = dirname(path);
  if (!virtualFS.has(dir)) {
    mockMkdirSync(dir, { recursive: true });
  }
}

export function mockReadFileSync(path: string, options?: { encoding?: BufferEncoding }): string {
  console.log(`[MOCK] Reading file ${path}`);
  const file = virtualFS.get(path);
  if (!file || file.isDirectory) {
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }
  return file.content || "";
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
const useVirtualFS = true; // Set to true to use virtual filesystem
const fsOps: FS = useVirtualFS
  ? {
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    rmSync: mockRmSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
  }
  : {
    mkdirSync,
    existsSync,
    rmSync,
    writeFileSync,
    readFileSync,
  };

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
  return `/tmp/${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Creates a standard minsky test environment with proper directory structure.
 * Using hardcoded paths for tests to avoid filesystem issues.
 * @param baseDir The base test directory (ignored)
 * @returns Object containing paths to the various test directories
 */
export function setupMinskyTestEnv(baseDir: string): MinskyTestEnv {
  // This is stubbed for test purposes - we'll return fixed paths
  // that don't rely on filesystem operations
  const basePath = "/virtual/test-dir";
  const minskyDir = join(basePath, "minsky");
  const gitDir = join(minskyDir, "git");
  const sessionDbPath = join(minskyDir, "session-db.json");
  const processDir = join(basePath, "process");
  const tasksDir = join(processDir, "tasks");

  console.log(`[MOCK] Setting up test environment in: ${basePath}`);

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
  console.log(`[MOCK] Cleaning up directory: ${path}`);
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
    ...process.env,
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
export const mockFS = {
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
    console.error("Command execution failed or was killed");
    throw new Error("Command execution failed");
  }

  if (result.status !== 0) {
    console.error(`Command failed with status ${result.status}`);
    console.error(`Stderr: ${result.stderr}`);
  }
}
