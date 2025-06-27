const TEST_VALUE = 123;

/**
 * Jest/Vitest Test Compatibility Layer for Bun
 *
 * This module provides compatibility utilities to make tests written for Jest or Vitest
 * work with Bun's test runner with minimal changes. It implements:
 *
 * - Mock function APIs (mockReset, mockClear, mockReturnValue, etc.)
 * - Asymmetric matchers (expect.anything(), expect.objectContaining(), etc.)
 * - Module mocking utilities (similar to jest.mock)
 *
 * Usage: Call setupTestCompat() at the top of your test file.
 */

// Export all components of the compatibility layer
export * from "./mock-function";
export * from "./matchers";
export * from "./module-mock";

// Import specific setup functions for combined setup
import { setupMockCompat } from "./mock-function";
import { setupAsymmetricMatchers } from "./matchers";
import { setupModuleMocking, createJestModuleMocking } from "./module-mock";

/**
 * Jest/Vitest-like global object with common mock utilities
 */
export interface JestGlobal {
  /**
   * Mocks a module with a factory function
   */
  mock: (modulePath: string, factory: () => any, options?: unknown) => void;

  /**
   * Restores a mocked module to its original implementation
   */
  unmock: (_modulePath: unknown) => void;

  /**
   * Restores all mocked modules
   */
  resetModules: () => void;

  /**
   * Gets a mock object for a mocked module
   */
  getMockFromModule: (_modulePath: unknown) => any;
}

// Create a Jest-like global object
export const jest: JestGlobal = createJestModuleMocking();

/**
 * Sets up the entire compatibility layer for a test file.
 * This configures:
 * - Mock function methods (mockReset, mockClear, etc.)
 * - Asymmetric matchers (expect.anything(), etc.)
 * - Module mocking utilities
 *
 * Call this at the top of your test file, outside of any describe/test blocks.
 */
export function setupTestCompat(): void {
  // Set up each component
  setupMockCompat();
  setupAsymmetricMatchers();
  setupModuleMocking();
}

/**
 * Documentation on migrating from Jest/Vitest to Bun tests
 * using this compatibility layer.
 *
 * Basic migration steps:
 *
 * 1. Import compatibility utilities:
 *    ```ts
 *    import { describe, test, expect } from "bun:test";
 *    import { setupTestCompat, jest, createCompatMock } from "../utils/test-utils/compatibility";
 *
 *    // Set up the compatibility layer
 *    setupTestCompat();
 *    ```
 *
 * 2. Replace jest.fn() with createCompatMock():
 *    ```ts
 *    // Before:
 *    const mockFn = jest.fn();
 *
 *    // After:
 *    const mockFn = createCompatMock();
 *    ```
 *
 * 3. Module mocking works similarly:
 *    ```ts
 *    // Before:
 *    jest.mock("../path/to/module", () => ({
 *      someFunction: jest.fn()
 *    }));
 *
 *    // After:
 *    jest.mock("../path/to/module", () => ({
 *      someFunction: createCompatMock()
 *    }));
 *    ```
 *
 * 4. Asymmetric matchers are available on expect:
 *    ```ts
 *    // This should work as in Jest:
 *    expect(obj).toEqual(expect.objectContaining({
 *      _id: TEST_VALUE,
 *      name: expect.any(String)
 *    }));
 *    ```
 */
