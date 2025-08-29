/**
 * Config Unset Command Tests
 *
 * Test-driven development for the minsky config unset command
 */

import { describe, test, expect, mock } from "bun:test";
import { executeConfigUnset, type ConfigUnsetDependencies } from "./unset";
import { TEST_PATHS, ERROR_MESSAGES } from "../../utils/test-utils/test-constants";

describe("config unset command", () => {
  test("should remove an existing configuration value", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
        previousValue: "markdown",
        newValue: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("backend", {}, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: true,
      format: "yaml",
      validate: true,
    });
    expect(mockUnsetConfigValue).toHaveBeenCalledWith("backend");
    expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration removed successfully");
  });

  test("should handle unsetting non-existent values gracefully", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
        previousValue: undefined,
        newValue: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("nonexistent", {}, deps);

    expect(mockUnsetConfigValue).toHaveBeenCalledWith("nonexistent");
    expect(mockConsoleLog).toHaveBeenCalledWith("ℹ️  Configuration key was already unset");
  });

  test("should handle nested configuration values", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
        previousValue: "gpt-4",
        newValue: undefined,
        backupPath: "/home/user/.config/minsky/config.yaml.backup.2024-01-15T10-30-45-123Z",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("model.default", {}, deps);

    expect(mockUnsetConfigValue).toHaveBeenCalledWith("model.default");
    expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration removed successfully");
  });

  test("should handle config writer failures gracefully", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: false,
        error: "Permission denied",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    try {
      await executeConfigUnset("key", {}, deps);
      expect(true).toBe(false); // Should not reach this line
    } catch (error) {
      expect(error.message).toBe(ERROR_MESSAGES.FAILED_UNSET_CONFIG_PERMISSION);
    }
  });

  test("should output JSON format when requested", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
        previousValue: "test",
        newValue: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("key", { json: true }, deps);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify(
        {
          success: true,
          key: "key",
          previousValue: "test",
          newValue: undefined,
          filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
          backupPath: undefined,
        },
        null,
        2
      )
    );
  });

  test("should skip backup when noBackup option is set", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: TEST_PATHS.MINSKY_CONFIG_FILE,
        previousValue: "value",
        newValue: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("key", { noBackup: true }, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: false,
      format: "yaml",
      validate: true,
    });
  });

  test("should use JSON format when specified", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.json",
        previousValue: "value",
        newValue: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigUnset("key", { format: "json" }, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: true,
      format: "json",
      validate: true,
    });
  });

  test("should handle exceptions from config writer", async () => {
    const mockUnsetConfigValue = mock(() => Promise.reject(new Error("Unexpected error")));

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    try {
      await executeConfigUnset("key", {}, deps);
      expect(true).toBe(false); // Should not reach this line
    } catch (error) {
      expect(error.message).toBe("Unexpected error");
    }
  });

  test("should output error in JSON format when requested", async () => {
    const mockUnsetConfigValue = mock(() =>
      Promise.resolve({
        success: false,
        error: "Permission denied",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      unsetConfigValue: mockUnsetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigUnsetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    try {
      await executeConfigUnset("key", { json: true }, deps);
      expect(true).toBe(false); // Should not reach this line
    } catch (error) {
      expect(error.message).toBe(ERROR_MESSAGES.FAILED_UNSET_CONFIG_PERMISSION);
    }

    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify(
        {
          success: false,
          error: ERROR_MESSAGES.FAILED_UNSET_CONFIG_PERMISSION,
        },
        null,
        2
      )
    );
  });
});
