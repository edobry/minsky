/**
 * Config Set Command Tests
 *
 * Test-driven development for the minsky config set command
 */

import { describe, test, expect, mock } from "bun:test";
import { executeConfigSet, type ConfigSetDependencies } from "./set";

describe("config set command", () => {
  test("should set a simple configuration value", async () => {
    // Create mock dependencies
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.yaml",
        previousValue: undefined,
        newValue: "markdown",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    // Test the function directly with DI
    await executeConfigSet("backend", "markdown", {}, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: true,
      format: "yaml",
      validate: true,
    });
    expect(mockSetConfigValue).toHaveBeenCalledWith("backend", "markdown");
    expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration updated successfully");
  });

  test("should set a nested configuration value", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.yaml",
        previousValue: "gpt-3.5-turbo",
        newValue: "gpt-4",
        backupPath: "/home/user/.config/minsky/config.yaml.backup.2024-01-15T10-30-45-123Z",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigSet("model.default", "gpt-4", {}, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: true,
      format: "yaml",
      validate: true,
    });
    expect(mockSetConfigValue).toHaveBeenCalledWith("model.default", "gpt-4");
    expect(mockConsoleLog).toHaveBeenCalledWith("✅ Configuration updated successfully");
  });

  test("should parse boolean values correctly", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.yaml",
        previousValue: false,
        newValue: true,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigSet("debug", "true", {}, deps);

    expect(mockSetConfigValue).toHaveBeenCalledWith("debug", true);
  });

  test("should handle config writer failures gracefully", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: false,
        error: "Permission denied",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    try {
      await executeConfigSet("key", "value", {}, deps);
      expect(true).toBe(false); // Should not reach this line
    } catch (error) {
      expect(error.message).toBe("Failed to set configuration: Permission denied");
    }
  });

  test("should output JSON format when requested", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.yaml",
        previousValue: undefined,
        newValue: "test",
        backupPath: undefined,
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigSet("key", "test", { json: true }, deps);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify(
        {
          success: true,
          key: "key",
          previousValue: undefined,
          newValue: "test",
          filePath: "/home/user/.config/minsky/config.yaml",
          backupPath: undefined,
        },
        null,
        2
      )
    );
  });

  test("should skip backup when noBackup option is set", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.yaml",
        previousValue: undefined,
        newValue: "value",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigSet("key", "value", { noBackup: true }, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: false,
      format: "yaml",
      validate: true,
    });
  });

  test("should use JSON format when specified", async () => {
    const mockSetConfigValue = mock(() =>
      Promise.resolve({
        success: true,
        filePath: "/home/user/.config/minsky/config.json",
        previousValue: undefined,
        newValue: "value",
      })
    );

    const mockCreateConfigWriter = mock(() => ({
      setConfigValue: mockSetConfigValue,
    }));

    const mockConsoleLog = mock(() => {});

    const deps: ConfigSetDependencies = {
      createConfigWriter: mockCreateConfigWriter,
      console: {
        log: mockConsoleLog,
      },
    };

    await executeConfigSet("key", "value", { format: "json" }, deps);

    expect(mockCreateConfigWriter).toHaveBeenCalledWith({
      createBackup: true,
      format: "json",
      validate: true,
    });
  });
});
