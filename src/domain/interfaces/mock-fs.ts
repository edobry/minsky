import type { FsLike, FsStats } from "./fs-like";

/**
 * In-memory mock filesystem implementing FsLike.
 * Use in tests to avoid touching the real filesystem and to avoid
 * mock.module() fragility.
 */
export interface MockFs extends FsLike {
  /** Internal file contents storage — use for test assertions */
  files: Map<string, string>;
  /** Internal directory set — use for test assertions */
  directories: Set<string>;
}

/**
 * Creates an in-memory FsLike implementation suitable for unit tests.
 *
 * @param initialFiles   - Map of path → content to pre-populate
 * @param initialDirectories - Set of directory paths to pre-populate
 *
 * @example
 * const fs = createMockFs({
 *   "/workspace/tasks/tasks.json": "[]",
 * });
 * // Inject `fs` wherever FsLike is accepted
 */
export function createMockFs(
  initialFiles: Record<string, string> = {},
  initialDirectories: Set<string> = new Set()
): MockFs {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const directories = new Set<string>(initialDirectories);

  // Auto-populate parent directories for initial files
  for (const filePath of Object.keys(initialFiles)) {
    addParentDirectories(filePath, directories);
  }

  function addParentDirectories(filePath: string, dirs: Set<string>): void {
    const parts = filePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (dir) dirs.add(dir);
    }
  }

  function enoent(op: string, path: string): never {
    throw Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${path}'`), {
      code: "ENOENT",
    });
  }

  return {
    files,
    directories,

    async readFile(path: string, _encoding: BufferEncoding): Promise<string> {
      if (!files.has(path)) enoent("open", path);
      return files.get(path)!;
    },

    async writeFile(path: string, data: string | Buffer): Promise<void> {
      files.set(path, typeof data === "string" ? data : data.toString());
      addParentDirectories(path, directories);
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
      directories.add(path);
      if (options?.recursive) {
        const parts = path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
      return undefined;
    },

    async readdir(path: string): Promise<string[]> {
      if (!directories.has(path)) enoent("scandir", path);
      const entries = new Set<string>();
      for (const [filePath] of files) {
        if (filePath.startsWith(`${path}/`) && !filePath.slice(path.length + 1).includes("/")) {
          entries.add(filePath.slice(path.length + 1));
        }
      }
      for (const dirPath of directories) {
        if (dirPath.startsWith(`${path}/`) && !dirPath.slice(path.length + 1).includes("/")) {
          entries.add(dirPath.slice(path.length + 1));
        }
      }
      return Array.from(entries);
    },

    async stat(path: string): Promise<FsStats> {
      if (files.has(path)) {
        return { isFile: () => true, isDirectory: () => false };
      }
      if (directories.has(path)) {
        return { isFile: () => false, isDirectory: () => true };
      }
      enoent("stat", path);
    },

    async access(path: string): Promise<void> {
      if (!files.has(path) && !directories.has(path)) enoent("access", path);
    },

    async unlink(path: string): Promise<void> {
      if (!files.has(path)) enoent("unlink", path);
      files.delete(path);
    },

    async copyFile(src: string, dest: string): Promise<void> {
      if (!files.has(src)) enoent("copyFile", src);
      files.set(dest, files.get(src)!);
      addParentDirectories(dest, directories);
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path) || directories.has(path);
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const existed = files.has(path) || directories.has(path);
      if (!existed && !options?.force) enoent("rm", path);

      files.delete(path);
      directories.delete(path);

      if (options?.recursive) {
        for (const filePath of Array.from(files.keys())) {
          if (filePath.startsWith(`${path}/`)) files.delete(filePath);
        }
        for (const dirPath of Array.from(directories)) {
          if (dirPath.startsWith(`${path}/`)) directories.delete(dirPath);
        }
      }
    },
  };
}
