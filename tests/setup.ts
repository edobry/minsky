/**
 * Global Test Setup
 *
 * This file sets up global mocks and configuration for all tests.
 * It mocks the logger to prevent console output noise during test runs.
 */

import { mock } from "bun:test";
import { mockLogger, resetMockLogger } from "../src/utils/test-utils/mock-logger";

// Global test setup - logger mocks apply to all tests
// Use Bun's mock system to replace the logger module
// This prevents any console output during tests while preserving logging functionality
mock.module("../src/utils/logger", () => ({
  log: mockLogger,
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Also mock the domain logger if it exists
mock.module("../src/domain/utils/logger", () => ({
  log: mockLogger,
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Set up global test environment variables
process.env.NODE_ENV = "test";
process.env.MINSKY_LOG_LEVEL = "error";
process.env.MINSKY_LOG_MODE = "STRUCTURED";

// Check for debug mode to bypass console mocking
const isDebugMode = process.env.DEBUG_TESTS === "1" || process.env.DEBUG === "1";

if (isDebugMode) {
  process.stdout.write("🐛 DEBUG MODE: Console mocking disabled for debugging\n");
} else {
  // Print setup message before mocking console
  process.stdout.write(
    "🔇 Global test setup: Logger and console mocked to prevent output during tests\n"
  );

  // Mock the console methods globally to prevent any console output during tests
  const originalConsole = { ...console };
  console.log = mock(() => {});
  console.info = mock(() => {});
  console.warn = mock(() => {});
  console.error = mock(() => {});
  console.debug = mock(() => {});
}

// Export mock logger utilities for tests that need to verify logging behavior
export {
  mockLogger,
  resetMockLogger,
  wasMessageLogged,
  getLoggedErrors,
  getLoggedWarnings,
} from "../src/utils/test-utils/mock-logger";
