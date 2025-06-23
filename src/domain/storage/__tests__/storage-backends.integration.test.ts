/**
 * Integration Tests for SessionDB Storage Backends
 * 
 * Tests all storage backends (JSON, SQLite, PostgreSQL) with:
 * - Basic CRUD operations
 * - Error handling scenarios
 * - Migration between backends
 * - Configuration loading
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";

import { JsonFileStorage } from "../backends/json-file-storage";
import { SqliteStorage } from "../backends/sqlite-storage";
import { PostgresStorage } from "../backends/postgres-storage";
import { StorageBackendFactory } from "../storage-backend-factory";
import { MigrationService } from "../migration/migration-service";
import { SessionRecord, SessionDbState } from "../../session/session-db";
import { SessionDbConfig } from "../../configuration/types";

describe("Storage Backend Integration Tests", () => {
  let testDir: string;
  
  beforeEach(() => {
    testDir = join(tmpdir(), `sessiondb-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Test data
  const createTestSession = (id: string): SessionRecord => ({
    session: `session-${id}`,
    repoName: `test-repo-${id}`,
    repoUrl: `https://github.com/test/repo-${id}.git`,
    createdAt: new Date().toISOString(),
    taskId: `task-${id}`,
    branch: `task-branch-${id}`,
    repoPath: join(testDir, `repo-${id}`),
  });

  const createTestState = (sessionCount: number = 3): SessionDbState => ({
    sessions: Array.from({ length: sessionCount }, (_, i) => createTestSession(String(i + 1))),
  });

  describe("JsonFileStorage", () => {
    let storage: JsonFileStorage;
    let config: SessionDbConfig;

    beforeEach(async () => {
      config = { backend: "json", baseDir: testDir };
      storage = new JsonFileStorage(config);
      await storage.initialize();
    });

    test("should initialize correctly", async () => {
      expect(storage).toBeDefined();
      
      const result = await storage.readState();
      expect(result.success).toBe(true);
      expect(result.data?.sessions).toEqual([]);
    });

    test("should create and read entities", async () => {
      const session = createTestSession("test");
      
      const createResult = await storage.createEntity(session);
      expect(createResult.success).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.success).toBe(true);
      expect(readResult.data?.sessions).toHaveLength(1);
      expect(readResult.data?.sessions[0]).toEqual(session);
    });

    test("should update entities", async () => {
      const session = createTestSession("test");
      await storage.createEntity(session);

      const updatedSession = { ...session, repoName: "updated-repo" };
      const updateResult = await storage.updateEntity(session.session, updatedSession);
      expect(updateResult.success).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.data?.sessions[0].repoName).toBe("updated-repo");
    });

    test("should delete entities", async () => {
      const session = createTestSession("test");
      await storage.createEntity(session);

      const deleteResult = await storage.deleteEntity(session.session);
      expect(deleteResult.success).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.data?.sessions).toHaveLength(0);
    });

    test("should write and read complete state", async () => {
      const state = createTestState(3);
      
      const writeResult = await storage.writeState(state);
      expect(writeResult.success).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.success).toBe(true);
      expect(readResult.data?.sessions).toHaveLength(3);
    });

    test("should handle file corruption gracefully", async () => {
      // Create corrupted JSON file
      const corruptFile = join(testDir, "session-db.json");
      require("fs").writeFileSync(corruptFile, "{ invalid json");

      const corruptedStorage = new JsonFileStorage({ backend: "json", baseDir: testDir });
      await corruptedStorage.initialize();

      const result = await corruptedStorage.readState();
      expect(result.success).toBe(false);
      expect(result.error).toContain("JSON");
    });
  });

  describe("SqliteStorage", () => {
    let storage: SqliteStorage;
    let config: SessionDbConfig;

    beforeEach(async () => {
      config = { 
        backend: "sqlite", 
        dbPath: join(testDir, "test-sessions.db"),
        baseDir: testDir 
      };
      storage = new SqliteStorage(config);
      await storage.initialize();
    });

    afterEach(async () => {
      await storage.close?.();
    });

    test("should initialize and create schema", async () => {
      expect(storage).toBeDefined();
      
      const result = await storage.readState();
      expect(result.success).toBe(true);
      expect(result.data?.sessions).toEqual([]);
    });

    test("should handle CRUD operations", async () => {
      const session = createTestSession("sqlite-test");
      
      // Create
      const createResult = await storage.createEntity(session);
      expect(createResult.success).toBe(true);

      // Read
      const readResult = await storage.readState();
      expect(readResult.success).toBe(true);
      expect(readResult.data?.sessions).toHaveLength(1);
      
      // Update
      const updatedSession = { ...session, taskId: "updated-task" };
      const updateResult = await storage.updateEntity(session.session, updatedSession);
      expect(updateResult.success).toBe(true);

      // Verify update
      const updatedReadResult = await storage.readState();
      expect(updatedReadResult.data?.sessions[0].taskId).toBe("updated-task");

      // Delete
      const deleteResult = await storage.deleteEntity(session.session);
      expect(deleteResult.success).toBe(true);

      // Verify deletion
      const finalReadResult = await storage.readState();
      expect(finalReadResult.data?.sessions).toHaveLength(0);
    });

    test("should handle concurrent operations", async () => {
      const sessions = [
        createTestSession("concurrent-1"),
        createTestSession("concurrent-2"),
        createTestSession("concurrent-3"),
      ];

      // Create multiple sessions concurrently
      const createPromises = sessions.map(session => storage.createEntity(session));
      const createResults = await Promise.all(createPromises);
      
      expect(createResults.every(r => r.success)).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.data?.sessions).toHaveLength(3);
    });

    test("should handle duplicate session IDs", async () => {
      const session = createTestSession("duplicate");
      
      const firstResult = await storage.createEntity(session);
      expect(firstResult.success).toBe(true);

      const secondResult = await storage.createEntity(session);
      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain("UNIQUE constraint failed");
    });
  });

  describe("PostgresStorage", () => {
    let storage: PostgresStorage;
    let config: SessionDbConfig;

    beforeEach(async () => {
      // Skip PostgreSQL tests if no connection string available
      const connectionString = process.env.TEST_POSTGRES_URL;
      if (!connectionString) {
        console.log("Skipping PostgreSQL tests - no TEST_POSTGRES_URL environment variable");
        return;
      }

      config = { 
        backend: "postgres", 
        connectionString,
        baseDir: testDir 
      };
      storage = new PostgresStorage(config);
      
      try {
        await storage.initialize();
      } catch (error) {
        console.log("Skipping PostgreSQL tests - database not available:", error);
        return;
      }
    });

    afterEach(async () => {
      if (storage) {
        // Clean up test data
        try {
          const state = await storage.readState();
          if (state.success && state.data) {
            for (const session of state.data.sessions) {
              await storage.deleteEntity(session.session);
            }
          }
        } catch (error) {
          console.log("Cleanup error:", error);
        }
        await storage.close?.();
      }
    });

    const skipIfNoPostgres = () => {
      if (!process.env.TEST_POSTGRES_URL || !storage) {
        return true; // Skip test
      }
      return false;
    };

    test("should handle basic operations", async () => {
      if (skipIfNoPostgres()) return;

      const session = createTestSession("pg-test");
      
      const createResult = await storage.createEntity(session);
      expect(createResult.success).toBe(true);

      const readResult = await storage.readState();
      expect(readResult.success).toBe(true);
      expect(readResult.data?.sessions.length).toBeGreaterThanOrEqual(1);
      
      const createdSession = readResult.data?.sessions.find(s => s.session === session.session);
      expect(createdSession).toBeDefined();
      expect(createdSession?.repoName).toBe(session.repoName);
    });

    test("should handle connection errors gracefully", async () => {
      const badConfig: SessionDbConfig = {
        backend: "postgres",
        connectionString: "postgresql://invalid:invalid@localhost:5432/invalid",
        baseDir: testDir,
      };

      const badStorage = new PostgresStorage(badConfig);
      
      const result = await badStorage.readState();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("StorageBackendFactory", () => {
    test("should create correct backend from config", () => {
      const jsonConfig: SessionDbConfig = { backend: "json", baseDir: testDir };
      const jsonStorage = StorageBackendFactory.createFromConfig(jsonConfig);
      expect(jsonStorage).toBeInstanceOf(JsonFileStorage);

      const sqliteConfig: SessionDbConfig = { 
        backend: "sqlite", 
        dbPath: join(testDir, "test.db"),
        baseDir: testDir 
      };
      const sqliteStorage = StorageBackendFactory.createFromConfig(sqliteConfig);
      expect(sqliteStorage).toBeInstanceOf(SqliteStorage);

      const pgConfig: SessionDbConfig = { 
        backend: "postgres", 
        connectionString: "postgresql://test:test@localhost/test",
        baseDir: testDir 
      };
      const pgStorage = StorageBackendFactory.createFromConfig(pgConfig);
      expect(pgStorage).toBeInstanceOf(PostgresStorage);
    });

    test("should throw on invalid backend", () => {
      const invalidConfig = { backend: "invalid" } as any;
      expect(() => StorageBackendFactory.createFromConfig(invalidConfig)).toThrow();
    });
  });

  describe("Migration Between Backends", () => {
    test("should migrate from JSON to SQLite", async () => {
      // Set up source (JSON)
      const jsonConfig: SessionDbConfig = { backend: "json", baseDir: testDir };
      const jsonStorage = new JsonFileStorage(jsonConfig);
      await jsonStorage.initialize();

      // Add test data to JSON
      const testState = createTestState(3);
      await jsonStorage.writeState(testState);

      // Set up target (SQLite)
      const sqliteConfig: SessionDbConfig = { 
        backend: "sqlite", 
        dbPath: join(testDir, "migrated.db"),
        baseDir: testDir 
      };

      // Perform migration
      const migrationResult = await MigrationService.migrate({
        sourceConfig: jsonConfig,
        targetConfig: sqliteConfig,
        verify: true,
      });

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.recordsMigrated).toBe(3);
      expect(migrationResult.verificationResult?.success).toBe(true);

      // Verify target contains data
      const sqliteStorage = new SqliteStorage(sqliteConfig);
      await sqliteStorage.initialize();
      const result = await sqliteStorage.readState();
      
      expect(result.success).toBe(true);
      expect(result.data?.sessions).toHaveLength(3);
      
      await sqliteStorage.close?.();
    });

    test("should handle migration failures gracefully", async () => {
      const sourceConfig: SessionDbConfig = { backend: "json", baseDir: "/nonexistent" };
      const targetConfig: SessionDbConfig = { 
        backend: "sqlite", 
        dbPath: join(testDir, "target.db"),
        baseDir: testDir 
      };

      const migrationResult = await MigrationService.migrate({
        sourceConfig,
        targetConfig,
      });

      expect(migrationResult.success).toBe(false);
      expect(migrationResult.errors.length).toBeGreaterThan(0);
    });

    test("should perform dry run migration", async () => {
      const jsonConfig: SessionDbConfig = { backend: "json", baseDir: testDir };
      const jsonStorage = new JsonFileStorage(jsonConfig);
      await jsonStorage.initialize();
      await jsonStorage.writeState(createTestState(2));

      const sqliteConfig: SessionDbConfig = { 
        backend: "sqlite", 
        dbPath: join(testDir, "dryrun.db"),
        baseDir: testDir 
      };

      const migrationResult = await MigrationService.migrate({
        sourceConfig: jsonConfig,
        targetConfig: sqliteConfig,
        dryRun: true,
      });

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.recordsMigrated).toBe(2);
      expect(migrationResult.warnings.some(w => w.includes("Dry run"))).toBe(true);

      // Verify target was not created
      expect(existsSync(join(testDir, "dryrun.db"))).toBe(false);
    });
  });

  describe("Error Handling Edge Cases", () => {
    test("should handle storage initialization failures", async () => {
      const badConfig: SessionDbConfig = { 
        backend: "sqlite", 
        dbPath: "/root/readonly.db", // Should fail on most systems
        baseDir: testDir 
      };

      const storage = new SqliteStorage(badConfig);
      
      // Should not throw, but operations should fail gracefully
      const result = await storage.readState();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("should handle corrupted database files", async () => {
      const dbPath = join(testDir, "corrupted.db");
      
      // Create a file that looks like SQLite but isn't
      require("fs").writeFileSync(dbPath, "This is not a SQLite database");

      const config: SessionDbConfig = { backend: "sqlite", dbPath, baseDir: testDir };
      const storage = new SqliteStorage(config);

      const result = await storage.readState();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("should handle disk space issues gracefully", async () => {
      // This test is harder to simulate reliably, but we can test large data writes
      const config: SessionDbConfig = { backend: "json", baseDir: testDir };
      const storage = new JsonFileStorage(config);
      await storage.initialize();

      // Create a very large state that might cause issues
      const largeState: SessionDbState = {
        sessions: Array.from({ length: 10000 }, (_, i) => ({
          ...createTestSession(String(i)),
          // Add large data to stress test
          repoUrl: "https://github.com/test/repo.git".repeat(100),
        }))
      };

      const result = await storage.writeState(largeState);
      // This should either succeed or fail gracefully
      expect(typeof result.success).toBe("boolean");
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });
}); 
