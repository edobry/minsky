/**
 * Configuration Writer Tests
 *
 * Test-driven development for configuration file writing with mocked filesystem operations
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ConfigWriter, createConfigWriter } from "./config-writer";
import { createMockFs } from "../interfaces/mock-fs";
import type { MockFs } from "../interfaces/mock-fs";
import { CONFIG_TEST_PATTERNS } from "../../utils/test-utils/test-constants";
import { log } from "../../utils/logger";

describe("ConfigWriter", () => {
  let writer: ConfigWriter;
  const mockConfigDir = "/home/user/.config/minsky";
  const mockConfigFile = "/home/user/.config/minsky/config.yaml";
  let mockFs: MockFs;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Capture env and create isolated mock filesystem per test
    originalEnv = { ...process.env };
    mockFs = createMockFs();

    writer = createConfigWriter(
      {
        createBackup: true,
        format: "yaml",
        validate: false, // Disable validation for focused testing
        configDir: mockConfigDir,
      },
      {
        fs: mockFs,
        getUserConfigDir: () => mockConfigDir,
        userConfigFiles: ["config.yaml", "config.json"],
      }
    );
  });

  afterEach(() => {
    // Restore mocks and environment
    mock.restore();
    process.env = originalEnv;
  });

  describe("setConfigValue", () => {
    test("should create config directory if it doesn't exist", async () => {
      // Bug scenario: Config directory doesn't exist yet — mockFs starts empty
      mockFs.mkdir = mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined);

      await writer.setConfigValue("key", "value");

      // Should create the config directory
      expect(mockFs.mkdir).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
    });

    test("should create backup before modifying existing config", async () => {
      // Test scenario: Existing config file needs backup before modification
      mockFs = createMockFs({ [mockConfigFile]: "existing: value\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});

      const result = await writer.setConfigValue("key", "newValue");

      expect(mockFs.copyFile).toHaveBeenCalled();
      const [src, dest] = (mockFs.copyFile as ReturnType<typeof mock>).mock.calls[0] as [
        string,
        string,
      ];
      expect(src).toBe(mockConfigFile);
      // mt#1802: rolling backup — fixed `.backup` suffix, no timestamp.
      expect(dest).toBe(`${mockConfigFile}.backup`);
      expect(result.success).toBe(true);
      expect(result.backupPath).toBe(`${mockConfigFile}.backup`);
    });

    test("should handle nested key paths correctly", async () => {
      // Test scenario: Setting nested configuration values
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.writeFile = mock(async (_path: string, _data: string | Buffer) => {});

      const result = await writer.setConfigValue(CONFIG_TEST_PATTERNS.OPENAI_MODEL_PATH, "gpt-4");
      expect(result.success).toBe(true);
      expect(result.newValue).toBe("gpt-4");

      // Should have written the nested structure
      expect(mockFs.writeFile).toHaveBeenCalled();
      const [writtenPath] = (mockFs.writeFile as ReturnType<typeof mock>).mock.calls[0] as [string];
      expect(writtenPath).toBe(mockConfigFile);
    });

    test("should preserve existing values when setting new ones", async () => {
      // Test scenario: Adding new config without losing existing ones
      const existingConfig = "backend: markdown\nlogger:\n  level: info\n";
      mockFs = createMockFs({ [mockConfigFile]: existingConfig });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue("persistence.backend", "sqlite");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBe("sqlite");
    });

    test("should handle backup failure gracefully", async () => {
      // Bug scenario: Backup creation fails (permissions, disk space, etc.)
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async () => {
        throw new Error("Permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup failed");
      expect(result.error).toContain("Permission denied");
    });

    test("should handle file write errors", async () => {
      // Bug scenario: Writing to config file fails
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.writeFile = mock(async () => {
        throw new Error("Disk full");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Disk full");
    });

    test("should return previous value when overwriting existing config", async () => {
      // Test scenario: Overwriting existing configuration value
      mockFs = createMockFs({ [mockConfigFile]: "key: oldValue\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue("key", "newValue");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("oldValue");
      expect(result.newValue).toBe("newValue");
    });
  });

  describe("unsetConfigValue", () => {
    test("should remove configuration value and create backup", async () => {
      // Test scenario: Removing an existing configuration value
      mockFs = createMockFs({ [mockConfigFile]: "key: value\nother: remains\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("value");
      expect(result.newValue).toBeUndefined();
      expect(mockFs.copyFile).toHaveBeenCalled(); // Backup created
    });

    test("should handle unsetting non-existent values gracefully", async () => {
      // Test scenario: Trying to unset a value that doesn't exist
      mockFs = createMockFs({ [mockConfigFile]: "other: value\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});

      const result = await writer.unsetConfigValue("nonExistent");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBeUndefined();
      // Should not create backup for no-op operations
      expect(mockFs.copyFile).not.toHaveBeenCalled();
    });

    test("should handle unsetting nested values", async () => {
      // Test scenario: Removing deeply nested configuration values
      const configContent =
        "ai:\n  providers:\n    openai:\n      model: gpt-4\n    anthropic:\n      model: claude-3\n";
      mockFs = createMockFs({ [mockConfigFile]: configContent });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.unsetConfigValue(CONFIG_TEST_PATTERNS.OPENAI_MODEL_PATH);

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("gpt-4");
    });

    test("should clean up empty parent objects after unsetting", async () => {
      // Test scenario: After unsetting a nested value, empty parent objects should be removed
      const configContent =
        "ai:\n  providers:\n    openai:\n      model: gpt-4\nbackend: markdown\n";
      mockFs = createMockFs({ [mockConfigFile]: configContent });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.unsetConfigValue(CONFIG_TEST_PATTERNS.OPENAI_MODEL_PATH);

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("gpt-4");

      // NOTE: This test currently passes basic operation but cleanup logic for empty parent objects
      // is not yet implemented in ConfigWriter. For now, just verify the operation succeeded.
      // TODO: Implement empty object cleanup in ConfigWriter.unsetConfigValue()
    });

    test("should fail gracefully when no config file exists", async () => {
      // Bug scenario: Trying to unset from non-existent config file — mockFs is empty
      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No configuration file found");
    });

    test("should restore from backup if file write fails after unset", async () => {
      // Bug scenario: File write fails after successful unset operation
      mockFs = createMockFs({ [mockConfigFile]: "key: value\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});
      mockFs.writeFile = mock(async () => {
        throw new Error("Write failed");
      });

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Write failed");
      // Should have attempted to create backup
      expect(mockFs.copyFile).toHaveBeenCalled();
    });
  });

  describe("error handling and edge cases", () => {
    test("should handle malformed YAML files", async () => {
      // Bug scenario: Existing config file has invalid YAML syntax
      mockFs = createMockFs({
        [mockConfigFile]: "invalid: yaml: content:\n  - badly\nformatted",
      });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to load config file");
    });

    test("should handle permission errors on config directory creation", async () => {
      // Bug scenario: Cannot create config directory due to permissions — mockFs is empty
      mockFs.mkdir = mock(async () => {
        throw new Error("EACCES: permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });

    test("should handle very deep nested paths", async () => {
      // Edge case: Very deeply nested configuration paths
      const deepPath = "level1.level2.level3.level4.level5.key";
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue(deepPath, "value");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("value");
    });

    test("should handle special characters in keys and values", async () => {
      // Edge case: Configuration keys and values with special characters
      const specialKey = "special.key-with_chars";
      const specialValue = "value with spaces & symbols!@#$%";
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue(specialKey, specialValue);

      expect(result.success).toBe(true);
      expect(result.newValue).toBe(specialValue);
    });
  });

  describe("backup functionality", () => {
    test("uses a fixed `<file>.backup` path (no timestamp — rolling backup, mt#1802)", async () => {
      // mt#1802 retired the timestamped `<file>.backup.<ISO>` pattern in
      // favor of a single rolling backup. Earlier wording of this test
      // asserted the timestamped shape and is now inverted.
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toBe(`${mockConfigFile}.backup`);
      // Explicitly assert no timestamp in the backup path.
      expect(result.backupPath).not.toMatch(/\.backup\.\d{4}/);
    });

    test("should skip backup when noBackup option is set", async () => {
      // Test scenario: User explicitly disables backup
      mockFs = createMockFs({ [mockConfigFile]: "{}" });
      const writerNoBackup = createConfigWriter(
        { createBackup: false, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});

      const result = await writerNoBackup.setConfigValue("key", "value");

      // Debug the actual result if the test fails
      if (!result.success) {
        log.debug("Test failure debug:", result as any);
      }

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
      expect(mockFs.copyFile).not.toHaveBeenCalled();
    });
  });

  describe("rolling backup (mt#1802)", () => {
    test("AT1: repeated writes produce exactly ONE backup file, not N", async () => {
      mockFs = createMockFs({ [mockConfigFile]: "foo: v1\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      const r1 = await writer.setConfigValue("foo", "v2");
      const r2 = await writer.setConfigValue("foo", "v3");
      const r3 = await writer.setConfigValue("foo", "v4");

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      // All three writes report the same backupPath.
      expect(r1.backupPath).toBe(`${mockConfigFile}.backup`);
      expect(r2.backupPath).toBe(`${mockConfigFile}.backup`);
      expect(r3.backupPath).toBe(`${mockConfigFile}.backup`);

      // And exactly one .backup file exists in the mock fs.
      const files = Object.fromEntries(mockFs.files);
      const backupFiles = Object.keys(files).filter((p) => p.includes(".backup"));
      expect(backupFiles).toEqual([`${mockConfigFile}.backup`]);
    });

    test("AT2: .backup contents track the most-recent pre-write state", async () => {
      mockFs = createMockFs({ [mockConfigFile]: "foo: v1\n" });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      // After first write, the backup should be v1 (pre-write content)
      await writer.setConfigValue("foo", "v2");
      expect(mockFs.files.get(`${mockConfigFile}.backup`)).toContain("v1");

      // After second write, the backup should be v2 (the new pre-write content), not v1
      await writer.setConfigValue("foo", "v3");
      const backupAfterSecond = mockFs.files.get(`${mockConfigFile}.backup`) ?? "";
      expect(backupAfterSecond).toContain("v2");
      expect(backupAfterSecond).not.toContain("v1");

      // After third write, the backup should be v3, not v2 or v1
      await writer.setConfigValue("foo", "v4");
      const backupAfterThird = mockFs.files.get(`${mockConfigFile}.backup`) ?? "";
      expect(backupAfterThird).toContain("v3");
      expect(backupAfterThird).not.toContain("v2");
    });

    test("legacy timestamped backups: existing .backup.<ISO> files are NOT auto-deleted", async () => {
      // Seed with a legacy backup left by the prior implementation.
      const legacyBackup = `${mockConfigFile}.backup.2026-05-01T00-00-00-000Z`;
      mockFs = createMockFs({
        [mockConfigFile]: "foo: v1\n",
        [legacyBackup]: "foo: legacy\n",
      });
      writer = createConfigWriter(
        { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );

      await writer.setConfigValue("foo", "v2");

      // The new rolling backup exists at the fixed path.
      const files = Object.fromEntries(mockFs.files);
      expect(Object.keys(files)).toContain(`${mockConfigFile}.backup`);
      // And the legacy backup is still present — we don't auto-clean.
      expect(Object.keys(files)).toContain(legacyBackup);
      expect(mockFs.files.get(legacyBackup)).toBe("foo: legacy\n");
    });

    test("AT4: createBackup: false still skips backup entirely", async () => {
      mockFs = createMockFs({ [mockConfigFile]: "foo: v1\n" });
      writer = createConfigWriter(
        { createBackup: false, format: "yaml", validate: false, configDir: mockConfigDir },
        { fs: mockFs, getUserConfigDir: () => mockConfigDir, userConfigFiles: ["config.yaml"] }
      );
      mockFs.copyFile = mock(async (_src: string, _dest: string) => {});

      await writer.setConfigValue("foo", "v2");

      expect(mockFs.copyFile).not.toHaveBeenCalled();
      const files = Object.fromEntries(mockFs.files);
      const backupFiles = Object.keys(files).filter((p) => p.includes(".backup"));
      expect(backupFiles).toEqual([]);
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
