/**
 * Global Test Setup
 * 
 * This file sets up global mocks and configuration for all tests.
 * It mocks the logger to prevent console output noise during test runs.
 */

import { beforeEach, afterEach, mock } from "bun:test";
import { mockLogger, resetMockLogger } from "../src/utils/test-utils/mock-logger";

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

// Export mock logger utilities for tests that need to verify logging behavior
export { mockLogger, resetMockLogger } from "../src/utils/test-utils/mock-logger";
export {
  wasMessageLogged,
  getLoggedErrors,
  getLoggedWarnings,
} from "../src/utils/test-utils/mock-logger";

console.log("🔇 Global test setup: Logger mocked to prevent console output during tests");
