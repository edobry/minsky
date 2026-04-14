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
        return (target as Record<string | symbol, unknown>)[prop];
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
