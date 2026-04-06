/**
 * Test utilities for standardizing test setup, cleanup, and common functions
 */
import { afterEach, beforeEach, spyOn } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createRobustTempDir } from "./tempdir";
import { log } from "./logger";
// Re-export mocking utilities from the dedicated module
export * from "./test-utils/mocking";

// Make TypeScript happy with Node.js global objects
declare const global: {
  Date: DateConstructor;
  [key: string]: unknown;
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
export const createTempTestDir: (prefix?: string) => string | undefined = createRobustTempDir;

/**
 * Sets up console spies for capturing and testing output
 * Returns the created spies for use in assertions
 */
export function setupConsoleSpy() {
  const consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  // process.exit has signature `(code?: number) => never`. spyOn requires the object
  // to have the method as a typed property; cast to a minimal interface to avoid the
  // full NodeJS.Process type complexity that breaks spyOn's overload resolution.
  const processWithExit = process as { exit: (code?: number) => never };
  const processExitSpy = spyOn(processWithExit, "exit").mockImplementation(() => {
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
  class MockDate extends originalDate {
    constructor() {
      super(fixedDate);
    }
    static now() {
      return fixedDateTime;
    }
    static parse = originalDate.parse;
    static UTC = originalDate.UTC;
  }

  // Replace global Date — MockDate extends Date so it structurally satisfies DateConstructor
  global.Date = MockDate as DateConstructor;

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
      const dir = createTempTestDir();
      tempDir = typeof dir === "string" ? dir : undefined;
      if (!tempDir) {
        log.warn(
          "[SKIP] Temp dir could not be created in this environment. Skipping temp dir setup."
        );
      }
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
    if (typeof tempDir === "string" && fs.existsSync(tempDir)) {
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
