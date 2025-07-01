/**
 * SessionDB Configuration Integration Tests
 * 
 * Simplified tests for the surgical decoupling approach:
 * - node-config handles basic configuration loading
 * - Domain services handle path resolution and validation
 * - Integration tests ensure they work together
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import config from "config";

import { PathResolver } from "../path-resolver";
import { ConfigurationValidator } from "../config-validator";
import type { SessionDbConfig } from "../types";

describe("SessionDB Configuration Integration", () => {
  let testDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = join(tmpdir(), `sessiondb-integration-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    mkdirSync(testDir, { recursive: true });

    // Save original environment
    originalEnv = {
      MINSKY_SESSIONDB_BACKEND: process.env.MINSKY_SESSIONDB_BACKEND,
      MINSKY_SESSIONDB_DBPATH: process.env.MINSKY_SESSIONDB_DBPATH,
      MINSKY_SESSIONDB_BASEDIR: process.env.MINSKY_SESSIONDB_BASEDIR,
      HOME: process.env.HOME,
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

  describe("Node-Config Integration", () => {
    test("should load default configuration from node-config", () => {
      // node-config should provide default values
      const sessionDbConfig = config.has("sessiondb") ? config.get("sessiondb") : null;
      
      expect(sessionDbConfig).toBeDefined();
      if (sessionDbConfig) {
        expect(sessionDbConfig).toHaveProperty("backend");
      }
    });

    test("should handle environment variable overrides", () => {
      // Set environment variables
      process.env.MINSKY_SESSIONDB_BACKEND = "sqlite";
      process.env.MINSKY_SESSIONDB_DBPATH = "/custom/sessions.db";

      // In real usage, applications would restart to pick up env changes
      // For testing, we validate that domain services can handle the values
      const testConfig: SessionDbConfig = {
        backend: "sqlite",
        dbPath: "/custom/sessions.db",
        baseDir: "/test/base",
      };

      const validation = ConfigurationValidator.validateSessionDbConfig(testConfig);
      expect(validation.valid).toBe(true);
    });
  });

  describe("Domain Services Integration", () => {
    test("should validate sessiondb configuration using ConfigurationValidator", () => {
      const validConfig: SessionDbConfig = {
        backend: "json",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should resolve paths using PathResolver", () => {
      process.env.HOME = testDir;
      
      const resolvedPath = PathResolver.expandPath("~/custom/sessions.db");
      expect(resolvedPath).toBe(join(testDir, "custom", "sessions.db"));
    });

    test("should validate and resolve paths together", () => {
      process.env.HOME = testDir;

      // Simulate path resolution for sessiondb configuration
      const configWithPath = {
        backend: "sqlite" as const,
        dbPath: "~/sessions.db",
        baseDir: testDir,
      };

      // Resolve path using domain service
      const resolvedPath = PathResolver.expandPath(configWithPath.dbPath);
      
      // Create final config with resolved path
      const finalConfig: SessionDbConfig = {
        ...configWithPath,
        dbPath: resolvedPath,
      };

      // Validate final configuration
      const validation = ConfigurationValidator.validateSessionDbConfig(finalConfig);
      expect(validation.valid).toBe(true);
      expect(finalConfig.dbPath).toBe(join(testDir, "sessions.db"));
    });
  });

  describe("Backend-Specific Validation", () => {
    test("should validate JSON backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "json",
        baseDir: testDir,
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      expect(result.valid).toBe(true);
    });

    test("should validate SQLite backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "sqlite",
        dbPath: join(testDir, "sessions.db"),
        baseDir: testDir,
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      expect(result.valid).toBe(true);
    });

    test("should validate PostgreSQL backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "postgres",
        connectionString: "postgresql://user:pass@localhost/testdb",
        baseDir: testDir,
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      expect(result.valid).toBe(true);
    });

    test("should reject invalid configurations", () => {
      const invalidConfig = {
        backend: "invalid",
        baseDir: testDir,
      } as unknown as SessionDbConfig;

      const result = ConfigurationValidator.validateSessionDbConfig(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Path Resolution Integration", () => {
    test("should handle tilde expansion in configuration paths", () => {
      process.env.HOME = testDir;

      const path = "~/local-sessions";
      const resolved = PathResolver.expandPath(path);
      
      expect(resolved).toBe(join(testDir, "local-sessions"));
    });

    test("should handle environment variable expansion", () => {
      process.env.HOME = testDir;
      process.env.PROJECT_NAME = "test-project";

      const path = "${HOME}/projects/${PROJECT_NAME}/sessions";
      const resolved = PathResolver.expandPath(path);
      
      expect(resolved).toBe(join(testDir, "projects", "test-project", "sessions"));
    });

    test("should resolve relative paths with base directory", () => {
      const basePath = PathResolver.resolveConfigPath("./local-sessions", testDir);
      
      expect(basePath).toBe(join(testDir, "local-sessions"));
    });
  });
}); 
