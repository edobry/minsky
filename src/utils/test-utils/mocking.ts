/**
 * Centralized test mocking utilities for consistent test patterns across the codebase.
 * These utilities encapsulate Bun's testing mocking patterns for easier and consistent mocking.
 * 
 * This module provides utilities to:
 * - Create mock functions with proper type safety
 * - Mock entire modules with custom implementations
 * - Set up automatic mock cleanup for tests
 * - Create mock objects with multiple mock methods
 * - Create specialized mocks for common Node.js modules
 * 
 * @module mocking
 */
import { jest, mock, afterEach } from "bun:test"; // Import both jest and mock

type MockFnType = <T extends (...args: any[]) => any>(implementation?: T) => any;
// type MockResultType = ReturnType<typeof jest.fn>; // Using jest.fn for createMock

/**
 * Creates a mock function with type safety and tracking capabilities.
 * This is a wrapper around Bun's `jest.fn()` with improved TypeScript support.
 *
 * @template T - The function signature to mock
 * @param implementation - Optional initial implementation of the mock
 * @returns A mock function that tracks calls and can be configured
 *
 * @example
 * // Create a basic mock
 * const mockFn = createMock();
 * mockFn("test");
 * expect(mockFn).toHaveBeenCalledWith("test");
 *
 * @example
 * // Create a mock with implementation
 * const mockGreet = createMock((name: string) => `Hello, ${name}!`);
 * expect(mockGreet("World")).toBe("Hello, World!");
 * expect(mockGreet.mock.calls.length).toBe(1);
 * 
 * @example
 * // Change implementation later
 * mockFn.mockImplementation(() => "new result");
 * expect(mockFn()).toBe("new result");
 */
export function createMock<T extends (...args: any[]) => any>(implementation?: T) {
  return jest.fn(implementation); // Use jest.fn for creating function mocks
}

/**
 * Mocks a module with a custom implementation.
 * This is a wrapper around Bun's `mock.module()` function with improved TypeScript support.
 *
 * Note: Module mocking effects persist across tests unless explicitly restored.
 * Use with `setupTestMocks()` to ensure automatic cleanup.
 *
 * @param modulePath - The import path of the module to mock
 * @param factory - Factory function that returns the mock implementation
 *
 * @example
 * // Mock a simple module
 * mockModule("path/to/module", () => ({
 *   someFunction: createMock(() => "mocked result"),
 *   someValue: "mocked value"
 * }));
 *
 * @example
 * // Mock fs module with specific behavior
 * mockModule("fs", () => ({
 *   readFileSync: createMock((path) => {
 *     if (path === "/test.txt") return "test content";
 *     throw new Error(`File not found: ${path}`);
 *   }),
 *   existsSync: createMock((path) => path === "/test.txt")
 * }));
 * 
 * @example
 * // Later imports will use the mock implementation
 * const { someFunction } = await import("path/to/module");
 * expect(someFunction()).toBe("mocked result");
 */
export function mockModule(modulePath: string, factory: () => any): void {
  mock.module(modulePath, factory); // Use mock.module for module mocking
}

/**
 * Sets up test mocks with automatic cleanup in afterEach hook.
 * Ensures mocks are properly restored after each test to prevent test pollution.
 * 
 * This function should be called at the top level of your test file,
 * outside of any describe/it blocks, to ensure proper cleanup.
 *
 * @example
 * // In your test file, add this at the top level
 * import { setupTestMocks, mockModule, createMock } from "../utils/test-utils";
 * 
 * // Set up automatic cleanup
 * setupTestMocks();
 * 
 * describe("My Test Suite", () => {
 *   it("should use mocks", async () => {
 *     mockModule("fs", () => ({ ... }));
 *     // Test that uses the mock
 *     // No need to manually restore mocks
 *   });
 * });
 */
export function setupTestMocks(): void {
  // Cleanup all mocks after each test
  afterEach(() => {
    mock.restore(); // Use mock.restore() as it's documented to handle mock.module
  });
}

/**
 * Creates a mock object with all specified methods mocked.
 * Each method will be a full mock function created with createMock().
 *
 * @template T - The string literal type of method names
 * @param methods - Array of method names to mock
 * @param implementations - Optional map of method implementations
 * @returns An object with all specified methods mocked
 *
 * @example
 * // Create a mock service with default mock methods
 * const userService = createMockObject([
 *   "getUser",
 *   "updateUser",
 *   "deleteUser"
 * ]);
 * 
 * // Configure specific behavior
 * userService.getUser.mockImplementation((id) => ({ id, name: "Test User" }));
 * 
 * // Use in tests
 * const user = userService.getUser("123");
 * expect(user).toEqual({ id: "123", name: "Test User" });
 * expect(userService.getUser).toHaveBeenCalledWith("123");
 *
 * @example
 * // Create with specific implementations
 * const userService = createMockObject(
 *   ["getUser", "updateUser", "deleteUser"],
 *   {
 *     getUser: (id) => ({ id, name: "Initial User" })
 *   }
 * );
 */
