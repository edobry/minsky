/**
 * Test utilities for standardized testing patterns across the codebase.
 * This module provides centralized access to all test utilities.
 */

// Re-export mocking utilities
export * from "./mocking";

// Additional exports from the main test-utils file
export { 
  mockDateFunctions,
  setupConsoleSpy,
  createTempTestDir,
  setupTestEnvironment, 
  TEST_TIMESTAMPS
} from "../test-utils";

// Export types commonly used in tests
export interface MockFn<T extends (...args: any[]) => any> {
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
