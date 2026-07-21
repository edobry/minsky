import "reflect-metadata";
/**
 * Global Test Setup
 *
 * This file sets up global mocks and configuration for all tests.
 * It mocks the logger to prevent console output noise during test runs.
 */

// eslint-disable-next-line custom/no-real-fs-in-tests -- this is the test PRELOAD, not a test: it must create a REAL writable temp dir so any code path that writes Minsky state during tests lands somewhere harmless (a fake path would make fail-open writers degrade and change behavior under test)
import { mkdtempSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above; mkdtempSync guarantees per-run uniqueness, no race
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import { mockLogger } from "../src/utils/test-utils/mock-logger";
import { TEST_LOGGER_SILENCED_FLAG } from "@minsky/shared/logger";

// State-dir isolation (mt#2872): any code path that resolves the Minsky state
// dir (guard-health log, disconnect log, caches) must NEVER touch the
// operator's real ~/.local/state/minsky during tests. A dispatcher test that
// exercised a throwing guard without overriding the default recorder wrote
// fixture rows (guard "throws", error "boom") into the REAL guard-health log,
// firing a CRITICAL operator escalation for a guard that doesn't exist.
// Point MINSKY_STATE_DIR at a per-run temp dir unless the invoker already set
// one (individual tests still set/restore their own for path-specific cases).
if (!process.env.MINSKY_STATE_DIR) {
  process.env.MINSKY_STATE_DIR = mkdtempSync(join(tmpdir(), "minsky-test-state-"));
}

// Global test setup - logger mocks apply to all tests
// Use Bun's mock system to replace the logger module
// This prevents any console output during tests while preserving logging functionality
mock.module("../src/utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Mock additional relative paths to the logger
mock.module("../../utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

mock.module("../../../utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  createConfigurableLogger: () => mockLogger,
  createLogger: () => mockLogger,
  isStructuredMode: () => false,
  isHumanMode: () => true,
}));

// Mock utils/logger from different directory levels
mock.module("../../src/utils/logger", () => ({
  log: {
    ...mockLogger,
    info: mock(() => {}),
    cli: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
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

  // mt#2975: request the shared logger silence its winston Console transports
  // for THIS in-process harness only. A globalThis flag (unlike an env var) does
  // not cross into subprocesses that tests spawn via child_process — those run
  // the real CLI without this preload, so their startup logs (e.g. the MCP
  // "Ready to receive MCP requests via HTTP" readiness marker that
  // start-command.test.ts waits for) still reach stdout.
  (globalThis as Record<string, unknown>)[TEST_LOGGER_SILENCED_FLAG] = true;

  // Mock the console methods globally to prevent any console output during tests
  const _originalConsole = { ...console };
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
