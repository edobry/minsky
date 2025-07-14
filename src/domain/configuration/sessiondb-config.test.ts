/**
 * SessionDB Configuration Loading Tests
 *
 * Tests NodeConfigAdapter's ability to load configuration from node-config
 * and transform it to the expected interface structure.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

import { NodeConfigAdapter } from "./node-config-adapter";

describe("SessionDB Configuration Loading", () => {
  let testDir: string;
  let configAdapter: NodeConfigAdapter;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessiondb-config-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
    configAdapter = new NodeConfigAdapter();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Default Configuration", () => {
    test("should provide sensible defaults", async () => {
      const config = await configAdapter.loadConfiguration(testDir);

      expect(config.resolved.sessiondb.backend).toBe("json");
      expect(config.resolved.sessiondb.baseDir).toBeNull();
      expect(config.resolved.sessiondb.dbPath).toBeNull();
      expect(config.resolved.sessiondb.connectionString).toBeNull();
    });
  });

  describe("Configuration Structure", () => {
    test("should return proper configuration structure", async () => {
      const config = await configAdapter.loadConfiguration(testDir);

      // Verify resolved config structure
      expect(config.resolved).toBeDefined();
      expect(config.resolved.backend).toBeDefined();
      expect(config.resolved.sessiondb).toBeDefined();
      expect(config.resolved.sessiondb.backend).toBeDefined();

      // Verify sources structure
      expect(config.sources).toBeDefined();
      expect(config.sources.configOverrides).toBeDefined();
      expect(config.sources.environment).toBeDefined();
      expect(config.sources.globalUser).toBeNull();
      expect(config.sources.repository).toBeNull();
      expect(config.sources.defaults).toBeDefined();
    });
  });

  describe("SessionDB Configuration", () => {
    test("should have proper sessiondb configuration fields", async () => {
      const config = await configAdapter.loadConfiguration(testDir);

      // Test that sessiondb has the expected fields
      expect(config.resolved.sessiondb).toHaveProperty("backend");
      expect(config.resolved.sessiondb).toHaveProperty("baseDir");
      expect(config.resolved.sessiondb).toHaveProperty("dbPath");
      expect(config.resolved.sessiondb).toHaveProperty("connectionString");

      // Test that backend is one of the expected values
      expect(["json", "sqlite", "postgres"]).toContain(config.resolved.sessiondb.backend);
    });
  });

  describe("Configuration Validation", () => {
    test("should validate repository config", () => {
      const result = configAdapter.validateRepositoryConfig({
        version: 1,
        sessiondb: {
          backend: "json",
          base_dir: "/test/path",
        },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate global user config", () => {
      const result = configAdapter.validateGlobalUserConfig({
        version: 1,
        sessiondb: {
          base_dir: "/test/path",
        },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
