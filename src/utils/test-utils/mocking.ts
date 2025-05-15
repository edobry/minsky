/**
 * Centralized test mocking utilities for consistent test patterns across the codebase.
 * These utilities encapsulate Bun\'s testing mocking patterns for easier and consistent mocking.
 */
import { jest, mock, afterEach } from "bun:test"; // Import both jest and mock

type MockFnType = <T extends (...args: any[]) => any>(implementation?: T) => any;
// type MockResultType = ReturnType<typeof jest.fn>; // Using jest.fn for createMock

/**
 * Creates a mock function with type safety
 *
 * @param implementation Optional initial implementation
 * @returns A mock function with mock functionality
 *
 * @example
 * // Create a basic mock
 * const mockFn = createMock();
 *
 * // Create a mock with implementation
 * const mockGreet = createMock((name: string) => `Hello, ${name}!`);
 *
 * // Use in a test
 * expect(mockGreet("World")).toBe("Hello, World!");
 * expect(mockGreet.mock.calls.length).toBe(1);
 */
export function createMock<T extends (...args: any[]) => any>(implementation?: T) {
  return jest.fn(implementation); // Use jest.fn for creating function mocks
}

/**
 * Mocks a module with a custom implementation
 *
 * @param modulePath The path to the module to mock
 * @param factory Factory function that returns the mock implementation
 *
 * @example
 * // Mock a simple module
 * mockModule("path/to/module", () => ({
 *   someFunction: createMock(() => "mocked result"),
 *   someValue: "mocked value"
 * }));
 *
 * // Later import will use the mock
 * import { someFunction } from "path/to/module";
 */
export function mockModule(modulePath: string, factory: () => any): void {
  mock.module(modulePath, factory); // Use mock.module for module mocking
}

/**
 * Sets up test mocks with automatic cleanup in afterEach
 * Ensures mocks are properly restored after each test
 *
 * @example
 * // In your test file
 * setupTestMocks();
 *
 * // Use mocks without worrying about cleanup
 * mockModule("fs", () => ({ ... }));
 */
export function setupTestMocks(): void {
  // Cleanup all mocks after each test
  afterEach(() => {
    mock.restore(); // Use mock.restore() as it's documented to handle mock.module
  });
}

/**
 * Creates a basic mock object with all methods mocked
 *
 * @param methods Methods to mock on the object
 * @returns An object with all specified methods mocked
 *
 * @example
 * // Create a mock service
 * const mockService = createMockObject([
 *   "getUser",
 *   "updateUser",
 *   "deleteUser"
 * ]);
 *
 * // Configure specific behavior
 * mockService.getUser.mockImplementation((id) => ({ id, name: "Test User" }));
 */
export function createMockObject<T extends string>(methods: T[]): Record<T, any> {
  return methods.reduce(
    (obj, method) => {
      obj[method] = createMock();
      return obj;
    },
    {} as Record<T, any>
  );
}

/**
 * Creates a mock implementation for child_process.execSync
 *
 * @param commandResponses Map of command substrings to mock responses
 * @returns A mock function for execSync
 *
 * @example
 * mock.module("child_process", () => ({
 *   execSync: createMockExecSync({
 *     "ls": "file1.txt\nfile2.txt",
 *     "git status": "On branch main\nnothing to commit",
 *   }),
 *   // other exports...
 * }));
 */
export function createMockExecSync(
  commandResponses: Record<string, string>
): any {
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
 * Creates a mock filesystem with basic operations
 *
 * @returns An object with mock fs functions
 *
 * @example
 * const { existsSync, readFileSync, writeFileSync } = createMockFileSystem({
 *   "/path/to/file.txt": "file contents"
 * });
 *
 * mock.module("fs", () => ({
 *   existsSync,
 *   readFileSync,
 *   writeFileSync,
 *   // other fs functions...
 * }));
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
