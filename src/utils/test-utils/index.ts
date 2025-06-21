/**
 * Test Utilities
 *
 * This module exports utilities for testing Minsky components.
 * It includes utilities for:
 * - Mocking common functions and services
 * - Creating test fixtures
 * - Managing test state
 * - Jest/Vitest compatibility with Bun's test runner
 */

// Import and re-export from mocking module
export * from "./mocking";

// Import and re-export compatibility layer with namespace to avoid conflicts
import * as compat from "./compatibility";
export { compat };

// Export a convenient named export for the compatibility layer
export { setupTestCompat as setupJestCompat } from "./compatibility";

// Re-export dependency utilities
export * from "./dependencies";

// Re-export factory functions for test data
export * from "./factories";

// Additional exports from the main test-utils file
export {
  mockDateFunctions,
  setupConsoleSpy,
  createTempTestDir,
  setupTestEnvironment,
  TEST_TIMESTAMPS,
} from "../test-utils";

// Export types commonly used in tests
export interface MockFn<T extends (...args: unknown[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  mock: {
    calls: Array<Parameters<T>>;
    results: Array<{
      type: "return" | "throw";
      value: ReturnType<T> | Error;
    }>;
  };
  mockImplementation: (fn: T) => void;
  mockReturnValue: (value: ReturnType<T>) => void;
  mockResolvedValue: <U>(value: U) => void;
  mockRejectedValue: (reason: Error) => void;
}
