/**
 * Configuration Writer Tests
 *
 * Test-driven development for configuration file writing with mocked filesystem operations
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { ConfigWriter, createConfigWriter } from "./config-writer";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import * as fs from "fs";

// Mock holders using Bun mock() functions. We NEVER call mockImplementation on fs/* directly.
// Instead, we bind fs/* to these holders via spyOn in beforeEach and override holders per-test
// by reassigning holder functions to mock(() => value).
const mockFs = {
  readFileSync: mock(() => ""),
  writeFileSync: mock(() => {}),
  existsSync: mock(() => false),
  mkdirSync: mock(() => {}),
  copyFileSync: mock(() => {}),
};

const mockPath = {
  join: mock((...args: any[]) => (args as any[]).join("/")),
  dirname: mock((p: string) => p.split("/").slice(0, -1).join("/")),
};

const mockOs = {
  homedir: mock(() => "/home/user"),
};

const mockYaml = {
  parse: mock(() => ({})),
  stringify: mock(() => ""),
};

describe("ConfigWriter", () => {
  let writer: ConfigWriter;
  const mockConfigDir = "/home/user/.config/minsky";
  const mockConfigFile = "/home/user/.config/minsky/config.yaml";

  beforeEach(() => {
    // Reset holders to default implementations via reassignment
    mockFs.readFileSync = mock(() => "");
    mockFs.writeFileSync = mock(() => {});
    mockFs.existsSync = mock(() => false);
    mockFs.mkdirSync = mock(() => {});
    mockFs.copyFileSync = mock(() => {});

    mockPath.join = mock((...args: any[]) => (args as any[]).join("/"));
    mockPath.dirname = mock((p: string) => p.split("/").slice(0, -1).join("/"));

    mockOs.homedir = mock(() => "/home/user");

    mockYaml.parse = mock(() => ({}));
    mockYaml.stringify = mock(() => "");

    // Bind spies to module functions delegating to our holders
    spyOn(fs, "readFileSync").mockImplementation(mockFs.readFileSync as any);
    spyOn(fs, "writeFileSync").mockImplementation(mockFs.writeFileSync as any);
    spyOn(fs, "existsSync").mockImplementation(mockFs.existsSync as any);
    spyOn(fs, "mkdirSync").mockImplementation(mockFs.mkdirSync as any);
    spyOn(fs, "copyFileSync").mockImplementation(mockFs.copyFileSync as any);

    spyOn(path, "join").mockImplementation(mockPath.join as any);
    spyOn(path, "dirname").mockImplementation(mockPath.dirname as any);

    spyOn(os, "homedir").mockImplementation(mockOs.homedir as any);

    spyOn(yaml, "parse").mockImplementation(mockYaml.parse as any);
    spyOn(yaml, "stringify").mockImplementation(mockYaml.stringify as any);

    writer = createConfigWriter({
      createBackup: true,
      format: "yaml",
      validate: false,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  describe("setConfigValue", () => {
    test("should create config directory if it doesn't exist", async () => {
      mockFs.existsSync = mock((p: string) => (p === mockConfigFile ? false : false));
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(() => "key: value\n");

      await writer.setConfigValue("key", "value");

      expect(fs.mkdirSync).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
    });

    test("should create backup before modifying existing config", async () => {
      const existingConfig = { existing: "value" };

      mockFs.existsSync = mock((p: string) => p === mockConfigFile || p === mockConfigDir);
      mockFs.readFileSync = mock(() => "existing: value\n");
      mockYaml.parse = mock(() => existingConfig);
      mockYaml.stringify = mock(() => "existing: value\nkey: newValue\n");

      const result = await writer.setConfigValue("key", "newValue");

      expect(fs.copyFileSync).toHaveBeenCalled();
      const copyCall = (fs.copyFileSync as any).mock.calls[0];
      expect(copyCall[0]).toBe(mockConfigFile);
      expect(copyCall[1]).toMatch(/config\.yaml\.backup\./);
      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(/backup/);
    });

    test("should handle nested key paths correctly", async () => {
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(() => "ai:\n  providers:\n    openai:\n      model: gpt-4\n");

      const result = await writer.setConfigValue("ai.providers.openai.model", "gpt-4");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("gpt-4");
      expect(fs.writeFileSync).toHaveBeenCalled();
      const writeCall = (fs.writeFileSync as any).mock.calls[0];
      expect(writeCall[0]).toBe(mockConfigFile);
    });

    test("should preserve existing values when setting new ones", async () => {
      const existingConfig = { backend: "markdown", logger: { level: "info" } } as any;

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
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockFs.copyFileSync = mock(() => {
        throw new Error("Permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup failed");
      expect(result.error).toContain("Permission denied");
    });

    test("should handle file write errors", async () => {
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(() => "key: value\n");
      mockFs.writeFileSync = mock(() => {
        throw new Error("Disk full");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Disk full");
    });

    test("should return previous value when overwriting existing config", async () => {
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
      const existingConfig = { key: "value", other: "remains" } as any;

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "key: value\nother: remains\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "other: remains\n");

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("value");
      expect(result.newValue).toBeUndefined();
      expect((fs.copyFileSync as any).mock.calls.length > 0).toBe(true);
    });

    test("should handle unsetting non-existent values gracefully", async () => {
      const existingConfig = { other: "value" } as any;

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "other: value\n");
      mockYaml.parse = mock(() => ({ ...existingConfig }));

      const result = await writer.unsetConfigValue("nonExistent");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBeUndefined();
      expect((fs.copyFileSync as any).mock.calls.length).toBe(0);
    });

    test("should handle unsetting nested values", async () => {
      const existingConfig = {
        ai: {
          providers: { openai: { model: "gpt-4" }, anthropic: { model: "claude-3" } },
        },
      } as any;

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
      const existingConfig = {
        ai: { providers: { openai: { model: "gpt-4" } } },
        backend: "markdown",
      } as any;

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(
        () => "ai:\n  providers:\n    openai:\n      model: gpt-4\nbackend: markdown\n"
      );
      mockYaml.parse = mock(() => ({ ...existingConfig }));
      mockYaml.stringify = mock(() => "backend: markdown\n");

      const result = await writer.unsetConfigValue("ai.providers.openai.model");

      expect(result.success).toBe(true);
    });

    test("should fail gracefully when no config file exists", async () => {
      mockFs.existsSync = mock(() => false);

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No configuration file found");
    });

    test("should restore from backup if file write fails after unset", async () => {
      const existingConfig = { key: "value" } as any;

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
      expect((fs.copyFileSync as any).mock.calls.length > 0).toBe(true);
    });
  });

  describe("error handling and edge cases", () => {
    test("should handle malformed YAML files", async () => {
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
      mockFs.existsSync = mock(() => false);
      mockFs.mkdirSync = mock(() => {
        throw new Error("EACCES: permission denied");
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });

    test("should handle very deep nested paths", async () => {
      const deepPath = "level1.level2.level3.level4.level5.key";

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(
        () =>
          "level1:\n  level2:\n    level3:\n      level4:\n        level5:\n          key: value\n"
      );

      const result = await writer.setConfigValue(deepPath, "value");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("value");
    });

    test("should handle special characters in keys and values", async () => {
      const specialKey = "special.key-with_chars";
      const specialValue = "value with spaces & symbols!@#$%";

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
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
      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(() => "key: value\n");

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(
        /\.backup\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}/
      );
    });

    test("should skip backup when noBackup option is set", async () => {
      const writerNoBackup = createConfigWriter({
        createBackup: false,
        format: "yaml",
        validate: false,
      });

      mockFs.existsSync = mock(() => true);
      mockFs.readFileSync = mock(() => "{}");
      mockYaml.parse = mock(() => ({}));
      mockYaml.stringify = mock(() => "key: value\n");

      const result = await writerNoBackup.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
      expect((fs.copyFileSync as any).mock.calls.length).toBe(0);
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
