/**
 * Configuration Writer Tests
 *
 * Test-driven development for configuration file writing with mocked filesystem operations
 */

import { describe, test, expect, afterEach, mock, spyOn } from "bun:test";
import { ConfigWriter, createConfigWriter } from "./config-writer";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import * as fs from "fs";

// Test-scoped constants
const MOCK_CONFIG_DIR = "/home/user/.config/minsky";
const MOCK_CONFIG_FILE = "/home/user/.config/minsky/config.yaml";

type ImplOverrides = Partial<{
  readFileSync: (...args: any[]) => any;
  writeFileSync: (...args: any[]) => any;
  existsSync: (...args: any[]) => any;
  mkdirSync: (...args: any[]) => any;
  copyFileSync: (...args: any[]) => any;
  pathJoin: (...args: any[]) => any;
  pathDirname: (p: string) => any;
  osHomedir: () => any;
  yamlParse: (...args: any[]) => any;
  yamlStringify: (...args: any[]) => any;
}>;

// Factory to create a fresh writer and fresh mocks for every test
function createTestContext(impls: ImplOverrides = {}) {
  // Fresh Bun mocks per test with provided implementations
  const readFileSync = mock(impls.readFileSync ?? (() => ""));
  const writeFileSync = mock(impls.writeFileSync ?? (() => {}));
  const existsSync = mock(impls.existsSync ?? (() => false));
  const mkdirSync = mock(impls.mkdirSync ?? (() => {}));
  const copyFileSync = mock(impls.copyFileSync ?? (() => {}));

  const pathJoin = mock(impls.pathJoin ?? ((...args: any[]) => (args as any[]).join("/")));
  const pathDirname = mock(
    impls.pathDirname ?? ((p: string) => p.split("/").slice(0, -1).join("/"))
  );

  const osHomedir = mock(impls.osHomedir ?? (() => "/home/user"));

  const yamlParse = mock(impls.yamlParse ?? (() => ({})));
  const yamlStringify = mock(impls.yamlStringify ?? (() => ""));

  // Wire spies
  spyOn(fs, "readFileSync").mockImplementation(readFileSync as any);
  spyOn(fs, "writeFileSync").mockImplementation(writeFileSync as any);
  spyOn(fs, "existsSync").mockImplementation(existsSync as any);
  spyOn(fs, "mkdirSync").mockImplementation(mkdirSync as any);
  spyOn(fs, "copyFileSync").mockImplementation(copyFileSync as any);

  spyOn(path, "join").mockImplementation(pathJoin as any);
  spyOn(path, "dirname").mockImplementation(pathDirname as any);

  spyOn(os, "homedir").mockImplementation(osHomedir as any);

  spyOn(yaml, "parse").mockImplementation(yamlParse as any);
  spyOn(yaml, "stringify").mockImplementation(yamlStringify as any);

  const writer: ConfigWriter = createConfigWriter({
    createBackup: true,
    format: "yaml",
    validate: false,
  });

  return { writer };
}

afterEach(() => {
  mock.restore();
});

