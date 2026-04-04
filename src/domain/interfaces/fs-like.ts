/**
 * Async filesystem interface for dependency injection.
 * Replaces direct fs/fs-promises imports so tests can inject mocks
 * without mock.module() fragility.
 *
 * Only covers async methods — sync interfaces (SyncFs, FileSystem) are
 * handled separately in config-writer.ts and init/file-system.ts.
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
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
