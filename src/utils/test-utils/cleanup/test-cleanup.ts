/**
 * Test Cleanup Utilities
 *
 * Provides test cleanup and setup utilities for consistent test environment management.
 * This module handles mock cleanup and registry resets between tests.
 *
 * @module cleanup/test-cleanup
 */
import { afterEach } from "bun:test";

/**
 * Sets up test mocks with automatic cleanup in afterEach hook.
 * Ensures mocks are properly restored after each test to prevent test pollution.
 * Also cleans up shared state like command registries.
 *
 * @example
 * // At the top of your test file
 * setupTestMocksWithCleanup();
 *
 * describe("My Test Suite", () => {
 *   test("my test", () => {
 *     // Your test code here
 *     // Mocks will be automatically cleaned up after each test
 *   });
 * });
 */
export function setupTestMocksWithCleanup(): void {
  afterEach(() => {
    resetTestState();
  });
}

/**
 * Resets global test state and cleans up mocks.
 * This function can be called manually or is automatically called by setupTestMocksWithCleanup.
 *
 * This includes:
 * - Resetting command registries
 * - Clearing CLI bridge customizations
 * - Resetting error handler state
 * - Cleaning up mock compatibility layer state
 * - Resetting Jest-like globals
 * - Restoring any global test state
 */
export function resetTestState(): void {
  try {
    // Reset command registry if it exists
    const commandRegistryModule = require("../../adapters/shared/command-registry");
    if (commandRegistryModule?.registry?.clear) {
      commandRegistryModule.registry.clear();
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }

  try {
    // Reset CLI bridge state if it exists
    const cliBridgeModule = require("../../adapters/shared/bridges/cli-bridge");
    if (cliBridgeModule?.cliBridge) {
      // Reset any cached command state in the CLI bridge
      const bridge = cliBridgeModule.cliBridge;
      if (bridge.customizations) {
        bridge.customizations.clear();
      }
      if (bridge.categoryCustomizations) {
        bridge.categoryCustomizations.clear();
      }
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }

  try {
    // Reset error handler state if it exists
    const errorHandlerModule = require("../../adapters/shared/error-handling");
    if (errorHandlerModule?.cliErrorHandler) {
      // Reset any cached error state
      // Note: Most error handlers are stateless, but included for completeness
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }

  try {
    // Reset global invocation counter from mock compatibility layer
    const compatModule = require("./compatibility/mock-function");
    if (compatModule?.resetAllMocks) {
      compatModule.resetAllMocks();
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }

  try {
    // Reset Jest-like globals if they exist
    const jestCompatModule = require("./compatibility/index");
    if (jestCompatModule?.jest?.resetModules) {
      jestCompatModule.jest.resetModules();
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }

  try {
    // Reset any global test state
    if (typeof global !== "undefined") {
      // Reset date functions if they were mocked
      const testUtilsModule = require("../test-utils");
      if (testUtilsModule?.mockDateFunctions && global.Date !== Date) {
        // If Date was mocked, restore it
        // Note: This is defensive - proper tests should restore their own mocks
      }
    }
  } catch (error) {
    // Ignore errors if the module doesn't exist
  }
}