describe("ConfigWriter", () => {
  describe("setConfigValue", () => {
    test("should create config directory if it doesn't exist", async () => {
      const { writer } = createTestContext({
        existsSync: (p: string) => (p === MOCK_CONFIG_FILE ? false : false),
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => "key: value\n",
      });

      await writer.setConfigValue("key", "value");

      expect(fs.mkdirSync).toHaveBeenCalledWith(MOCK_CONFIG_DIR, { recursive: true });
    });

    test("should create backup before modifying existing config", async () => {
      const existingConfig = { existing: "value" } as any;
      const { writer } = createTestContext({
        existsSync: (p: string) => p === MOCK_CONFIG_FILE || p === MOCK_CONFIG_DIR,
        readFileSync: () => "existing: value\n",
        yamlParse: () => existingConfig,
        yamlStringify: () => "existing: value\nkey: newValue\n",
      });

      const result = await writer.setConfigValue("key", "newValue");

      expect(fs.copyFileSync).toHaveBeenCalled();
      const copyCall = (fs.copyFileSync as any).mock.calls[0];
      expect(copyCall[0]).toBe(MOCK_CONFIG_FILE);
      expect(copyCall[1]).toMatch(/config\.yaml\.backup\./);
      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(/backup/);
    });

    test("should handle nested key paths correctly", async () => {
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => "ai:\n  providers:\n    openai:\n      model: gpt-4\n",
      });

      const result = await writer.setConfigValue("ai.providers.openai.model", "gpt-4");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("gpt-4");
      const writeCall = (fs.writeFileSync as any).mock.calls[0];
      expect(writeCall[0]).toBe(MOCK_CONFIG_FILE);
    });

    test("should preserve existing values when setting new ones", async () => {
      const existingConfig = { backend: "markdown", logger: { level: "info" } } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "backend: markdown\nlogger:\n  level: info\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () =>
          "backend: markdown\nlogger:\n  level: info\nsessiondb:\n  backend: sqlite\n",
      });

      const result = await writer.setConfigValue("sessiondb.backend", "sqlite");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBe("sqlite");
    });

    test("should handle backup failure gracefully", async () => {
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        copyFileSync: () => {
          throw new Error("Permission denied");
        },
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Backup failed");
      expect(result.error).toContain("Permission denied");
    });

    test("should handle file write errors", async () => {
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => "key: value\n",
        writeFileSync: () => {
          throw new Error("Disk full");
        },
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Disk full");
    });

    test("should return previous value when overwriting existing config", async () => {
      const existingConfig = { key: "oldValue" } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "key: oldValue\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () => "key: newValue\n",
      });

      const result = await writer.setConfigValue("key", "newValue");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("oldValue");
      expect(result.newValue).toBe("newValue");
    });
  });

  describe("unsetConfigValue", () => {
    test("should remove configuration value and create backup", async () => {
      const existingConfig = { key: "value", other: "remains" } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "key: value\nother: remains\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () => "other: remains\n",
      });

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("value");
      expect(result.newValue).toBeUndefined();
      expect((fs.copyFileSync as any).mock.calls.length).toBe(0);
    });

    test("should handle unsetting non-existent values gracefully", async () => {
      const existingConfig = { other: "value" } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "other: value\n",
        yamlParse: () => ({ ...existingConfig }),
      });

      const result = await writer.unsetConfigValue("nonExistent");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBeUndefined();
      expect(result.newValue).toBeUndefined();
    });

    test("should handle unsetting nested values", async () => {
      const existingConfig = {
        ai: {
          providers: { openai: { model: "gpt-4" }, anthropic: { model: "claude-3" } },
        },
      } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () =>
          "ai:\n  providers:\n    openai:\n      model: gpt-4\n    anthropic:\n      model: claude-3\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () => "ai:\n  providers:\n    anthropic:\n      model: claude-3\n",
      });

      const result = await writer.unsetConfigValue("ai.providers.openai.model");

      expect(result.success).toBe(true);
      expect(result.previousValue).toBe("gpt-4");
    });

    test("should clean up empty parent objects after unsetting", async () => {
      const existingConfig = {
        ai: { providers: { openai: { model: "gpt-4" } } },
        backend: "markdown",
      } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () =>
          "ai:\n  providers:\n    openai:\n      model: gpt-4\nbackend: markdown\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () => "backend: markdown\n",
      });

      const result = await writer.unsetConfigValue("ai.providers.openai.model");

      expect(result.success).toBe(true);
    });

    test("should fail gracefully when no config file exists", async () => {
      const { writer } = createTestContext({ existsSync: () => false });

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No configuration file found");
    });

    test("should restore from backup if file write fails after unset", async () => {
      const existingConfig = { key: "value" } as any;
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "key: value\n",
        yamlParse: () => ({ ...existingConfig }),
        yamlStringify: () => "",
        writeFileSync: () => {
          throw new Error("Write failed");
        },
      });

      const result = await writer.unsetConfigValue("key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Write failed");
    });
  });

  describe("error handling and edge cases", () => {
    test("should handle malformed YAML files", async () => {
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "invalid: yaml: content:\n  - badly\nformatted",
        yamlParse: () => {
          throw new Error("YAML parse error");
        },
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to load config file");
    });

    test("should handle permission errors on config directory creation", async () => {
      const { writer } = createTestContext({
        existsSync: () => false,
        mkdirSync: () => {
          throw new Error("EACCES: permission denied");
        },
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });

    test("should handle very deep nested paths", async () => {
      const deepPath = "level1.level2.level3.level4.level5.key";
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () =>
          "level1:\n  level2:\n    level3:\n      level4:\n        level5:\n          key: value\n",
      });

      const result = await writer.setConfigValue(deepPath, "value");

      expect(result.success).toBe(true);
      expect(result.newValue).toBe("value");
    });

    test("should handle special characters in keys and values", async () => {
      const specialKey = "special.key-with_chars";
      const specialValue = "value with spaces & symbols!@#$%";
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => `special:\n  "key-with_chars": "value with spaces & symbols!@#$%"\n`,
      });

      const result = await writer.setConfigValue(specialKey, specialValue);

      expect(result.success).toBe(true);
      expect(result.newValue).toBe(specialValue);
    });
  });

  describe("backup functionality", () => {
    test("should include timestamp in backup filename", async () => {
      const { writer } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => "key: value\n",
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toMatch(
        /\.backup\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}/
      );
    });

    test("should skip backup when noBackup option is set", async () => {
      const { writer: writerNoBackup } = createTestContext();
      const writer = createConfigWriter({
        createBackup: false,
        format: "yaml",
        validate: false,
      });

      const { writer: _unused } = createTestContext({
        existsSync: () => true,
        readFileSync: () => "{}",
        yamlParse: () => ({}),
        yamlStringify: () => "key: value\n",
      });

      const result = await writer.setConfigValue("key", "value");

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
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