export function createMockObject<T extends string>(
  methods: T[],
  implementations: Partial<Record<T, (...args: any[]) => any>> = {}
): Record<T, ReturnType<typeof createMock>> {
  return methods.reduce(
    (obj, method) => {
      obj[method] = createMock(implementations[method]);
      return obj;
    },
    {} as Record<T, ReturnType<typeof createMock>>
  );
}

/**
 * Creates a mock implementation for child_process.execSync that responds based on command patterns.
 * This is especially useful for testing CLI commands that shell out to other processes.
 *
 * @param commandResponses - Map of command substrings to their mock responses
 * @returns A mock function for execSync that returns appropriate responses
 *
 * @example
 * // In your test setup
 * import { mockModule, createMockExecSync } from "../utils/test-utils";
 * 
 * mockModule("child_process", () => ({
 *   execSync: createMockExecSync({
 *     "ls": "file1.txt\nfile2.txt",
 *     "git status": "On branch main\nnothing to commit",
 *     "git log": "commit abc123\nAuthor: Test User"
 *   }),
 *   // other exports if needed...
 * }));
 * 
 * @example
 * // Now in your test, any child_process.execSync calls will return the matching response
 * const { execSync } = require("child_process");
 * expect(execSync("ls -la")).toBe("file1.txt\nfile2.txt"); // Matches on "ls" substring
 * expect(execSync("git status --short")).toBe("On branch main\nnothing to commit"); // Matches on "git status" substring
 */
export function createMockExecSync(
  commandResponses: Record<string, string>
): ReturnType<typeof createMock> {
  return createMock((command: string) => {
    // Find the first matching command pattern
    for (const [pattern, response] of Object.entries(commandResponses)) {
      if (command.includes(pattern)) {
        return response;
      }
    }
    // Default response if no pattern matches
    return "";
  });
}

/**
 * Creates a mock filesystem with basic operations (existsSync, readFileSync, writeFileSync).
 * This is useful for tests that need to interact with files without touching the real filesystem.
 *
 * @param initialFiles - Optional record of initial file paths and their contents
 * @returns An object with mock fs functions and access to the internal files map
 *
 * @example
 * // Create a mock filesystem with initial files
 * import { mockModule, createMockFileSystem } from "../utils/test-utils";
 * 
 * const mockFS = createMockFileSystem({
 *   "/path/to/file.txt": "Initial content",
 *   "/path/to/config.json": JSON.stringify({ setting: true })
 * });
 * 
 * mockModule("fs", () => ({
 *   existsSync: mockFS.existsSync,
 *   readFileSync: mockFS.readFileSync,
 *   writeFileSync: mockFS.writeFileSync,
 *   mkdirSync: mockFS.mkdirSync,
 *   unlink: mockFS.unlink
 *   // other fs functions as needed...
 * }));
 * 
 * @example
 * // Now in your tests
 * const fs = require("fs");
 * 
 * // Reading files
 * expect(fs.existsSync("/path/to/file.txt")).toBe(true);
 * expect(fs.readFileSync("/path/to/file.txt", "utf8")).toBe("Initial content");
 * 
 * // Writing files
 * fs.writeFileSync("/path/to/new-file.txt", "New content");
 * expect(fs.existsSync("/path/to/new-file.txt")).toBe(true);
 * expect(fs.readFileSync("/path/to/new-file.txt")).toBe("New content");
 * 
 * // Creating directories
 * fs.mkdirSync("/path/to/dir");
 * expect(fs.existsSync("/path/to/dir")).toBe(true);
 * 
 * // Deleting files
 * fs.unlink("/path/to/file.txt");
 * expect(fs.existsSync("/path/to/file.txt")).toBe(false);
 * 
 * // Access internal files map for verification
 * expect(mockFS._files.has("/path/to/new-file.txt")).toBe(true);
 */
export function createMockFileSystem(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>();

  // Initialize with provided files
  Object.entries(initialFiles).forEach(([path, content]) => {
    files.set(path, content);
  });

  return {
    existsSync: createMock((path: string) => files.has(path)),
    readFileSync: createMock((path: string, options?: any) => {
      if (!files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return files.get(path);
    }),
    writeFileSync: createMock((path: string, data: string) => {
      files.set(path, data);
    }),
    unlink: createMock((path: string) => {
      files.delete(path);
    }),
    mkdirSync: createMock((path: string) => {
      // Just record that the directory exists
      files.set(path, "");
    }),
    // Access the internal files map for validation in tests
    _files: files
  };
}
