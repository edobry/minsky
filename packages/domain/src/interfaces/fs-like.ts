/**
 * Async filesystem interface for dependency injection.
 * Replaces direct fs/fs-promises imports so tests can inject mocks
 * without mock.module() fragility.
 */

export interface FsStats {
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FsLike {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStats>;
  access(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * Synchronous filesystem interface for dependency injection.
 * Used by modules that need sync fs operations (storage, config, init).
 * Mirrors the subset of Node's `fs` module that production code actually uses.
 */
export interface SyncFsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  readFileSync(path: string, options: { encoding: null }): Buffer;
  readFileSync(
    path: string,
    encodingOrOptions?: BufferEncoding | { encoding: null }
  ): string | Buffer;
  writeFileSync(path: string, data: string, encoding?: BufferEncoding): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  statSync(path: string): FsStats & { size: number; mtime: Date };
  readdirSync(path: string): string[];
  copyFileSync?(src: string, dest: string): void;
}

/**
 * Creates a SyncFsLike backed by the real `fs` module.
 */
export function createRealSyncFs(): SyncFsLike {
  // Use require to avoid top-level await and keep this synchronous

  const fs = require("fs");
  return {
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    copyFileSync: fs.copyFileSync,
  };
}
