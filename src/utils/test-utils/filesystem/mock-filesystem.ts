/**
 * Mock Filesystem Utilities
 *
 * Provides utilities for creating mock filesystems for testing without touching the real filesystem.
 * This module includes in-memory filesystem implementations and filesystem operation mocks.
 *
 * @module filesystem/mock-filesystem
 */
import { createMock } from "../core/mock-functions";

/**
 * Creates a mock filesystem with basic operations (existsSync, readFileSync, writeFileSync).
 * This is useful for tests that need to interact with files without touching the real filesystem.
 *
 * @param initialFiles - Optional map of initial files to include in the mock filesystem
 * @param initialDirectories - Optional set of initial directories to include
 * @returns A mock filesystem object with common fs operations
 *
 * @example
 * // Create a mock filesystem with some initial files
 * const mockFs = createMockFilesystem({
 *   "/path/to/config.json": '{"key": "value"}',
 *   "/path/to/data.txt": "some data"
 * });
 *
 * // Use in tests
 * expect(mockFs.existsSync("/path/to/config.json")).toBe(true);
 * expect(mockFs.readFileSync("/path/to/config.json", "utf8")).toBe('{"key": "value"}');
 *
 * // Write new files
 * mockFs.writeFileSync("/new/file.txt", "new content");
 * expect(mockFs.existsSync("/new/file.txt")).toBe(true);
 *
 * @example
 * // Use with mockModule for complete fs mocking
 * import { mockModule, createMockFilesystem } from "../utils/test-utils";
 *
 * const mockFs = createMockFilesystem({
 *   "/package.json": '{"name": "test-package"}'
 * });
 *
 * mockModule("fs", () => mockFs);
 * mockModule("fs/promises", () => mockFs);
 */
export function createMockFilesystem(
  initialFiles: Record<string, string> = {},
  initialDirectories: Set<string> = new Set()
): any {
  // Internal storage for files and directories
  const files = new Map<string, string>(Object.entries(initialFiles));
  const directories = new Set<string>(initialDirectories);

  // Add parent directories for initial files
  for (const filepath of Object.keys(initialFiles)) {
    const parts = filepath.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
    }
  }

  const mockFs = {
    // Sync methods (fs)
    existsSync: createMock((path: unknown) => {
      return files.has(path as string) || directories.has(path as string);
    }),
    readFileSync: createMock((path: unknown, encoding?: unknown) => {
      if (!files.has(path as string)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      const content = files.get(String(path));
      return encoding === "utf8" || encoding === "utf-8" ? content : Buffer.from(content || "");
    }),
    writeFileSync: createMock((path: unknown, data: unknown) => {
      files.set(path as string, data as string);
      // Add parent directories
      const parts = (path as string).split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    }),
    mkdirSync: createMock((path: unknown, options?: unknown) => {
      directories.add(path as string);
      // If recursive option, add all parent directories
      if ((options as { recursive?: boolean })?.recursive) {
        const parts = (path as string).split("/");
        for (let i = 1; i <= parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
    }),
    ensureDirectorySync: createMock((path: unknown) => {
      directories.add(path as string);
      // Always add all parent directories (like mkdirp)
      const parts = (path as string).split("/");
      for (let i = 1; i <= parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    }),
    statSync: createMock((path: unknown) => {
      if (files.has(path as string)) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: files.get(String(path))?.length || 0,
        };
      }
      if (directories.has(path as string)) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
        };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }),
    readdirSync: createMock((path: unknown) => {
      const dirPath = path as string;
      const contents: string[] = [];

      // Find files in this directory
      for (const [filepath] of files) {
        if (
          filepath.startsWith(`${dirPath}/`) &&
          !filepath.slice(dirPath.length + 1).includes("/")
        ) {
          contents.push(filepath.slice(dirPath.length + 1));
        }
      }

      // Find subdirectories
      for (const dirName of directories) {
        if (dirName.startsWith(`${dirPath}/`) && !dirName.slice(dirPath.length + 1).includes("/")) {
          contents.push(dirName.slice(dirPath.length + 1));
        }
      }

      return contents;
    }),

    // Async methods (fs/promises)
    readFile: createMock(async (path: unknown, encoding?: unknown) => {
      if (!files.has(path as string)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      const content = files.get(String(path));
      // If encoding is specified, return string; otherwise return Buffer
      if (encoding) {
        return content; // Already stored as string
      } else {
        return Buffer.from(content || "", 'utf-8'); // Return as Buffer
      }
    }),
    writeFile: createMock(async (path: unknown, data: unknown) => {
      files.set(path as string, data as string);
      // Add parent directories
      const parts = (path as string).split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    }),
    mkdir: createMock(async (path: unknown, ...args: unknown[]) => {
      directories.add(path as string);
      const options = args[0] as { recursive?: boolean } | undefined;
      // If recursive option, add all parent directories
      if (options?.recursive) {
        const parts = (path as string).split("/");
        for (let i = 1; i <= parts.length; i++) {
          directories.add(parts.slice(0, i).join("/"));
        }
      }
    }),
    readdir: createMock(async (path: unknown) => {
      const dirPath = path as string;
      const contents: string[] = [];

      // Find files in this directory
      for (const [filepath] of files) {
        if (
          filepath.startsWith(`${dirPath}/`) &&
          !filepath.slice(dirPath.length + 1).includes("/")
        ) {
          contents.push(filepath.slice(dirPath.length + 1));
        }
      }

      // Find subdirectories
      for (const dirName of directories) {
        if (dirName.startsWith(`${dirPath}/`) && !dirName.slice(dirPath.length + 1).includes("/")) {
          contents.push(dirName.slice(dirPath.length + 1));
        }
      }

      return contents;
    }),
    mkdtemp: createMock(async (prefix: unknown) => {
      // Generate a unique temporary directory name
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      const tempDir = `${prefix}${timestamp}-${random}`;
      directories.add(tempDir);
      return tempDir;
    }),
    access: createMock(async (path: unknown) => {
      if (!files.has(path as string) && !directories.has(path as string)) {
        throw new Error(`ENOENT: no such file or directory, access '${path}'`);
      }
      // If file/directory exists, access succeeds (returns void)
    }),
    rm: createMock(async (path: unknown, options?: unknown) => {
      const pathStr = path as string;
      const opts = options as { recursive?: boolean; force?: boolean } | undefined;

      // Remove the path itself
      files.delete(pathStr);
      directories.delete(pathStr);

      // If recursive, remove all child paths
      if (opts?.recursive) {
        // Remove files
        for (const filePath of Array.from(files.keys())) {
          if (filePath.startsWith(`${pathStr}/`)) {
            files.delete(filePath);
          }
        }
        // Remove directories
        for (const dirPath of Array.from(directories)) {
          if (dirPath.startsWith(`${pathStr}/`)) {
            directories.delete(dirPath);
          }
        }
      }
    }),

    // Access the internal state for validation in tests
    files: files,
    directories: directories,

    // Convenience methods for test setup
    ensureDirectoryExists: (path: string) => {
      directories.add(path);
      // Also ensure all parent directories exist
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    },

    cleanup: () => {
      files.clear();
      directories.clear();
    },

    // Alias for cleanup to match existing test patterns
    reset: () => {
      files.clear();
      directories.clear();
    },
  };

  return mockFs;
}

/**
 * Helper function to create common filesystem operation mocks
 * @deprecated Use createMockFilesystem instead
 */
export const mockFsOperations = createMockFilesystem;
