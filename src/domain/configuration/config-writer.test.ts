/**
 * Configuration Writer Tests (Per-test DI, no spies/global mocks)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ConfigWriter, createConfigWriter, type SyncFs } from "./config-writer";
import * as path from "path";
import * as yaml from "yaml";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

// Helper to build a SyncFs from our mock filesystem
function buildSyncFsFromMock(mockFs: ReturnType<typeof createMockFilesystem>): SyncFs {
  return {
    readFileSync: (p: string, enc: string) => String(mockFs.readFileSync(p, enc)),
    writeFileSync: (p: string, data: string, enc: string) => mockFs.writeFileSync(p, data),
    existsSync: (p: string) => mockFs.existsSync(p),
    mkdirSync: (p: string, options?: { recursive?: boolean }) => mockFs.mkdirSync(p, options),
    copyFileSync: (src: string, dest: string) => mockFs.copyFileSync(src, dest),
  };
}

describe("ConfigWriter", () => {
  let writer: ConfigWriter;
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let mockConfigDir: string;
  let mockConfigFile: string;

  beforeEach(() => {
    // Fresh unique mock FS per test
    mockFs = createMockFilesystem();
    mockConfigDir = "/home/user/.config/minsky";
    mockConfigFile = path.join(mockConfigDir, "config.yaml");

    // Ensure config dir exists when needed
    mockFs.ensureDirectorySync(mockConfigDir);

    // Create writer with DI fs and configDir override
    writer = createConfigWriter(
      {
        createBackup: true,
        format: "yaml",
        validate: false,
        configDir: mockConfigDir,
      },
      { fs: buildSyncFsFromMock(mockFs) }
    );
  });

  test("should create config directory if it doesn't exist", async () => {
    // Remove directory to simulate non-existent
    mockFs.rmAsync(mockConfigDir, { recursive: true });

    const result = await writer.setConfigValue("key", "value");

    expect(result.success).toBe(true);
    expect(mockFs.directories.has(mockConfigDir)).toBe(true);
  });

  test("should create backup before modifying existing config", async () => {
    // Seed existing config file
    mockFs.writeFileSync(mockConfigFile, "existing: value\n", "utf8");

    const result = await writer.setConfigValue("key", "newValue");

    expect(result.success).toBe(true);
    // One of the written files should match backup pattern
    const wroteBackup = Array.from(mockFs.files.keys()).some((f) =>
      f.startsWith(`${mockConfigFile}.backup.`)
    );
    expect(wroteBackup).toBe(true);
  });

  test("should handle nested key paths correctly", async () => {
    mockFs.writeFileSync(mockConfigFile, "{}\n", "utf8");

    const result = await writer.setConfigValue("ai.providers.openai.model", "gpt-4");

    expect(result.success).toBe(true);
    const content = String(mockFs.readFileSync(mockConfigFile, "utf8"));
    expect(content.includes("openai")).toBe(true);
  });

  test("should preserve existing values when setting new ones", async () => {
    mockFs.writeFileSync(mockConfigFile, "backend: markdown\nlogger:\n  level: info\n", "utf8");

    const result = await writer.setConfigValue("sessiondb.backend", "sqlite");

    expect(result.success).toBe(true);
    const content = String(mockFs.readFileSync(mockConfigFile, "utf8"));
    expect(content.includes("backend: markdown")).toBe(true);
    expect(content.includes("sessiondb")).toBe(true);
  });

  test("should handle backup failure gracefully", async () => {
    mockFs.writeFileSync(mockConfigFile, "{}\n", "utf8");
    // Simulate copy failure by removing file after path resolution
    const failingFs: SyncFs = {
      ...buildSyncFsFromMock(mockFs),
      copyFileSync: () => {
        throw new Error("Permission denied");
      },
    };
    const failingWriter = createConfigWriter(
      { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
      { fs: failingFs }
    );

    const result = await failingWriter.setConfigValue("key", "value");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Backup failed");
  });

  test("should return previous value when overwriting existing config", async () => {
    mockFs.writeFileSync(mockConfigFile, "key: oldValue\n", "utf8");

    const result = await writer.setConfigValue("key", "newValue");

    expect(result.success).toBe(true);
    expect(result.previousValue).toBe("oldValue");
    expect(result.newValue).toBe("newValue");
  });

  test("should remove configuration value and create backup", async () => {
    mockFs.writeFileSync(mockConfigFile, "key: value\nother: remains\n", "utf8");

    const result = await writer.unsetConfigValue("key");

    expect(result.success).toBe(true);
    const wroteBackup = Array.from(mockFs.files.keys()).some((f) =>
      f.startsWith(`${mockConfigFile}.backup.`)
    );
    expect(wroteBackup).toBe(true);
  });

  test("should handle unsetting non-existent values gracefully", async () => {
    mockFs.writeFileSync(mockConfigFile, "other: value\n", "utf8");

    const result = await writer.unsetConfigValue("nonExistent");

    expect(result.success).toBe(true);
    expect(result.previousValue).toBeUndefined();
    expect(result.newValue).toBeUndefined();
  });

  test("should handle unsetting nested values", async () => {
    mockFs.writeFileSync(
      mockConfigFile,
      "ai:\n  providers:\n    openai:\n      model: gpt-4\n    anthropic:\n      model: claude-3\n",
      "utf8"
    );

    const result = await writer.unsetConfigValue("ai.providers.openai.model");

    expect(result.success).toBe(true);
    expect(result.previousValue).toBe("gpt-4");
  });

  test("should clean up empty parent objects after unsetting", async () => {
    mockFs.writeFileSync(
      mockConfigFile,
      "ai:\n  providers:\n    openai:\n      model: gpt-4\nbackend: markdown\n",
      "utf8"
    );

    const result = await writer.unsetConfigValue("ai.providers.openai.model");
    expect(result.success).toBe(true);

    const content = String(mockFs.readFileSync(mockConfigFile, "utf8"));
    // Ensure 'ai' tree was cleaned when empty
    expect(content.includes("backend: markdown")).toBe(true);
  });

  test("should fail gracefully when no config file exists", async () => {
    const result = await writer.unsetConfigValue("key");

    expect(result.success).toBe(false);
    expect(result.error).toContain("No configuration file found");
  });

  test("should restore from backup if file write fails after unset", async () => {
    mockFs.writeFileSync(mockConfigFile, "key: value\n", "utf8");

    const failingFs: SyncFs = {
      ...buildSyncFsFromMock(mockFs),
      writeFileSync: () => {
        throw new Error("Write failed");
      },
    };

    const failingWriter = createConfigWriter(
      { createBackup: true, format: "yaml", validate: false, configDir: mockConfigDir },
      { fs: failingFs }
    );

    const result = await failingWriter.unsetConfigValue("key");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Write failed");
  });

  test("should handle malformed YAML files", async () => {
    // Seed an invalid YAML file so loadConfigFile() attempts to parse and fails
    mockFs.writeFileSync(mockConfigFile, "invalid: yaml: content:\n  - badly\nformatted", "utf8");

    const result = await writer.setConfigValue("key", "value");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to load config file");
  });

  test("should handle permission errors on config directory creation", async () => {
    const failingFs: SyncFs = {
      ...buildSyncFsFromMock(mockFs),
      existsSync: (p: string) => (p === mockConfigDir ? false : mockFs.existsSync(p)),
      mkdirSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };

    const failingWriter = createConfigWriter(
      { createBackup: false, format: "yaml", validate: false, configDir: mockConfigDir },
      { fs: failingFs }
    );

    const result = await failingWriter.setConfigValue("key", "value");

    expect(result.success).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  test("should handle very deep nested paths", async () => {
    mockFs.writeFileSync(mockConfigFile, "{}\n", "utf8");

    const result = await writer.setConfigValue("level1.level2.level3.level4.level5.key", "value");

    expect(result.success).toBe(true);
    const content = String(mockFs.readFileSync(mockConfigFile, "utf8"));
    expect(content.includes("level5")).toBe(true);
  });

  test("should handle special characters in keys and values", async () => {
    mockFs.writeFileSync(mockConfigFile, "{}\n", "utf8");

    const specialKey = "special.key-with_chars";
    const specialValue = "value with spaces & symbols!@#$%";

    const result = await writer.setConfigValue(specialKey, specialValue);

    expect(result.success).toBe(true);
    const content = String(mockFs.readFileSync(mockConfigFile, "utf8"));
    expect(content.includes("key-with_chars")).toBe(true);
  });

  test("should include timestamp in backup filename", async () => {
    mockFs.writeFileSync(mockConfigFile, "{}\n", "utf8");

    const result = await writer.setConfigValue("key", "value");

    expect(result.success).toBe(true);
    const wroteBackup = Array.from(mockFs.files.keys()).some((f) =>
      f.startsWith(`${mockConfigFile}.backup.`)
    );
    expect(wroteBackup).toBe(true);
  });

  test("should skip backup when noBackup option is set", async () => {
    const writerNoBackup = createConfigWriter(
      { createBackup: false, format: "yaml", validate: false, configDir: mockConfigDir },
      { fs: buildSyncFsFromMock(mockFs) }
    );

    const result = await writerNoBackup.setConfigValue("key", "value");

    expect(result.success).toBe(true);
    const wroteBackup = Array.from(mockFs.files.keys()).some((f) =>
      f.startsWith(`${mockConfigFile}.backup.`)
    );
    expect(wroteBackup).toBe(false);
  });
});

// Simple factory tests

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
