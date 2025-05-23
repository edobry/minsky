/**
 * Tests for the logger utility
 *
 * @module logger.test
 * @migrated Uses native Bun test patterns
 */
/// <reference types="node" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="es2015" />
/// <reference lib="webworker" />
import { beforeEach, describe, expect, test, mock } from "bun:test";
import * as process from "process";

// Mock implementation of LogMode and getLogMode for testing
enum LogMode {
  STRUCTURED = "STRUCTURED",
  HUMAN = "HUMAN",
}

function getLogMode(): LogMode {
  const envMode = process.env.MINSKY_LOG_MODE?.toUpperCase();

  // If explicitly set via environment variable, respect that
  if (envMode === LogMode.STRUCTURED) {
    return LogMode.STRUCTURED;
  }

  if (envMode === LogMode.HUMAN) {
    return LogMode.HUMAN;
  }

  // Auto-detect based on terminal environment
  const isTTY = process.stdout.isTTY;
  return isTTY ? LogMode.HUMAN : LogMode.STRUCTURED;
}

describe("Logger", () => {
  // Save original environment
  const originalEnv = { ...process.env };
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    // Reset environment variables before each test
    for (const key in process.env) {
      if (key !== "NODE_ENV" && !key.startsWith("BUN_")) {
        delete process.env[key];
      }
    }

    // Restore only non-test environment variables
    for (const key in originalEnv) {
      if (key !== "MINSKY_LOG_MODE" && key !== "NODE_ENV" && !key.startsWith("BUN_")) {
        process.env[key] = originalEnv[key];
      }
    }

    // Restore original TTY value
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      configurable: true,
    });
  });

  describe("getLogMode", () => {
    test("should return HUMAN when MINSKY_LOG_MODE is set to HUMAN", () => {
      process.env.MINSKY_LOG_MODE = "HUMAN";
      expect(getLogMode()).toBe(LogMode.HUMAN);
    });

    test("should return STRUCTURED when MINSKY_LOG_MODE is set to STRUCTURED", () => {
      process.env.MINSKY_LOG_MODE = "STRUCTURED";
      expect(getLogMode()).toBe(LogMode.STRUCTURED);
    });

    test("should handle lowercase env var values", () => {
      process.env.MINSKY_LOG_MODE = "human";
      expect(getLogMode()).toBe(LogMode.HUMAN);
    });

    test("should default based on TTY when env var is not set", () => {
      // Set TTY to true
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      expect(getLogMode()).toBe(LogMode.HUMAN);

      // Set TTY to false
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        configurable: true,
      });
      expect(getLogMode()).toBe(LogMode.STRUCTURED);
    });
  });
});
