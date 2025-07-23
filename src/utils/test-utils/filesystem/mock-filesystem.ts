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
        if (filepath.startsWith(`${dirPath}/`) && !filepath.slice(dirPath.length + 1).includes("/")) {
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
    readFile: createMock(async (path: unknown) => {
      if (!files.has(path as string)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return files.get(String(path));
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

    // Access the internal state for validation in tests
    files: files,
    directories: directories,
  };

  return mockFs;
}