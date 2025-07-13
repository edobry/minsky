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

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessiondb-config-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Default Configuration", () => {
    test("should provide sensible defaults", async () => {
      // Set up minimal test environment with mock environment variables
      const mockEnv = {
        HOME: testDir,
        // XDG_CONFIG_HOME and XDG_STATE_HOME are not set (undefined)
      };

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir, {}, mockEnv);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Environment Variable Configuration", () => {
    test("should load from environment variables", async () => {
      const mockEnv = {
        HOME: testDir,
        MINSKY_SESSIONDB_BACKEND: "sqlite",
        MINSKY_SESSIONDB_SQLITE_PATH: "/custom/path/sessions.db",
        MINSKY_SESSIONDB_BASE_DIR: "/custom/base",
        MINSKY_SESSIONDB_POSTGRES_URL: "postgresql://test:test@localhost/test",
      };

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir, {}, mockEnv);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/path/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://test:test@localhost/test"
      );
    });

    test("should handle invalid environment backend gracefully", async () => {
      const mockEnv = {
        HOME: testDir,
        MINSKY_SESSIONDB_BACKEND: "invalid-backend",
      };

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir, {}, mockEnv);

      // Should fall back to default
      expect(config.resolved.sessiondb.backend).toBe("json");
    });
  });

  describe("Configuration Precedence", () => {
    test("should respect CLI arguments over environment variables", async () => {
      // Set up mock environment
      const mockEnv = {
        HOME: testDir,
        MINSKY_SESSIONDB_BACKEND: "json",
        MINSKY_SESSIONDB_BASE_DIR: "/env/base",
      };

      const loader = new ConfigurationLoader();

      // Test with CLI override
      const cliArgs = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/cli/sessions.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, cliArgs, mockEnv);

      // CLI should win for explicitly provided values
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/sessions.db");

      // Environment should provide values not in CLI
      expect(config.resolved.sessiondb.baseDir).toBe("/env/base");
    });

    test("should handle missing config gracefully", async () => {
      const mockEnv = {
        HOME: testDir,
      };

      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir, {}, mockEnv);

      // Should fall back to defaults without error
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Merging", () => {
    test("should merge partial sessiondb configurations correctly", async () => {
      const mockEnv = {
        HOME: testDir,
        MINSKY_SESSIONDB_BACKEND: "sqlite",
      };

      const loader = new ConfigurationLoader();
      const cliArgs = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/cli/path.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, cliArgs, mockEnv);

      // Should combine environment backend with CLI path
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/path.db");
    });
  });

  describe("Basic Validation", () => {
    test("should load valid configurations without throwing", async () => {
      const mockEnv = {
        HOME: testDir,
        MINSKY_SESSIONDB_BACKEND: "json",
        MINSKY_SESSIONDB_BASE_DIR: "/valid/path",
      };

      const loader = new ConfigurationLoader();
      
      // Should not throw
      const config = await loader.loadConfiguration(testDir, {}, mockEnv);
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBe("/valid/path");
    });
  });
});
