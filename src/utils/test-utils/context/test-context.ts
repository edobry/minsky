/**
 * Test Context Management
 *
 * Provides utilities for managing test contexts and resource cleanup in test suites.
 * This module includes test context management, cleanup registration, and test suite setup.
 *
 * @module context/test-context
 */

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
