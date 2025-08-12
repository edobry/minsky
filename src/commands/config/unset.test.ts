/**
 * Config Unset Command Tests
 *
 * Test-driven development for the minsky config unset command
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { executeConfigUnset, formatValue } from "./unset";
import * as configWriter from "../../domain/configuration/config-writer";

// Mock the config writer module
let mockCreateConfigWriter = mock();
let mockUnsetConfigValue = mock();

const mockConfigWriter = {
  unsetConfigValue: mockUnsetConfigValue,
};

describe("config unset command", () => {
  let mockConsoleLog: any;
  let mockProcessExit: any;

  beforeEach(() => {
    // Reset all mocks
    mockCreateConfigWriter.mockReset();
    mockUnsetConfigValue.mockReset();

    // Mock console methods
    mockConsoleLog = spyOn(console, "log").mockImplementation(() => {});

    // Mock process.exit
    mockProcessExit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit() called");
    });

    // Mock the config writer factory
    spyOn(configWriter, "createConfigWriter").mockImplementation(mockCreateConfigWriter);
    mockCreateConfigWriter = mock(() => mockConfigWriter);
  });

  afterEach(() => {
    mock.restore();
  });

  describe("executeConfigUnset function", () => {
    test("should remove an existing configuration value", async () => {
      // Test scenario: Removing an existing configuration value
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: "gpt-3.5-turbo",
          newValue: undefined,
          backupPath: "/home/user/.config/minsky/config.yaml.backup.2024-01-15T10-30-45-123Z",
        })
      );

      await executeConfigUnset("ai.providers.openai.model", {});

      expect(mockCreateConfigWriter).toHaveBeenCalledWith({
        createBackup: true,
        format: "yaml",
        validate: true,
      });
      expect(mockUnsetConfigValue).toHaveBeenCalledWith("ai.providers.openai.model");
      expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration removed successfully");
      expect(mockConsoleLog).toHaveBeenCalledWith('   Previous value: "gpt-3.5-turbo"');
    });

    test("should handle unsetting non-existent values gracefully", async () => {
      // Test scenario: Trying to unset a value that doesn't exist
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: undefined,
          newValue: undefined,
        })
      );

      await executeConfigUnset("nonExistent.key", {});

      expect(mockUnsetConfigValue).toHaveBeenCalledWith("nonExistent.key");
      expect(mockConsoleLog).toHaveBeenCalledWith("ℹ️  Configuration key was already unset");
      expect(mockConsoleLog).toHaveBeenCalledWith("   Key: nonExistent.key");
    });

    test("should handle nested configuration values", async () => {
      // Test scenario: Removing deeply nested configuration values
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: { model: "gpt-4" },
          newValue: undefined,
          backupPath: "/backup/path",
        })
      );

      await executeConfigUnset("ai.providers.openai", {});

      expect(mockUnsetConfigValue).toHaveBeenCalledWith("ai.providers.openai");
      expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration removed successfully");
      expect(mockConsoleLog).toHaveBeenCalledWith('   Previous value: {"model":"gpt-4"}');
    });

    test("should handle config writer failures gracefully", async () => {
      // Bug scenario: Config writer fails to unset value
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: false,
          filePath: "/home/user/.config/minsky/config.yaml",
          error: "Permission denied",
        })
      );

      try {
        await executeConfigUnset("key", {});
        expect(true).toBe(false); // Should not reach this line
      } catch (error) {
        expect(error.message).toBe("process.exit() called");
      }

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    test("should output JSON format when requested", async () => {
      // Test scenario: JSON output format
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: "oldValue",
          newValue: undefined,
          backupPath: "/backup/path",
        })
      );

      await executeConfigUnset("key", { json: true });

      const expectedOutput = {
        success: true,
        key: "key",
        previousValue: "oldValue",
        filePath: "/home/user/.config/minsky/config.yaml",
        backupPath: "/backup/path",
      };

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(expectedOutput, null, 2));
    });

    test("should skip backup when noBackup option is set", async () => {
      // Test scenario: User explicitly disables backup
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.yaml",
          previousValue: "value",
          newValue: undefined,
        })
      );

      await executeConfigUnset("key", { noBackup: true });

      expect(mockCreateConfigWriter).toHaveBeenCalledWith({
        createBackup: false,
        format: "yaml",
        validate: true,
      });
    });

    test("should use JSON format when specified", async () => {
      // Test scenario: User specifies JSON format preference
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: true,
          filePath: "/home/user/.config/minsky/config.json",
          previousValue: "value",
          newValue: undefined,
        })
      );

      await executeConfigUnset("key", { format: "json" });

      expect(mockCreateConfigWriter).toHaveBeenCalledWith({
        createBackup: true,
        format: "json",
        validate: true,
      });
    });

    test("should handle exceptions from config writer", async () => {
      // Bug scenario: Config writer throws an exception
      mockUnsetConfigValue = mock(() => Promise.reject(new Error("Unexpected error")));

      try {
        await executeConfigUnset("key", {});
        expect(true).toBe(false); // Should not reach this line
      } catch (error) {
        expect(error.message).toBe("process.exit() called");
      }

      expect(mockProcessExit).toHaveBeenCalledWith(1);
    });

    test("should output error in JSON format when requested", async () => {
      // Bug scenario: Error occurs with JSON output requested
      mockUnsetConfigValue = mock(() =>
        Promise.resolve({
          success: false,
          filePath: "/home/user/.config/minsky/config.yaml",
          error: "File not found",
        })
      );

      try {
        await executeConfigUnset("key", { json: true });
        expect(true).toBe(false); // Should not reach this line
      } catch (error) {
        expect(error.message).toBe("process.exit() called");
      }

      const expectedOutput = {
        success: false,
        error: "Failed to unset configuration: File not found",
      };

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(expectedOutput, null, 2));
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
      const obj = { key: "value", nested: { array: [1, 2, 3] } };
      expect(formatValue(obj)).toBe(JSON.stringify(obj));
    });

    test("should format arrays as JSON", () => {
      const arr = [1, 2, 3];
      expect(formatValue(arr)).toBe(JSON.stringify(arr));
    });
  });
});
