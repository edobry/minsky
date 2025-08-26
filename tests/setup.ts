/**
 * Global Test Setup
 *
 * This file sets up global mocks and configuration for all tests.
 * It mocks the logger to prevent console output noise during test runs.
 */

import { beforeEach, afterEach } from "bun:test";
import { mockLogger, resetMockLogger } from "../src/utils/test-utils/mock-logger";

// Mock the logger module to use our in-memory mock instead of the real logger
// This prevents any console output during tests while preserving logging functionality
const originalModule = await import("../src/utils/logger");

// Store original logger for potential restoration
const originalLog = originalModule.log;
const originalCreateLogger = originalModule.createConfigurableLogger;

// Replace the logger exports with our mock
Object.defineProperty(originalModule, "log", {
  value: mockLogger,
  writable: true,
  configurable: true,
});

Object.defineProperty(originalModule, "createConfigurableLogger", {
  value: () => mockLogger,
  writable: true,
  configurable: true,
});

// Also mock the createLogger export if it exists
if ("createLogger" in originalModule) {
  Object.defineProperty(originalModule, "createLogger", {
    value: () => mockLogger,
    writable: true,
    configurable: true,
  });
}

// Set up global test environment
beforeEach(() => {
  // Reset mock logger state before each test
  resetMockLogger();

  // Set test environment variables to ensure quiet logging
  process.env.NODE_ENV = "test";
  process.env.MINSKY_LOG_LEVEL = "silent";
  process.env.MINSKY_LOG_MODE = "test";
});

afterEach(() => {
  // Clean up after each test
  resetMockLogger();
});

// Export mock logger utilities for tests that need to verify logging behavior
export { mockLogger, resetMockLogger } from "../src/utils/test-utils/mock-logger";
export {
  wasMessageLogged,
  getLoggedErrors,
  getLoggedWarnings,
} from "../src/utils/test-utils/mock-logger";

console.log("🔇 Global test setup: Logger mocked to prevent console output during tests");
