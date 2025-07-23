/**
 * Mock Objects and Specialized Utilities
 *
 * Provides utilities for creating mock objects and specialized mocks for common scenarios.
 * This module includes mock object factories, exec sync mocks, and partial mock implementations.
 *
 * @module objects/mock-objects
 */
import { createMock } from "../core/mock-functions";

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
 * const user = userService.getUser("TEST_VALUE");
 * expect(user).toEqual({ _id: "TEST_VALUE", name: "Test User" });
 * expect(userService.getUser).toHaveBeenCalledWith("TEST_VALUE");
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
  implementations: Partial<Record<T, (...args: unknown[]) => any>> = {}
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
 *     "ls": "file1.txt\\nfile2.txt",
 *     "git status": "On _branch main\\nnothing to commit",
 *     "git log": "commit abc123\\nAuthor: Test User"
 *   }),
 *   // other exports if needed...
 * }));
 *
 * @example
 * // Now in your test, any child_process.execSync calls will return the matching response
 * const { execSync } = require("child_process");
 * expect(execSync("ls -la")).toBe("file1.txt\\nfile2.txt"); // Matches on "ls" substring
 * expect(execSync("git status --short")).toBe("On _branch main\\nnothing to commit"); // Matches on "git status" substring
 */
export function createMockExecSync(
  commandResponses: Record<string, string>
): ReturnType<typeof createMock> {
  return createMock((command: unknown) => {
    // Find the first matching command pattern
    for (const [pattern, response] of Object.entries(String(commandResponses))) {
      if ((command as string).includes(String(pattern))) {
        return response;
      }
    }
    // Default response if no pattern matches
    return "";
  });
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
 *   updateUser(id: string, data: unknown): Promise<boolean>;
 *   deleteUser(id: string): Promise<boolean>;
 * }
 *
 * // Create a partial mock with only some methods implemented
 * const mockUserService = createPartialMock<UserService>({
 *   getUser: async (id) => id === "TEST_VALUE" ? { id, name: "Test User" } : null
 * });
 *
 * // Other methods are automatically mocked and can be used in tests
 * await mockUserService.updateUser("TEST_VALUE", { name: "Updated" });
 * expect(mockUserService.updateUser).toHaveBeenCalledWith("TEST_VALUE", { name: "Updated" });
 */
export function createPartialMock<T extends object>(implementations: Partial<T> = {}): T {
  // Create a base object with the provided implementations
  const base = { ...implementations } as Record<string, unknown>;

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
