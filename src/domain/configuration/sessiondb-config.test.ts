/**
 * SessionDB Configuration Loading Tests
 *
 * Tests configuration loading and merging from our YAML-based configuration system:
 * - CLI arguments
 * - Environment variables  
 * - Default values
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

import { ConfigurationLoader } from "../config-loader";
import { SessionDbConfig } from "../types";

describe("SessionDB Configuration Loading", () => {
  let testDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessiondb-config-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });

    // Save original environment
    originalEnv = {
      MINSKY_SESSIONDB_BACKEND: process.env.MINSKY_SESSIONDB_BACKEND,
      MINSKY_SESSIONDB_SQLITE_PATH: process.env.MINSKY_SESSIONDB_SQLITE_PATH,
      MINSKY_SESSIONDB_BASE_DIR: process.env.MINSKY_SESSIONDB_BASE_DIR,
      MINSKY_SESSIONDB_POSTGRES_URL: process.env.MINSKY_SESSIONDB_POSTGRES_URL,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
  });

  afterEach(() => {
    // Restore original environment
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Default Configuration", () => {
    test("should provide sensible defaults", async () => {
      // Set up minimal test environment
      process.env.HOME = testDir;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_STATE_HOME;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Environment Variable Configuration", () => {
    test("should load from environment variables", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
      process.env.MINSKY_SESSIONDB_SQLITE_PATH = "/custom/path/sessions.db";
      process.env.MINSKY_SESSIONDB_BASE_DIR = "/custom/base";
      process.env.MINSKY_SESSIONDB_POSTGRES_URL = "postgresql://test:test@localhost/test";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/path/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://test:test@localhost/test"
      );
    });

    test("should handle invalid environment backend gracefully", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "invalid-backend";

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should fall back to default
      expect(config.resolved.sessiondb.backend).toBe("json");
    });
  });

  describe("Configuration Precedence", () => {
    test("should respect configuration overrides over environment variables", async () => {
      // Set up environment
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "json";
      process.env.MINSKY_SESSIONDB_BASE_DIR = "/env/base";

      const loader = new ConfigurationLoader();

      // Test with configuration override
      const cliArgs = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/cli/sessions.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, cliArgs);

      // Configuration overrides should win for explicitly provided values
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/sessions.db");

      // Environment should provide values not in configuration overrides
      expect(config.resolved.sessiondb.baseDir).toBe("/env/base");
    });

    test("should handle missing config gracefully", async () => {
      process.env.HOME = testDir;

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      // Should fall back to defaults without error
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Merging", () => {
    test("should merge partial sessiondb configurations correctly", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";

      const loader = new ConfigurationLoader();
      const cliArgs = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/cli/path.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, cliArgs);

      // Should combine environment backend with configuration override path
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/path.db");
    });
  });

  describe("Basic Validation", () => {
    test("should load valid configurations without throwing", async () => {
      process.env.HOME = testDir;
      process.env.MINSKY_SESSIONDB_BACKEND = "json";
      process.env.MINSKY_SESSIONDB_BASE_DIR = "/valid/path";

      const loader = new ConfigurationLoader();
      
      // Should not throw
      const config = await loader.loadConfiguration(testDir);
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBe("/valid/path");
    });
  });
});
