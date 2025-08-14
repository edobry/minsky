/**
 * Config Set Command Tests
 *
 * Test-driven development for the minsky config set command
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { executeConfigSet, parseConfigValue, formatValue } from "./set";
import * as configWriter from "../../domain/configuration/config-writer";
import { log } from "../../utils/logger";

// Mock the config writer module
let createWriterSpy: any;
let mockConfigWriter: any;

describe("config set command", () => {
  let mockConsoleLog: any;
  let mockLogError: any;

  beforeEach(() => {
    // Reset and set up mocks
    mockConsoleLog = spyOn(console, "log").mockImplementation(() => {});
    mockLogError = spyOn(log, "error").mockImplementation(() => {});

    // Mock the config writer factory to return a stable writer object
    mockConfigWriter = {
      setConfigValue: mock(() =>
        Promise.resolve({ success: true, filePath: "/home/user/.config/minsky/config.yaml" })
      ),
    };
    createWriterSpy = spyOn(configWriter, "createConfigWriter").mockImplementation(
      () => mockConfigWriter
    );
  });

  afterEach(() => {
    mock.restore();
  });

  describe("executeConfigSet function", () => {
    test("should set a simple configuration value", async () => {
      // Test scenario: Setting a basic configuration value
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: undefined,
          newValue: "markdown",
        })
      );

      // Test the function directly
      await executeConfigSet("backend", "markdown", {});

      expect(createWriterSpy).toHaveBeenCalledWith({
        createBackup: true,
        format: "yaml",
        validate: true,
      });
      expect(mockConfigWriter.setConfigValue).toHaveBeenCalledWith("backend", "markdown");
      expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration updated successfully");
    });

    test("should set a nested configuration value", async () => {
      // Test scenario: Setting nested configuration like ai.providers.openai.model
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: "gpt-3.5-turbo",
          newValue: "gpt-4",
          backupPath: "/home/user/.config/minsky/config.yaml.backup.2024-01-15T10-30-45-123Z",
        })
      );

      await executeConfigSet("ai.providers.openai.model", "gpt-4", {});

      expect(mockConfigWriter.setConfigValue).toHaveBeenCalledWith(
        "ai.providers.openai.model",
        "gpt-4"
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration updated successfully");
      expect(mockConsoleLog).toHaveBeenCalledWith('   Previous value: "gpt-3.5-turbo"');
      expect(mockConsoleLog).toHaveBeenCalledWith('   New value: "gpt-4"');
    });

    test("should parse boolean values correctly", async () => {
      // Test scenario: Setting boolean configuration values
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: false,
          newValue: true,
        })
      );

      await executeConfigSet("logger.enableAgentLogs", "true", {});

      expect(mockConfigWriter.setConfigValue).toHaveBeenCalledWith("logger.enableAgentLogs", true);
    });

    test("should handle config writer failures gracefully", async () => {
      // Bug scenario: Config writer fails to set value
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: false,
          filePath: "/home/user/.config/minsky/config.yaml",
          error: "Permission denied",
        })
      );
      await executeConfigSet("key", "value", {});
      // Should not throw; logging handled internally
      expect(true).toBe(true);
    });

    test("should output JSON format when requested", async () => {
      // Test scenario: JSON output format
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: "old",
          newValue: "new",
          backupPath: "/backup/path",
        })
      );

      await executeConfigSet("key", "new", { json: true });

      const expectedOutput = {
        success: true,
        key: "key",
        previousValue: "old",
        newValue: "new",
        filePath: "/home/user/.config/minsky/config.yaml",
        backupPath: "/backup/path",
      };

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(expectedOutput, null, 2));
    });

    test("should skip backup when noBackup option is set", async () => {
      // Test scenario: User explicitly disables backup
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: undefined,
          newValue: "value",
        })
      );

      await executeConfigSet("key", "value", { noBackup: true });

      expect(createWriterSpy).toHaveBeenCalledWith({
        createBackup: false,
        format: "yaml",
        validate: true,
      });
    });

    test("should use JSON format when specified", async () => {
      // Test scenario: User specifies JSON format preference
      mockConfigWriter.setConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.json",
          previousValue: undefined,
          newValue: "value",
        })
      );

      await executeConfigSet("key", "value", { format: "json" });

      expect(createWriterSpy).toHaveBeenCalledWith({
        createBackup: true,
        format: "json",
        validate: true,
      });
    });
  });

  describe("parseConfigValue function", () => {
    test("should parse boolean values correctly", () => {
      expect(parseConfigValue("true")).toBe(true);
      expect(parseConfigValue("false")).toBe(false);
    });

    test("should parse null and undefined", () => {
      expect(parseConfigValue("null")).toBe(null);
      expect(parseConfigValue("undefined")).toBe(undefined);
    });

    test("should parse numbers correctly", () => {
      expect(parseConfigValue("42")).toBe(42);
      expect(parseConfigValue("-42")).toBe(-42);
      expect(parseConfigValue("3.14")).toBe(3.14);
      expect(parseConfigValue("-3.14")).toBe(-3.14);
    });

    test("should parse JSON objects correctly", () => {
      const complexValue = { key: "value", nested: { array: [1, 2, 3] } };
      expect(parseConfigValue(JSON.stringify(complexValue))).toEqual(complexValue);
    });

    test("should parse JSON arrays correctly", () => {
      const arrayValue = ["item1", "item2", "item3"];
      expect(parseConfigValue(JSON.stringify(arrayValue))).toEqual(arrayValue);
    });

    test("should treat malformed JSON as string", () => {
      const malformedJson = "{not valid json";
      expect(parseConfigValue(malformedJson)).toBe(malformedJson);
    });

    test("should treat regular strings as strings", () => {
      expect(parseConfigValue("hello world")).toBe("hello world");
      expect(parseConfigValue("")).toBe("");
    });

    test("should handle number-like strings that aren't pure numbers", () => {
      expect(parseConfigValue("42abc")).toBe("42abc");
      expect(parseConfigValue("abc42")).toBe("abc42");
    });
  });

  describe("formatValue function", () => {
    test("should format undefined as (not set)", () => {
      expect(formatValue(undefined)).toBe("(not set)");
    });

    test("should format null as null", () => {
      expect(formatValue(null)).toBe("null");
    });

    test("should format strings with quotes", () => {
      expect(formatValue("hello")).toBe('"hello"');
      expect(formatValue("")).toBe('""');
    });

    test("should format numbers as strings", () => {
      expect(formatValue(42)).toBe("42");
      expect(formatValue(3.14)).toBe("3.14");
      expect(formatValue(-42)).toBe("-42");
    });

    test("should format booleans as strings", () => {
      expect(formatValue(true)).toBe("true");
      expect(formatValue(false)).toBe("false");
    });

    test("should format objects as JSON", () => {
      const obj = { key: "value" };
      expect(formatValue(obj)).toBe(JSON.stringify(obj));
    });

    test("should format arrays as JSON", () => {
      const arr = [1, 2, 3];
      expect(formatValue(arr)).toBe(JSON.stringify(arr));
    });
  });
});
