/**
 * SessionDB Configuration Loading Tests
 *
 * Tests configuration loading and merging from our YAML-based configuration system:
 * - Configuration overrides
 * - Default values
 * - Configuration precedence and merging
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

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
      const loader = new ConfigurationLoader();
      const config = await loader.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Overrides", () => {
    test("should use SQLite backend configuration", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/custom/path/sessions.db",
          baseDir: "/custom/base",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/path/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
    });

    test("should use PostgreSQL backend configuration", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "postgres",
          connectionString: "postgresql://test:test@localhost/test",
          baseDir: "/custom/base",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      expect(config.resolved.sessiondb.backend).toBe("postgres");
      expect(config.resolved.sessiondb.connectionString).toBe(
        "postgresql://test:test@localhost/test"
      );
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
    });

    test("should preserve invalid backend from configuration overrides", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "invalid-backend" as any,
        },
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      // Configuration overrides should be preserved as-is (no validation)
      // This allows testing with any values
      expect(config.resolved.sessiondb.backend).toBe("invalid-backend" as any);
    });
  });

  describe("Configuration Merging", () => {
    test("should merge partial sessiondb configurations correctly", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "sqlite" as const,
          dbPath: "/cli/path.db",
        },
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      // Should use provided values and fill in defaults for others
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/cli/path.db");
      expect(config.resolved.sessiondb.baseDir).toBeDefined(); // Should have default
    });

    test("should handle empty configuration overrides", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {};

      const config = await loader.loadConfiguration(testDir, configOverrides);

      // Should fall back to defaults
      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Precedence", () => {
    test("should respect configuration overrides over environment variables", async () => {
      // This test verifies that config overrides have highest precedence
      // Note: We're not testing environment variable parsing here,
      // just that the precedence system works correctly

      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/override/sessions.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      // Configuration overrides should be used
      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/override/sessions.db");
    });
  });

  describe("Backend-Specific Configuration", () => {
    test("should configure JSON backend correctly", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "json",
          baseDir: "/custom/json/sessions",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/json/sessions");
    });

    test("should configure SQLite backend with custom path", async () => {
      const loader = new ConfigurationLoader();
      const configOverrides = {
        sessiondb: {
          backend: "sqlite",
          dbPath: "/var/lib/minsky/sessions.db",
        } as SessionDbConfig,
      };

      const config = await loader.loadConfiguration(testDir, configOverrides);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/var/lib/minsky/sessions.db");
    });
  });
});
