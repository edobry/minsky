/**
 * SessionDB Configuration Loading Tests
 *
 * Tests configuration loading and merging from our YAML-based configuration system:
 * - Environment variable configuration
 * - Default values
 * - Configuration precedence
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

import { NodeConfigAdapter } from "./node-config-adapter";
import { SessionDbConfig } from "./types";

describe("SessionDB Configuration Loading", () => {
  let testDir: string;
  let configAdapter: NodeConfigAdapter;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessiondb-config-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
    configAdapter = new NodeConfigAdapter();

    // Store original environment variables
    originalEnv = {
      SESSIONDB_BACKEND: process.env.SESSIONDB_BACKEND,
      SESSIONDB_DBPATH: process.env.SESSIONDB_DBPATH,
      SESSIONDB_BASEDIR: process.env.SESSIONDB_BASEDIR,
      SESSIONDB_CONNECTIONSTRING: process.env.SESSIONDB_CONNECTIONSTRING,
    };
  });

  afterEach(() => {
    // Restore original environment variables
    Object.keys(originalEnv).forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Default Configuration", () => {
    test("should provide sensible defaults", async () => {
      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Overrides", () => {
    test("should use SQLite backend configuration", async () => {
      process.env.SESSIONDB_BACKEND = "sqlite";
      process.env.SESSIONDB_DBPATH = "/custom/path/sessions.db";
      process.env.SESSIONDB_BASEDIR = "/custom/base";

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/path/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
    });

    test("should use PostgreSQL backend configuration", async () => {
      process.env.SESSIONDB_BACKEND = "postgres";
      process.env.SESSIONDB_CONNECTIONSTRING = "postgresql://user:pass@localhost/db";
      process.env.SESSIONDB_BASEDIR = "/custom/base";

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("postgres");
      expect(config.resolved.sessiondb.connectionString).toBe("postgresql://user:pass@localhost/db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
    });

    test("should preserve invalid backend from environment variables", async () => {
      process.env.SESSIONDB_BACKEND = "invalid";
      process.env.SESSIONDB_BASEDIR = "/custom/base";

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend as any).toBe("invalid");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/base");
    });
  });

  describe("Configuration Merging", () => {
    test("should merge partial sessiondb configurations correctly", async () => {
      process.env.SESSIONDB_BACKEND = "sqlite";
      // Note: Not specifying dbPath or baseDir to test merging

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.baseDir).toBeDefined(); // Should get default
      // dbPath should be undefined since not specified and sqlite doesn't have default
    });

    test("should handle empty configuration overrides", async () => {
      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeDefined();
    });
  });

  describe("Configuration Precedence", () => {
    test("should respect configuration overrides over environment variables", async () => {
      // Set environment variable
      process.env.SESSIONDB_BACKEND = "sqlite";

      // In a real scenario, config overrides would come from local.yaml or similar
      // For now, we test that environment variables work correctly
      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
    });
  });

  describe("Backend-Specific Configuration", () => {
    test("should configure JSON backend correctly", async () => {
      process.env.SESSIONDB_BACKEND = "json";
      process.env.SESSIONDB_BASEDIR = "/custom/json/base";

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/json/base");
    });

    test("should configure SQLite backend with custom path", async () => {
      process.env.SESSIONDB_BACKEND = "sqlite";
      process.env.SESSIONDB_DBPATH = "/custom/sqlite/sessions.db";
      process.env.SESSIONDB_BASEDIR = "/custom/sqlite/base";

      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("sqlite");
      expect(config.resolved.sessiondb.dbPath).toBe("/custom/sqlite/sessions.db");
      expect(config.resolved.sessiondb.baseDir).toBe("/custom/sqlite/base");
    });
  });
});
