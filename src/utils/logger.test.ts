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
import { beforeEach, describe, expect, test } from "bun:test";
import { LogMode, getLogMode, createConfigurableLogger } from "./logger.js";

describe("Logger", () => {
  describe("getLogMode", () => {
    test("should return HUMAN when configuration mode is set to HUMAN", () => {
      const config = { mode: "HUMAN" as const, level: "info" as const, enableAgentLogs: false };
      expect(getLogMode(config)).toBe(LogMode.HUMAN);
    });

    test("should return STRUCTURED when configuration mode is set to STRUCTURED", () => {
      const config = { mode: "STRUCTURED" as const, level: "info" as const, enableAgentLogs: false };
      expect(getLogMode(config)).toBe(LogMode.STRUCTURED);
    });

    test("should default to HUMAN when mode is auto and TTY is available", () => {
      const config = { mode: "auto" as const, level: "info" as const, enableAgentLogs: false };
      
      // Mock TTY to be true
      const originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });

      expect(getLogMode(config)).toBe(LogMode.HUMAN);

      // Restore original TTY value
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    });

    test("should default to STRUCTURED when mode is auto and TTY is not available", () => {
      const config = { mode: "auto" as const, level: "info" as const, enableAgentLogs: false };
      
      // Mock TTY to be false
      const originalIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        configurable: true,
      });

      expect(getLogMode(config)).toBe(LogMode.STRUCTURED);

      // Restore original TTY value
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    });
  });

  describe("createConfigurableLogger", () => {
    test("should create logger with configuration", () => {
      const config = { mode: "HUMAN" as const, level: "debug" as const, enableAgentLogs: true };
      const logger = createConfigurableLogger(config);

      expect(logger.mode).toBe(LogMode.HUMAN);
      expect(logger.config).toEqual(config);
      expect(logger.isHumanMode()).toBe(true);
      expect(logger.isStructuredMode()).toBe(false);
    });

    test("should create logger with STRUCTURED mode", () => {
      const config = { mode: "STRUCTURED" as const, level: "info" as const, enableAgentLogs: false };
      const logger = createConfigurableLogger(config);

      expect(logger.mode).toBe(LogMode.STRUCTURED);
      expect(logger.config).toEqual(config);
      expect(logger.isHumanMode()).toBe(false);
      expect(logger.isStructuredMode()).toBe(true);
    });

    test("should expose logger methods", () => {
      const config = { mode: "HUMAN" as const, level: "info" as const, enableAgentLogs: false };
      const logger = createConfigurableLogger(config);

      // Check all logger methods exist
      expect(typeof logger.agent).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.cli).toBe("function");
      expect(typeof logger.cliWarn).toBe("function");
      expect(typeof logger.cliError).toBe("function");
      expect(typeof logger.cliDebug).toBe("function");
      expect(typeof logger.systemDebug).toBe("function");
      expect(typeof logger.setLevel).toBe("function");
    });

    test("should support dependency injection for testing", () => {
      const testConfig = { mode: "STRUCTURED" as const, level: "debug" as const, enableAgentLogs: true };
      const logger = createConfigurableLogger(testConfig);

      // Logger should use the injected configuration
      expect(logger.config).toEqual(testConfig);
      expect(logger.mode).toBe(LogMode.STRUCTURED);
    });

    test("should handle different log levels", () => {
      const debugConfig = { mode: "STRUCTURED" as const, level: "debug" as const, enableAgentLogs: true };
      const infoConfig = { mode: "STRUCTURED" as const, level: "info" as const, enableAgentLogs: true };
      
      const debugLogger = createConfigurableLogger(debugConfig);
      const infoLogger = createConfigurableLogger(infoConfig);

      expect(debugLogger.config.level).toBe("debug");
      expect(infoLogger.config.level).toBe("info");
    });

    test("should isolate logger instances", () => {
      const config1 = { mode: "HUMAN" as const, level: "info" as const, enableAgentLogs: false };
      const config2 = { mode: "STRUCTURED" as const, level: "debug" as const, enableAgentLogs: true };
      
      const logger1 = createConfigurableLogger(config1);
      const logger2 = createConfigurableLogger(config2);

      // Each logger should maintain its own configuration
      expect(logger1.mode).toBe(LogMode.HUMAN);
      expect(logger2.mode).toBe(LogMode.STRUCTURED);
      expect(logger1.config).toEqual(config1);
      expect(logger2.config).toEqual(config2);
    });
  });

  describe("configuration integration", () => {
    test("should maintain backward compatibility", () => {
      // Default logger should still work
      const logger = createConfigurableLogger();
      
      expect(logger.mode).toBeDefined();
      expect(logger.config).toBeDefined();
      expect(typeof logger.agent).toBe("function");
    });

    test("should support enableAgentLogs configuration", () => {
      const configWithAgent = { mode: "HUMAN" as const, level: "info" as const, enableAgentLogs: true };
      const configWithoutAgent = { mode: "HUMAN" as const, level: "info" as const, enableAgentLogs: false };
      
      const loggerWithAgent = createConfigurableLogger(configWithAgent);
      const loggerWithoutAgent = createConfigurableLogger(configWithoutAgent);

      expect(loggerWithAgent.config.enableAgentLogs).toBe(true);
      expect(loggerWithoutAgent.config.enableAgentLogs).toBe(false);
    });
  });
});
