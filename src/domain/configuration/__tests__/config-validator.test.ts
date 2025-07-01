/**
 * ConfigurationValidator Service Tests
 * 
 * Tests for the extracted validation domain logic that was previously
 * embedded in the configuration system.
 */

import { describe, test, expect } from "bun:test";
import { ConfigurationValidator } from "../config-validator";
import type { SessionDbConfig } from "../types";

describe("ConfigurationValidator", () => {
  describe("validateSessionDbConfig", () => {
    test("should validate valid JSON backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "json",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate valid SQLite backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "sqlite",
        dbPath: "/test/sessions.db",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should validate valid PostgreSQL backend configuration", () => {
      const config: SessionDbConfig = {
        backend: "postgres",
        connectionString: "postgresql://user:pass@localhost/testdb",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should reject invalid backend type", () => {
      const config = {
        backend: "invalid-backend",
        baseDir: "/test/sessions",
      } as unknown as SessionDbConfig;

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid backend: invalid-backend. Must be one of: json, sqlite, postgres");
    });

    test("should require dbPath for SQLite backend", () => {
      const config: SessionDbConfig = {
        backend: "sqlite",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("SQLite backend requires dbPath to be specified");
    });

    test("should require connectionString for PostgreSQL backend", () => {
      const config: SessionDbConfig = {
        backend: "postgres",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("PostgreSQL backend requires connectionString to be specified");
    });

    test("should validate PostgreSQL connection string format", () => {
      const config: SessionDbConfig = {
        backend: "postgres",
        connectionString: "invalid-connection-string",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid PostgreSQL connection string format");
    });

    test("should warn about JSON file extension", () => {
      const config: SessionDbConfig = {
        backend: "json",
        dbPath: "/test/sessions.txt",
        baseDir: "/test/sessions",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("JSON backend dbPath should end with .json extension");
    });

    test("should warn about empty baseDir", () => {
      const config: SessionDbConfig = {
        backend: "json",
        baseDir: "   ",
      };

      const result = ConfigurationValidator.validateSessionDbConfig(config);
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("baseDir is empty, using default");
    });
  });

  describe("validateBackend", () => {
    test("should validate valid backend types", () => {
      const validBackends = ["json-file", "markdown", "github"];
      
      for (const backend of validBackends) {
        const result = ConfigurationValidator.validateBackend(backend);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    test("should reject invalid backend type", () => {
      const result = ConfigurationValidator.validateBackend("invalid-backend");
      
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid backend: invalid-backend. Must be one of: json-file, markdown, github");
    });
  });

  describe("validateCredentials", () => {
    test("should validate credentials with environment source", () => {
      const credentials = {
        github: {
          source: "environment",
        },
      };

      const result = ConfigurationValidator.validateCredentials(credentials);
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("should validate credentials with token", () => {
      const credentials = {
        github: {
          token: "github_token_123",
          source: "file",
        },
      };

      const result = ConfigurationValidator.validateCredentials(credentials);
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("should warn about missing GitHub token", () => {
      const credentials = {
        github: {
          source: "file",
        },
      };

      const result = ConfigurationValidator.validateCredentials(credentials);
      
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("GitHub credentials configured but no token provided");
    });

    test("should handle undefined credentials", () => {
      const result = ConfigurationValidator.validateCredentials(undefined);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });
}); 
