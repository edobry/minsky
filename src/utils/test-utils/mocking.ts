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
import { mock, afterEach } from "bun:test"; // Import mock from bun:test

type MockFnType = <T extends (...args: any[]) => any>(implementation?: T) => any;

// Define a MockFunction type to replace jest.Mock
export interface MockFunction<TReturn = any, TArgs extends any[] = any[]> {
  (...args: TArgs): TReturn;
  mock: {
    calls: TArgs[];
    results: Array<{
      type: "return" | "throw";
      value: TReturn | Error;
    }>;
  };
  mockImplementation: (fn: (...args: TArgs) => TReturn) => MockFunction<TReturn, TArgs>;
  mockReturnValue: (value: TReturn) => MockFunction<TReturn, TArgs>;
  mockResolvedValue: <U>(value: U) => MockFunction<Promise<U>, TArgs>;
  mockRejectedValue: (reason: Error) => MockFunction<Promise<never>, TArgs>;
}

/**
 * Creates a type-safe mock function with tracking capabilities.
 * This is a more strongly typed version of createMock.
 *
 * @template T - The function signature to mock
 * @param implementation - Optional initial implementation of the mock
 * @returns A mock function that tracks calls and can be configured with proper type inference
 *
 * @example
 * // Create a type-safe mock with implementation
 * type GreetFn = (name: string) => string;
 * const mockGreet = mockFunction<GreetFn>((name) => `Hello, ${name}!`);
 * const result = mockGreet("World"); // TypeScript knows this returns string
 */
export function mockFunction<T extends (...args: any[]) => any>(implementation?: T) {
  // Cast to unknown first to avoid TypeScript errors
  return createMock(implementation) as unknown as MockFunction<ReturnType<T>, Parameters<T>> & T;
}

/**
 * Creates a mock function with type safety and tracking capabilities.
 * This is a wrapper around Bun's mock function with improved TypeScript support.
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
  // Use Bun's mock directly instead of trying to access mock.fn
  return implementation ? mock(implementation) : mock(() => {});
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
 * Also cleans up shared state like command registries.
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
    
    // Clean up shared state that persists between tests
    resetSharedState();
  });
}

/**
 * Resets shared state that can leak between tests.
 * This includes singletons like command registries that accumulate state.
 */
function resetSharedState(): void {
  try {
    // Reset the shared command registry if it exists
    // Use dynamic import to avoid circular dependencies
    const registryModule = require("../../adapters/shared/command-registry");
    if (registryModule?.sharedCommandRegistry?.commands) {
      (registryModule.sharedCommandRegistry as any).commands = new Map();
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist or can't be loaded
    // This ensures tests can run even if the command registry isn't available
  }
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
    _files: files,
  };
}

/**
 * Creates a partial mock of an interface with custom implementations.
 * This is useful for creating test doubles that implement interfaces
 * without having to implement every method.
 *
 * @template T - The interface type to mock
 * @param implementations - Partial implementations of interface methods
 * @returns A mock object that implements the interface T
 *
 * @example
 * // Define an interface
 * interface UserService {
 *   getUser(id: string): Promise<User | null>;
 *   updateUser(id: string, data: any): Promise<boolean>;
 *   deleteUser(id: string): Promise<boolean>;
 * }
 *
 * // Create a partial mock with only some methods implemented
 * const mockUserService = createPartialMock<UserService>({
 *   getUser: async (id) => id === "123" ? { id, name: "Test User" } : null
 * });
 *
 * // Other methods are automatically mocked and can be used in tests
 * await mockUserService.updateUser("123", { name: "Updated" });
 * expect(mockUserService.updateUser).toHaveBeenCalledWith("123", { name: "Updated" });
 */
export function createPartialMock<T extends object>(implementations: Partial<T> = {}): T {
  // Create a base object with the provided implementations
  const base = { ...implementations } as any;

  // Create a proxy that will handle method calls
  return new Proxy(base, {
    get: (target, prop: string | symbol) => {
      // If the property exists on the target, return it
      if (prop in target) {
        return target[prop];
      }

      // For methods that don't exist, create a mock function
      if (typeof prop === "string") {
        const mockFn = createMock();
        target[prop] = mockFn;
        return mockFn;
      }

      return undefined;
    },
  }) as T;
}

/**
 * Mocks a readonly property on an object.
 * This is useful for testing code that uses getters or Object.defineProperty.
 *
 * @param obj - The object containing the property to mock
 * @param propName - The name of the property to mock
 * @param mockValue - The mock value to return when the property is accessed
 *
 * @example
 * // Mock a readonly property
 * const config = {
 *   get environment() { return "production"; }
 * };
 *
 * // Mock the property
 * mockReadonlyProperty(config, "environment", "test");
 *
 * // Now accessing the property returns the mock value
 * expect(config.environment).toBe("test");
 */
