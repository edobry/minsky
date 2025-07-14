/**
 * SessionDB Configuration Loading Tests
 *
 * Tests node-config's ability to load configuration directly
 * using idiomatic config.get() calls instead of the NodeConfigAdapter anti-pattern.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import config from "config";

import { 
  validateRepositoryConfig, 
  validateGlobalUserConfig, 
  SessionDbConfigSchema,
  type SessionDbConfig,
  type RepositoryConfig,
  type GlobalUserConfig
} from "./config-schemas";

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
    test("should provide sensible defaults", () => {
      // Use config.get() directly for idiomatic node-config usage
      const sessiondbConfig = config.get<SessionDbConfig>("sessiondb");

      expect(sessiondbConfig.backend).toBe("json");
      expect(sessiondbConfig.baseDir).toBeNull();
      expect(sessiondbConfig.dbPath).toBeNull();
      expect(sessiondbConfig.connectionString).toBeNull();
    });
  });

  describe("Configuration Structure", () => {
    test("should return proper configuration structure", () => {
      // Use config.get() directly for idiomatic node-config usage
      const backend = config.get<string>("backend");
      const sessiondbConfig = config.get<SessionDbConfig>("sessiondb");

      // Verify configuration structure
      expect(backend).toBeDefined();
      expect(sessiondbConfig).toBeDefined();
      expect(sessiondbConfig.backend).toBeDefined();
      
      // Verify sessiondb configuration with Zod validation
      const validationResult = SessionDbConfigSchema.safeParse(sessiondbConfig);
      expect(validationResult.success).toBe(true);
    });
  });

  describe("SessionDB Configuration", () => {
    test("should have proper sessiondb configuration fields", () => {
      // Use config.get() directly for idiomatic node-config usage
      const sessiondbConfig = config.get<SessionDbConfig>("sessiondb");

      // Test that sessiondb has the expected fields
      expect(sessiondbConfig).toHaveProperty("backend");
      expect(sessiondbConfig).toHaveProperty("baseDir");
      expect(sessiondbConfig).toHaveProperty("dbPath");
      expect(sessiondbConfig).toHaveProperty("connectionString");

      // Test that backend is one of the expected values
      expect(["json", "sqlite", "postgres"]).toContain(sessiondbConfig.backend);
    });

    test("should validate sessiondb configuration with Zod", () => {
      // Use config.get() directly for idiomatic node-config usage
      const sessiondbConfig = config.get<SessionDbConfig>("sessiondb");

      // Validate using Zod schema
      const result = SessionDbConfigSchema.safeParse(sessiondbConfig);
      expect(result.success).toBe(true);
      
      if (result.success) {
        expect(result.data.backend).toBe("json");
        expect(result.data.baseDir).toBeNull();
        expect(result.data.dbPath).toBeNull();
        expect(result.data.connectionString).toBeNull();
      }
    });
  });

  describe("Configuration Validation", () => {
    test("should validate repository config", () => {
      const testRepositoryConfig: RepositoryConfig = {
        version: 1,
        sessiondb: {
          backend: "json",
          base_dir: "/test/path",
        },
      };

      const result = validateRepositoryConfig(testRepositoryConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate global user config", () => {
      const testGlobalUserConfig: GlobalUserConfig = {
        version: 1,
        sessiondb: {
          base_dir: "/test/path",
        },
      };

      const result = validateGlobalUserConfig(testGlobalUserConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should handle invalid repository config", () => {
      const invalidConfig = {
        version: 1,
        sessiondb: {
          backend: "invalid-backend", // Invalid backend type
        },
      };

      const result = validateRepositoryConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("should handle invalid global user config", () => {
      const invalidConfig = {
        version: "not-a-number", // Invalid version type
        sessiondb: {
          base_dir: "/test/path",
        },
      };

      const result = validateGlobalUserConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Direct Config Access", () => {
    test("should access configuration values directly", () => {
      // Test direct config.get() usage - idiomatic node-config pattern
      expect(config.has("backend")).toBe(true);
      expect(config.has("sessiondb")).toBe(true);
      expect(config.has("sessiondb.backend")).toBe(true);

      // Test getting specific values
      const backend = config.get<string>("backend");
      const sessiondbBackend = config.get<string>("sessiondb.backend");

      expect(backend).toBe("markdown");
      expect(sessiondbBackend).toBe("json");
    });

    test("should handle missing configuration values", () => {
      // Test behavior with missing values
      expect(config.has("nonexistent")).toBe(false);
      expect(config.has("sessiondb.nonexistent")).toBe(false);

      // Test default values using proper node-config pattern
      const nonExistent = config.has("nonexistent") ? config.get<string>("nonexistent") : "default-value";
      expect(nonExistent).toBe("default-value");
    });
  });
});
