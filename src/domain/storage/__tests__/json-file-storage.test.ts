/**
 * Tests for JsonFileStorage implementation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { createJsonFileStorage } from "../json-file-storage";
import type { DatabaseStorage } from "../database-storage";

// Test data types
interface TestEntity {
  id: string;
  name: string;
  value: number;
}

interface TestState {
  totalCount: number;
  lastModified: string;
}

describe("JsonFileStorage", () => {
  let storage: DatabaseStorage<TestEntity, TestState>;
  let testDbPath: string;
  let testDirPath: string;

  beforeEach(() => {
    // Create unique test database path
    const timestamp = Date.now();
    testDirPath = join(process.cwd(), "test-tmp", `json-storage-test-${timestamp}`);
    testDbPath = join(testDirPath, "test.json");

    // Ensure test directory exists
    mkdirSync(testDirPath, { recursive: true });

    // Create storage instance
    storage = createJsonFileStorage<TestEntity, TestState>({
      filePath: testDbPath,
      initialState: {
        entities: [],
        state: {
          totalCount: 0,
          lastModified: new Date().toISOString(),
        },
      },
    });
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(testDirPath)) {
      rmSync(testDirPath, { recursive: true, force: true });
    }
  });

  describe("initialization", () => {
    test("should initialize with empty state when file doesn't exist", async () => {
      const result = await storage.getAll();
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    test("should create parent directories if they don't exist", async () => {
      const nestedPath = join(testDirPath, "nested", "deep", "test.json");
      const nestedStorage = createJsonFileStorage<TestEntity, TestState>({
        filePath: nestedPath,
        initialState: {
          entities: [],
          state: {
            totalCount: 0,
            lastModified: new Date().toISOString(),
          },
        },
      });

      const result = await nestedStorage.create({
        id: "test1",
        name: "Test Entity",
        value: 42,
      });

      expect(result.success).toBe(true);
      expect(existsSync(nestedPath)).toBe(true);
      expect(existsSync(dirname(nestedPath))).toBe(true);
    });
  });

  describe("CRUD operations", () => {
    test("should create entities", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      const result = await storage.create(entity);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(entity);
    });

    test("should read entities", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await storage.create(entity);
      const result = await storage.getById("test1");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(entity);
    });

    test("should update entities", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await storage.create(entity);

      const updatedEntity = { ...entity, name: "Updated Entity", value: 100 };
      const result = await storage.update("test1", updatedEntity);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(updatedEntity);
    });

    test("should delete entities", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await storage.create(entity);
      const deleteResult = await storage.delete("test1");

      expect(deleteResult.success).toBe(true);

      const getResult = await storage.getById("test1");
      expect(getResult.success).toBe(false);
    });

    test("should get all entities", async () => {
      const entities: TestEntity[] = [
        { id: "test1", name: "Entity 1", value: 10 },
        { id: "test2", name: "Entity 2", value: 20 },
        { id: "test3", name: "Entity 3", value: 30 },
      ];

      for (const entity of entities) {
        await storage.create(entity);
      }

      const result = await storage.getAll();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data).toEqual(expect.arrayContaining(entities));
    });
  });

  describe("querying", () => {
    beforeEach(async () => {
      const entities: TestEntity[] = [
        { id: "test1", name: "Entity 1", value: 10 },
        { id: "test2", name: "Entity 2", value: 20 },
        { id: "test3", name: "Entity 3", value: 30 },
        { id: "test4", name: "Special Entity", value: 25 },
      ];

      for (const entity of entities) {
        await storage.create(entity);
      }
    });

    test("should query with simple predicate", async () => {
      const result = await storage.query((entity) => entity.value > 20);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data.map((e) => e.id)).toEqual(["test3", "test4"]);
    });

    test("should query with complex predicate", async () => {
      const result = await storage.query(
        (entity) => entity.name.includes("Entity") && entity.value < 25
      );

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data.map((e) => e.id)).toEqual(["test1", "test2"]);
    });

    test("should return empty array when no matches", async () => {
      const result = await storage.query((entity) => entity.value > 100);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe("state management", () => {
    test("should get current state", async () => {
      const result = await storage.getState();

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        totalCount: 0,
        lastModified: expect.any(String),
      });
    });

    test("should update state", async () => {
      const newState: TestState = {
        totalCount: 5,
        lastModified: "2023-01-01T00:00:00.000Z",
      };

      const result = await storage.updateState(newState);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(newState);

      const getResult = await storage.getState();
      expect(getResult.data).toEqual(newState);
    });
  });

  describe("error handling", () => {
    test("should handle non-existent entity reads", async () => {
      const result = await storage.getById("nonexistent");

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe("EntityNotFound");
    });

    test("should handle updates to non-existent entities", async () => {
      const result = await storage.update("nonexistent", {
        id: "nonexistent",
        name: "Test",
        value: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe("EntityNotFound");
    });

    test("should handle deletes of non-existent entities", async () => {
      const result = await storage.delete("nonexistent");

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe("EntityNotFound");
    });

    test("should handle duplicate entity creation", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await storage.create(entity);
      const result = await storage.create(entity);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe("EntityAlreadyExists");
    });
  });

  describe("persistence", () => {
    test("should persist data across instances", async () => {
      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await storage.create(entity);

      // Create new storage instance with same file
      const storage2 = createJsonFileStorage<TestEntity, TestState>({
        filePath: testDbPath,
        initialState: {
          entities: [],
          state: {
            totalCount: 0,
            lastModified: new Date().toISOString(),
          },
        },
      });

      const result = await storage2.getById("test1");
      expect(result.success).toBe(true);
      expect(result.data).toEqual(entity);
    });

    test("should handle pretty printing option", async () => {
      const prettyStorage = createJsonFileStorage<TestEntity, TestState>({
        filePath: testDbPath,
        initialState: {
          entities: [],
          state: {
            totalCount: 0,
            lastModified: new Date().toISOString(),
          },
        },
        prettyPrint: true,
      });

      const entity: TestEntity = {
        id: "test1",
        name: "Test Entity",
        value: 42,
      };

      await prettyStorage.create(entity);

      // File should exist and be readable
      expect(existsSync(testDbPath)).toBe(true);

      // Content should be pretty-printed (contains newlines and indentation)
      const fs = require("fs");
      const content = fs.readFileSync(testDbPath, "utf8");
      expect(content).toContain("\n");
      expect(content).toContain("  ");
    });
  });
});