export function mockReadonlyProperty<T extends object, K extends keyof T>(
  obj: T,
  propName: K,
  mockValue: any
): void {
  // Use Object.defineProperty to override the property
  Object.defineProperty(obj, propName, {
    configurable: true,
    get: () => mockValue,
  });
}

/**
 * Creates a spy on an object method.
 * Similar to Jest's spyOn, but using Bun's mock functionality.
 *
 * @template T - The object type
 * @template M - The method key type
 * @param obj - The object containing the method to spy on
 * @param method - The method name to spy on
 * @returns A mock function that can track calls to the original method
 *
 * @example
 * // Spy on a method
 * const user = { getName: () => "John" };
 * const spy = createSpyOn(user, "getName");
 * user.getName(); // Original method is called
 * expect(spy).toHaveBeenCalled();
 */
export function createSpyOn<T extends object, M extends keyof T>(
  obj: T,
  method: M
): ReturnType<typeof mock> {
  const original = obj[method];
  
  if (typeof original !== "function") {
    throw new Error(`Cannot spy on ${String(method)} because it is not a function`);
  }

  // Create a mock function that calls the original
  const mockFn = mock((...args: any[]) => {
    return (original as Function).apply(obj, args);
  });

  // Replace the original method with our mock
  // @ts-ignore - We've already verified this is a function
  obj[method] = mockFn;

  // Return the mock function for assertions
  return mockFn;
}

/**
 * Represents a test context that manages resources and cleanup.
 */
export class TestContext {
  private cleanupFns: (() => void | Promise<void>)[] = [];

  /**
   * Registers a cleanup function to be run during teardown.
   * @param fn - The cleanup function to register
   */
  registerCleanup(fn: () => void | Promise<void>): void {
    this.cleanupFns.push(fn);
  }

  /**
   * Runs all registered cleanup functions.
   */
  async runCleanup(): Promise<void> {
    // Run cleanup functions in reverse order (LIFO)
    for (let i = this.cleanupFns.length - 1; i >= 0; i--) {
      const cleanupFn = this.cleanupFns[i];
      if (cleanupFn) {
        await cleanupFn();
      }
    }
    // Clear the cleanup functions
    this.cleanupFns = [];
  }
}

// Global test context instance
let currentTestContext: TestContext | null = null;

/**
 * Creates a test suite with managed setup and teardown.
 * This provides functions to use in beforeEach and afterEach hooks.
 *
 * @returns Object with beforeEach and afterEach functions
 *
 * @example
 * // In your test file
 * const { beforeEachTest, afterEachTest } = createTestSuite();
 *
 * describe("My Test Suite", () => {
 *   beforeEach(beforeEachTest);
 *   afterEach(afterEachTest);
 *
 *   test("my test", () => {
 *     const resource = acquireResource();
 *     withCleanup(() => releaseResource(resource));
 *
 *     // Test code...
 *   });
 * });
 */
export function createTestSuite() {
  return {
    /**
     * Sets up a fresh test context for each test.
     * Use this in beforeEach hooks.
     */
    beforeEachTest: () => {
      currentTestContext = new TestContext();
    },

    /**
     * Runs cleanup for the current test context.
     * Use this in afterEach hooks.
     */
    afterEachTest: async () => {
      if (currentTestContext) {
        await currentTestContext.runCleanup();
        currentTestContext = null;
      }
    },
  };
}

/**
 * Registers a cleanup function to run after the current test.
 * This ensures resources are properly released even if the test fails.
 *
 * @param cleanupFn - The function to run during test cleanup
 *
 * @example
 * test("resource management", () => {
 *   const resource = acquireResource();
 *
 *   // Register cleanup to happen automatically
 *   withCleanup(() => {
 *     releaseResource(resource);
 *   });
 *
 *   // Test code that might throw
 *   expect(resource.getData()).toBeDefined();
 * });
 * // Cleanup happens automatically after the test
 */
export function withCleanup(cleanupFn: () => void | Promise<void>): void {
  if (!currentTestContext) {
    throw new Error(
      "withCleanup called outside of a test context. Make sure to call beforeEachTest in a beforeEach hook."
    );
  }
  currentTestContext.registerCleanup(cleanupFn);
}

/**
 * Creates a spy on an object method.
 * This is a wrapper around createSpyOn for Jest-like compatibility.
 */
export const spyOn = createSpyOn;
