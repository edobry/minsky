/**
 * Test utilities for standardizing test setup, cleanup, and common functions
 */
import { afterEach, beforeEach, mock, spyOn } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";

// Make TypeScript happy with Node.js global objects
declare const global: {
  Date: DateConstructor;
  [key: string]: any;
};

/**
 * Standard reference timestamps for use in tests
 * Using fixed timestamps eliminates test flakiness caused by time differences
 */
export const TEST_TIMESTAMPS = {
  FIXED_DATE: "2025-05-01T12:00:00.000Z",
  FIXED_DATE_2: "2025-05-02T12:00:00.000Z",
  FIXED_DATE_3: "2025-05-03T12:00:00.000Z",
};

/**
 * Creates a temporary directory for test file operations
 * Provides isolation between tests and automatic cleanup
 */
export function createTempTestDir(prefix = "minsky-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Sets up console spies for capturing and testing output
 * Returns the created spies for use in assertions
 */
export function setupConsoleSpy() {
  const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  const processExitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  return { consoleLogSpy, consoleErrorSpy, processExitSpy };
}

/**
 * Mock for date functions to provide consistent timestamps in tests
 * Overrides both Date.now() and new Date() to return fixed values
 */
export function mockDateFunctions(fixedDate = TEST_TIMESTAMPS.FIXED_DATE) {
  const originalDate = global.Date;
  const fixedDateTime = new originalDate(fixedDate).getTime();

  // Create a complete mock DateConstructor
  const MockDate = function () {
    return new originalDate(fixedDate);
  } as unknown as DateConstructor;

  // Copy all the static methods from the original Date
  MockDate.now = () => fixedDateTime;
  MockDate.parse = originalDate.parse;
  MockDate.UTC = originalDate.UTC;

  // Replace global Date
  global.Date = MockDate;

  // Return function to restore the original Date
  return () => {
    global.Date = originalDate;
  };
}

/**
 * Setup standard test environment with temp directory and console capture
 * Handles cleanup automatically via afterEach
 */
export function setupTestEnvironment(
  options: {
    mockDate?: boolean;
    createTempDir?: boolean;
  } = {}
) {
  const { mockDate = false, createTempDir = false } = options;

  let restoreDate: (() => void) | undefined;
  let tempDir: string | undefined;
  const consoleSpy = setupConsoleSpy();

  beforeEach(() => {
    if (mockDate) {
      restoreDate = mockDateFunctions();
    }

    if (createTempDir) {
      tempDir = createTempTestDir();
    }
  });

  afterEach(() => {
    // Restore original console functions
    // In Bun's test module, spies need to be unmocked individually
    consoleSpy.consoleLogSpy.mockRestore();
    consoleSpy.consoleErrorSpy.mockRestore();
    consoleSpy.processExitSpy.mockRestore();

    // Restore date if mocked
    if (restoreDate) {
      restoreDate();
    }

    // Clean up temp directory if created
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  return {
    ...consoleSpy,
    get tempDir() {
      return tempDir;
    },
  };
}
