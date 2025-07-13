/**
 * Tests for EnhancedStorageBackendFactory
 *
 * Tests the enhanced storage backend factory with integrity checking,
 * auto-migration, and enhanced error reporting capabilities.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import {
  EnhancedStorageBackendFactory,
  createEnhancedStorageBackend,
  createStrictStorageBackend,
  createAutoMigratingStorageBackend,
  createEnhancedStorageBackendFactory,
} from "../enhanced-storage-backend-factory";
import type { EnhancedStorageConfig } from "../enhanced-storage-backend-factory";
import { log } from "../../../utils/logger";

// Test data
const VALID_JSON_SESSIONS = {
  sessions: [
    {
      session: "test-session-1",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo.git",
      createdAt: "2023-01-01T00:00:00.000Z",
      taskId: "task#001",
      branch: "main",
      repoPath: "/path/to/repo",
    },
  ],
  baseDir: "/test/base",
};

// Global test isolation
let testSequenceNumber = 0;

describe("EnhancedStorageBackendFactory", () => {
  let testDirPath: string;
  let sqliteDbPath: string;
  let jsonDbPath: string;
  let backupPath: string;
  let factory: EnhancedStorageBackendFactory;

  beforeEach(async () => {
    // Create unique test directory
    const timestamp = Date.now();
    const uuid = randomUUID();
    const sequence = ++testSequenceNumber;
    testDirPath = join(
      process.cwd(),
      "test-tmp",
      `enhanced-factory-test-${timestamp}-${uuid}-${sequence}`
    );
    sqliteDbPath = join(testDirPath, "sessions.db");
    jsonDbPath = join(testDirPath, "session-db.json");
    backupPath = join(testDirPath, "session-db-backup-12345.json");

    // Ensure test directory exists
    mkdirSync(testDirPath, { recursive: true });

    // Create fresh factory instance for each test (eliminates singleton pollution)
    factory = createEnhancedStorageBackendFactory();
  });

  afterEach(async () => {
    try {
      // Clean up factory
      await factory.closeAll();
      factory.clearCache();

      // Wait for pending operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup test files
      if (existsSync(testDirPath)) {
        rmSync(testDirPath, { recursive: true, force: true });
      }
    } catch (error) {
      log.warn(`Cleanup warning for ${testDirPath}:`, { error });
    }
  });

  describe("Basic Storage Creation", () => {
    test("should create SQLite storage when integrity check passes", async () => {
      // Create valid SQLite database
      const db = new Database(sqliteDbPath);
      db.exec(`
        CREATE TABLE sessions (
          session TEXT PRIMARY KEY,
          repoName TEXT NOT NULL,
          repoUrl TEXT,
          createdAt TEXT NOT NULL,
          taskId TEXT,
          branch TEXT,
          repoPath TEXT
        )
      `);
      db.close();

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,

      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.integrityResult?.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
      expect(result.autoMigrationPerformed).toBeFalsy();
    });

    test("should create JSON storage when integrity check passes", async () => {
      // Create valid JSON database
      writeFileSync(jsonDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "json",
        json: { filePath: jsonDbPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.integrityResult?.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test("should skip integrity check when disabled", async () => {
      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: false,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.integrityResult).toBeUndefined();
    });
  });

  describe("Format Mismatch Handling", () => {
    test("should detect format mismatch and provide warnings in non-strict mode", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.integrityResult?.isValid).toBe(false);
      expect(result.integrityResult?.issues).toContain(
        expect.stringContaining("Database format mismatch: expected sqlite, found json")
      );
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test("should throw error in strict mode for format mismatch", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
        strictIntegrity: true,
      };

      await expect(factory.createStorageBackend(config)).rejects.toThrow(
        expect.stringContaining("Database integrity check failed")
      );
    });

    test("should suggest migration for format mismatch", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.integrityResult?.suggestedActions).toContainEqual(
        expect.objectContaining({
          type: "migrate",
          description: expect.stringContaining("Migrate from json to sqlite"),
          priority: "high",
        })
      );
    });
  });

  describe("Missing Database Handling", () => {
    test("should handle missing database with backup detection", async () => {
      // Create backup file
      writeFileSync(backupPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.integrityResult?.actualFormat).toBe("empty");
      expect(result.integrityResult?.backupsFound.length).toBeGreaterThan(0);
      expect(result.integrityResult?.suggestedActions).toContainEqual(
        expect.objectContaining({
          type: "migrate",
          description: expect.stringContaining("Found"),
          priority: "high",
        })
      );
    });

    test("should suggest initialization when no backups found", async () => {
      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.integrityResult?.suggestedActions).toContainEqual(
        expect.objectContaining({
          type: "create",
          description: expect.stringContaining("Initialize new database"),
          priority: "medium",
        })
      );
    });
  });

  describe("Auto-Migration", () => {
    test("should simulate auto-migration when enabled", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
        autoMigrate: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      // In our current implementation, auto-migration is simulated
      // In a real implementation, this would actually perform the migration
      expect(result.autoMigrationPerformed).toBe(true);
    });

    test("should not auto-migrate when disabled", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
        autoMigrate: false,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.autoMigrationPerformed).toBeFalsy();
    });
  });

  describe("Convenience Functions", () => {
    test("createEnhancedStorageBackend should work with default config", async () => {
      // Create valid SQLite database
      const db = new Database(sqliteDbPath);
      db.exec("CREATE TABLE sessions (session TEXT PRIMARY KEY)");
      db.close();

      const result = await createEnhancedStorageBackend({
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
      });

      expect(result.storage).toBeDefined();
      expect(result.integrityResult?.isValid).toBe(true);
    });

    test("createStrictStorageBackend should enforce strict integrity", async () => {
      // Create JSON data in SQLite path (format mismatch)
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      await expect(
        createStrictStorageBackend({
          backend: "sqlite",
          sqlite: { dbPath: sqliteDbPath },
        })
      ).rejects.toThrow();
    });

    test("createAutoMigratingStorageBackend should enable auto-migration", async () => {
      // Create JSON data in SQLite path
      writeFileSync(sqliteDbPath, JSON.stringify(VALID_JSON_SESSIONS, null, 2));

      const storage = await createAutoMigratingStorageBackend({
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
      });

      expect(storage).toBeDefined();
    });
  });

  describe("Caching", () => {
    test("should cache storage backends", async () => {
      // Create valid SQLite database
      const db = new Database(sqliteDbPath);
      db.exec("CREATE TABLE sessions (session TEXT PRIMARY KEY)");
      db.close();

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result1 = await factory.getBackend(config);
      const result2 = await factory.getBackend(config);

      expect(result1.storage).toBe(result2.storage); // Same instance
    });

    test("should clear cache properly", async () => {
      // Create valid SQLite database
      const db = new Database(sqliteDbPath);
      db.exec("CREATE TABLE sessions (session TEXT PRIMARY KEY)");
      db.close();

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
        enableIntegrityCheck: true,
      };

      const result1 = await factory.getBackend(config);
      factory.clearCache();
      const result2 = await factory.getBackend(config);

      expect(result1.storage).not.toBe(result2.storage); // Different instances
    });
  });

  describe("PostgreSQL Handling", () => {
    test("should skip file integrity check for PostgreSQL", async () => {
      const config: EnhancedStorageConfig = {
        backend: "postgres",
        postgres: { connectionUrl: "postgresql://localhost:5432/test" },
        enableIntegrityCheck: true,
      };

      // This would fail in a real environment without PostgreSQL
      // but we're testing the integrity check skipping logic
      try {
        await factory.createStorageBackend(config);
      } catch (error) {
        // Expected to fail due to no PostgreSQL, but should not be due to integrity check
        expect(error).not.toMatch(/integrity/i);
      }
    });
  });

  describe("Error Handling", () => {
    test("should handle initialization failures gracefully", async () => {
      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: "/invalid/path/that/cannot/exist/sessions.db" },
        enableIntegrityCheck: false, // Skip integrity check to test init failure
      };

      await expect(factory.createStorageBackend(config)).rejects.toThrow();
    });

    test("should handle integrity check failures gracefully", async () => {
      // Create a file we don't have permission to read (simulated)
      const restrictedPath = join(testDirPath, "restricted.db");
      writeFileSync(restrictedPath, "test");

      const config: EnhancedStorageConfig = {
        backend: "sqlite",
        sqlite: { dbPath: restrictedPath },
        enableIntegrityCheck: true,
      };

      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Configuration Loading", () => {
    test("should load enhanced configuration with defaults", async () => {
      const config: Partial<EnhancedStorageConfig> = {
        backend: "sqlite",
        sqlite: { dbPath: sqliteDbPath },
      };

      // Use reflection to test private method (if needed for thorough testing)
      // For now, test through public interface
      const result = await factory.createStorageBackend(config);

      expect(result.storage).toBeDefined();
      // Verify defaults are applied (integrity check enabled by default)
      expect(result.integrityResult).toBeDefined();
    });
  });
});
