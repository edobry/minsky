const DEFAULT_DISPLAY_LENGTH = 100;
const SIZE_6 = 6;
const TEST_ANSWER = 42;
const TEST_ARRAY_SIZE = 3;
const TEST_VALUE = 123;

/**
 * Core tests for JsonFileStorage implementation
 * Tests the most critical functionality with correct API
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { randomUUID } from "crypto";
import { createJsonFileStorage } from "./json-file-storage";
import type { DatabaseStorage } from "./database-storage";
import { expectToHaveLength } from "../../utils/test-utils/assertions";
import { log } from "../../utils/logger";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

describe("JsonFileStorage Core Tests", () => {
  // Static mock paths to prevent environment dependencies
  const mockTempDir = "/mock/tmp/storage-core-test";
  const mockSequence = 1;
  const mockUuid = "test-uuid-123";
  const mockTimestamp = "20240101-120000";

  // Test data types following TaskData pattern
  interface TestEntity {
    id: string;
    name: string;
    value: number;
  }

  interface TestState {
    entities: TestEntity[];
    count: number;
    lastUpdated: string;
  }

  let storage: DatabaseStorage<TestState>;
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let testDirPath: string;

  beforeEach(() => {
    // Create isolated mock filesystem for each test
    mockFs = createMockFilesystem();

    // Use mock.module() to mock filesystem operations
    mock.module("fs", () => ({
      existsSync: mockFs.existsSync,
      mkdirSync: mockFs.mkdirSync,
      rmSync: mockFs.rmSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
    }));

    // Static mock test directory path
    testDirPath = join(
      mockTempDir,
      `storage-core-test-${mockTimestamp}-${mockUuid}-${mockSequence}`
    );

    // Create storage instance with correct configuration
    storage = createJsonFileStorage<TestState>({
      filePath: join(testDirPath, "test-storage.json"),
    });

    log(`Setting up test with mock storage path: ${testDirPath}`, "test-setup");

    // Initialize test state
    const initialState: TestState = {
      entities: [],
      count: 0,
      lastUpdated: new Date().toISOString(),
    };

    // Use mock filesystem instead of real filesystem operations
    mockFs.ensureDirectoryExists(testDirPath);
  });

  afterEach(() => {
    try {
      // Clean up using mock filesystem
      mockFs.cleanup();
      log("Test cleanup completed", "test-cleanup");
    } catch (error) {
      log("Error during test cleanup", "test-cleanup", error);
    }
  });

  describe("Core CRUD Operations", () => {
    test("should create and retrieve entities", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: TEST_ANSWER,
      };

      // Create entity
      const created = await storage.createEntity(entity);
      expect(created).toEqual(entity);

      // Retrieve entity
      const retrieved = await storage.getEntity("test1");
      expect(retrieved).toEqual(entity);

      // Check entity exists
      const exists = await storage.entityExists("test1");
      expect(exists).toBe(true);
    });

    test("should update entities", async () => {
      const entity: TestEntity = {
        id: "test2",
        name: "Original Name",
        value: 10,
      };

      // Create then update
      await storage.createEntity(entity);
      const updated = await storage.updateEntity("test2", {
        name: "Updated Name",
        value: DEFAULT_DISPLAY_LENGTH,
      });

      expect(updated).toEqual({
        id: "test2",
        name: "Updated Name",
        value: DEFAULT_DISPLAY_LENGTH,
      });

      // Verify update persisted
      const retrieved = await storage.getEntity("test2");
      expect(retrieved?.name).toBe("Updated Name");
      expect(retrieved?.value).toBe(DEFAULT_DISPLAY_LENGTH);
    });

    test("should delete entities", async () => {
      const entity: TestEntity = {
        id: "test3",
        name: "To Delete",
        value: 99,
      };

      // Create then delete
      await storage.createEntity(entity);
      const deleted = await storage.deleteEntity("test3");
      expect(deleted).toBe(true);

      // Verify deletion
      const retrieved = await storage.getEntity("test3");
      expect(retrieved).toBe(null);

      const exists = await storage.entityExists("test3");
      expect(exists).toBe(false);
    });

    test("should get all entities", async () => {
      const entities: TestEntity[] = [
        { id: "test4", name: "Entity 4", value: 40 },
        { id: "test5", name: "Entity TEST_ARRAY_SIZE", value: 50 },
        { id: "test6", name: "Entity SIZE_6", value: 60 },
      ];

      // Create multiple entities
      for (const entity of entities) {
        await storage.createEntity(entity);
      }

      // Retrieve all
      const allEntities = await storage.getEntities();
      expectToHaveLength(allEntities, 3);

      // Check all entities are present
      for (const entity of entities) {
        expect(allEntities.find((e) => e.id === entity.id)).toEqual(entity);
      }
    });
  });

  describe("State Management", () => {
    test("should read and write state", async () => {
      // Read initial state
      const initialRead = await storage.readState();
      expect(initialRead.success).toBe(true);
      expect(initialRead.data?.entities).toEqual([]);

      // Write custom state
      const customState: TestState = {
        entities: [{ id: "state1", name: "State Entity", value: 100 }],
        lastUpdated: "2023-01-01T00:00:00.000Z",
        metadata: { customField: "test" },
      };

      const writeResult = await storage.writeState(customState);
      expect(writeResult.success).toBe(true);

      // Read back state
      const readResult = await storage.readState();
      expect(readResult.success).toBe(true);
      expect(readResult.data).toEqual(customState);
    });
  });

  describe("Error Handling", () => {
    test("should handle non-existent entities gracefully", async () => {
      // Get non-existent entity
      const entity = await storage.getEntity("nonexistent");
      expect(entity).toBe(null);

      // Update non-existent entity
      const updated = await storage.updateEntity("nonexistent", { name: "test" });
      expect(updated).toBe(null);

      // Delete non-existent entity
      const deleted = await storage.deleteEntity("nonexistent");
      expect(deleted).toBe(false);

      // Check non-existent entity
      const exists = await storage.entityExists("nonexistent");
      expect(exists).toBe(false);
    });
  });

  describe("Persistence", () => {
    test("should persist data across storage instances", async () => {
      const entity: TestEntity = {
        id: "persist1",
        name: "Persistent Entity",
        value: TEST_VALUE,
      };

      // Create entity with first instance
      await storage.createEntity(entity);

      // Create new storage instance with same file
      const storage2 = createJsonFileStorage<TestEntity, TestState>({
        filePath: testDbPath,
        entitiesField: "entities",
        initializeState: () => ({
          entities: [],
          lastUpdated: new Date().toISOString(),
          metadata: {},
        }),
      });

      await storage2.initialize();

      // Retrieve with second instance
      const retrieved = await storage2.getEntity("persist1");
      expect(retrieved).toEqual(entity);
    });

    test("should handle storage location correctly", () => {
      const location = storage.getStorageLocation();
      expect(location).toBe(testDbPath);
    });
  });
});
