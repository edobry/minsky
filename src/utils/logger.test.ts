import { beforeEach, describe, expect, test } from "bun:test";
import { getLogMode, LogMode } from "./logger";

describe("Logger", () => {
  // Save original environment
  const originalEnv = { ...process.env };
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    delete process.env.MINSKY_LOG_MODE;
    
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
