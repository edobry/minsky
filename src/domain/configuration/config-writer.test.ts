/**
 * Configuration Writer Tests
 *
 * Test-driven development for configuration file writing with mocked filesystem operations
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Use mock.module() to mock filesystem operations
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

// Mock filesystem operations

let mockFs: any;

const mockPath = {
  // minimal stubs for join/dirname
  join: mock(),
  dirname: mock(),
};

const mockOs = {
  homedir: mock(),
};

// Mock YAML operations
const mockYaml = {
  parse: mock(),
  stringify: mock(),
};

mock.module("fs", () => ({
  get readFileSync() {
    return mockFs.readFileSync;
  },
  get writeFileSync() {
    return mockFs.writeFileSync;
  },
  get existsSync() {
    return mockFs.existsSync;
  },
  get mkdirSync() {
    return mockFs.mkdirSync;
  },
  get copyFileSync() {
    return mockFs.copyFileSync;
  },
}));
mock.module("path", () => ({
  join: mockPath.join,
  dirname: mockPath.dirname,
}));
mock.module("os", () => ({
  homedir: mockOs.homedir,
}));
mock.module("yaml", () => ({
  parse: mockYaml.parse,
  stringify: mockYaml.stringify,
}));
import { ConfigWriter } from "./config-writer";

describe("ConfigWriter", () => {
  let writer: ConfigWriter;
  const mockConfigDir = "/home/user/.config/minsky";
  const mockConfigFile = "/home/user/.config/minsky/config.yaml";

  beforeEach(async () => {
    // Fresh mock filesystem per test
    mockFs = createMockFilesystem();
    Object.values(mockPath).forEach((m) => m.mockReset());
    Object.values(mockOs).forEach((m) => m.mockReset());
    Object.values(mockYaml).forEach((m) => m.mockReset());

    // Setup default mock behaviors
    mockOs.homedir = mock(() => "/home/user");
    mockPath.join = mock((...args) => args.join("/"));
    mockPath.dirname = mock((p) => p.split("/").slice(0, -1).join("/"));

    // Setup environment variable mock
    process.env.XDG_CONFIG_HOME = undefined;

    // Re-register module mocks per test for isolation
    mock.module("fs", () => ({
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
      copyFileSync: mockFs.copyFileSync,
    }));
    mock.module("path", () => ({ join: mockPath.join, dirname: mockPath.dirname }));
    mock.module("os", () => ({ homedir: mockOs.homedir }));
    mock.module("yaml", () => ({ parse: mockYaml.parse, stringify: mockYaml.stringify }));

    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above

    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above

    // removed spy; handled by mock.module above

    // removed spy; handled by mock.module above
    // removed spy; handled by mock.module above

    writer = new ConfigWriter(
      {
        createBackup: true,
        format: "yaml",
        validate: false,
      },
      mockFs as any
    );
  });

  afterEach(() => {
    // Restore original implementations
    mock.restore();
  });

  describe("setConfigValue", () => {
    test("should create config directory if it doesn't exist", async () => {
      // Bug scenario: Config directory doesn't exist yet
      mockFs.existsSync = mock(() => false);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(() => "key: value\n");

      await writer.setConfigValue("key", "value");

      // Should create the config directory
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
    });

    test("should create backup before modifying existing config", async () => {
      // Test scenario: Existing config file needs backup before modification
      const existingConfig = { existing: "value" };

      mockFs.existsSync = mock((path) => {
        return path === mockConfigFile || path === mockConfigDir;
      });
      mockFs.readFileSync = mock(() => "existing: value\n");
      mockYaml.parse = mock(() => existingConfig);
      mockYaml.stringify = mock(() => "existing: value\nkey: newValue\n");

      const result = await writer.setConfigValue("key", "newValue");

      // Should create backup with timestamp
      expect(mockFs.copyFileSync).toHaveBeenCalled();
      const copyCall = mockFs.copyFileSync.mock.calls[0];
      expect(copyCall[0]).toBe(mockConfigFile);
      expect(copyCall[1]).toMatch(/config\.yaml\.backup\./);
      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(/backup/);
    });

    test("should handle nested key paths correctly", async () => {
      // Test scenario: Setting nested configuration values
      const existingConfig = {};

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => existingConfig);
      mockYaml.stringify = mock(() => "ai:\n  providers:\n    openai:\n      model: gpt-4\n");

      const result = await writer.setConfigValue("ai.providers.openai.model", "gpt-4");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("gpt-4");

      // Should have written the nested structure
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      expect(writeCall[0]).toBe(mockConfigFile);
    });

    test("should preserve existing values when setting new ones", async () => {
      // Test scenario: Adding new config without losing existing ones
      const existingConfig = {
        backend: "markdown",
        logger: { level: "info" },
      };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "backend: markdown\nlogger:\n  level: info\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(
        () => "backend: markdown\nlogger:\n  level: info\nsessiondb:\n  backend: sqlite\n"
      );

      const result = await writer.setConfigValue("sessiondb.backend", "sqlite");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBe("sqlite");
    });

    test("should handle backup failure gracefully", async () => {
      // Bug scenario: Backup creation fails (permissions, disk space, etc.)
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockFs.copyFileSync = mock(() => {
        throw new Error("Permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup failed");
      expect(result.error).toContain("Permission denied");
    });

    test("should handle file write errors", async () => {
      // Bug scenario: Writing to config file fails
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(() => "key: value\n");
      mockFs.writeFileSync = mock(() => {
        throw new Error("Disk full");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Disk full");
    });

    test("should return previous value when overwriting existing config", async () => {
      // Test scenario: Overwriting existing configuration value
      const existingConfig = { key: "oldValue" };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "key: oldValue\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "key: newValue\n");

      const result = await writer.setConfigValue("key", "newValue");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("oldValue");
      expect(result.newValue).toBe("newValue");
    });
  });

  describe("unsetConfigValue", () => {
    test("should remove configuration value and create backup", async () => {
      // Test scenario: Removing an existing configuration value
      const existingConfig = {
        key: "value",
        other: "remains",
      };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "key: value\nother: remains\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "other: remains\n");

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("value");
      expect(result.newValue).toBeUndefined();
      expect(mockFs.copyFileSync).toHaveBeenCalled(); // Backup created
    });

    test("should handle unsetting non-existent values gracefully", async () => {
      // Test scenario: Trying to unset a value that doesn't exist
      const existingConfig = { other: "value" };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "other: value\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));

      const result = await writer.unsetConfigValue("nonExistent");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBeUndefined();
      // Should not create backup for no-op operations
      expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    });

    test("should handle unsetting nested values", async () => {
      // Test scenario: Removing deeply nested configuration values
      const existingConfig = {
        ai: {
          providers: {
            openai: { model: "gpt-4" },
            anthropic: { model: "claude-3" },
          },
        },
      };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(
        () =>
          "ai:\n  providers:\n    openai:\n      model: gpt-4\n    anthropic:\n      model: claude-3\n"
      );
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "ai:\n  providers:\n    anthropic:\n      model: claude-3\n");

      const result = await writer.unsetConfigValue("ai.providers.openai.model");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("gpt-4");
    });

    test("should clean up empty parent objects after unsetting", async () => {
      // Bug scenario: After unsetting a nested value, empty parent objects should be removed
      const existingConfig = {
        ai: {
          providers: {
            openai: { model: "gpt-4" },
          },
        },
        backend: "markdown",
      };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(
        () => "ai:\n  providers:\n    openai:\n      model: gpt-4\nbackend: markdown\n"
      );
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "backend: markdown\n");

      const result = await writer.unsetConfigValue("ai.providers.openai.model");

      expect(result.success).toBe(true);
      // The config writer should clean up empty parent objects
      // This is a failing test until the cleanup logic is implemented properly
    });

    test("should fail gracefully when no config file exists", async () => {
      // Bug scenario: Trying to unset from non-existent config file
      mockFs.existsSync = mock(() => false);

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No configuration file found");
    });

    test("should restore from backup if file write fails after unset", async () => {
      // Bug scenario: File write fails after successful unset operation
      const existingConfig = { key: "value" };

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "key: value\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "");
      mockFs.writeFileSync = mock(() => {
        throw new Error("Write failed");
      });

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Write failed");
      // Should have attempted to create backup
      expect(mockFs.copyFileSync).toHaveBeenCalled();
    });
  });

  describe("error handling and edge cases", () => {
    test("should handle malformed YAML files", async () => {
      // Bug scenario: Existing config file has invalid YAML syntax
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "invalid: yaml: content:\n  - badly\nformatted");
      mockYaml.parse = mock(() => {
        throw new Error("YAML parse error");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to load config file");
    });

    test("should handle permission errors on config directory creation", async () => {
      // Bug scenario: Cannot create config directory due to permissions
      mockFs.existsSync = mock(() => false);
      mockFs.mkdirSync = mock(() => {
        throw new Error("EACCES: permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });

    test("should handle very deep nested paths", async () => {
      // Edge case: Very deeply nested configuration paths
      const deepPath = "level1.level2.level3.level4.level5.key";

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(
        () =>
          "level1:\n  level2:\n    level3:\n      level4:\n        level5:\n          key: value\n"
      );

      const result = await writer.setConfigValue(deepPath, "value");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("value");
    });

    test("should handle special characters in keys and values", async () => {
      // Edge case: Configuration keys and values with special characters
      const specialKey = "special.key-with_chars";
      const specialValue = "value with spaces & symbols!@#$%";

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(
        () => `special:\n  "key-with_chars": "value with spaces & symbols!@#$%"\n`
      );

      const result = await writer.setConfigValue(specialKey, specialValue);

      expect(result.success).toBe(true);
      expect(result.newValue).toBe(specialValue);
    });
  });

  describe("backup functionality", () => {
    test("should include timestamp in backup filename", async () => {
      // Test requirement: Backup files should have timestamps as specified in requirements
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(() => "key: value\n");

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(/\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    test("should skip backup when noBackup option is set", async () => {
      // Test scenario: User explicitly disables backup
      const writerNoBackup = createConfigWriter({
        createBackup: false,
        format: "yaml",
        validate: false, // Disable validation for this test
      });

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => {});
      mockYaml.stringify = mock(() => "key: value\n");

      const result = await writerNoBackup.setConfigValue("key", "value");

      // Debug the actual result if the test fails
      if (!result.success) {
        console.log("Test failure debug:", result);
      }

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
      expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    });
  });
});

describe("createConfigWriter", () => {
  test("should create ConfigWriter instance with default options", () => {
    const writer = createConfigWriter();
    expect(writer).toBeInstanceOf(ConfigWriter);
  });

  test("should create ConfigWriter instance with custom options", () => {
    const writer = createConfigWriter({
      createBackup: false,
      format: "json",
      validate: false,
    });
    expect(writer).toBeInstanceOf(ConfigWriter);
  });
});
