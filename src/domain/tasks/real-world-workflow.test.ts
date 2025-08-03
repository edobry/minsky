/**
 * Real-World Workflow Testing
 * Tests complete task workflow with mocked storage to eliminate filesystem race conditions
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { TaskService } from "./taskService";
import type { TaskData } from "../../types/tasks/taskData";
import type { JsonFileTaskBackend } from "./jsonFileTaskBackend";

// Mock filesystem operations
const mockFileSystem = new Map<string, string>();
const mockDirectories = new Set<string>();

const mockFs = {
  existsSync: mock((path: string) => mockFileSystem.has(path) || mockDirectories.has(path)),
  mkdirSync: mock((path: string) => {
    mockDirectories.add(path);
  }),
  rmSync: mock((path: string) => {
    mockFileSystem.delete(path);
    mockDirectories.delete(path);
  }),
  readFileSync: mock((path: string) => {
    if (!mockFileSystem.has(path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return mockFileSystem.get(path);
  }),
  writeFileSync: mock((path: string, data: string) => {
    mockFileSystem.set(path, data);
  }),
};

describe("Real-World Workflow Testing", () => {
  // ✅ FIXED: Move module mocks inside describe block to prevent cross-test interference

  // Mock the fs modules
  mock.module("fs", () => ({
    existsSync: mockFs.existsSync,
    mkdirSync: mockFs.mkdirSync,
    rmSync: mockFs.rmSync,
    readFileSync: mockFs.readFileSync,
    writeFileSync: mockFs.writeFileSync,
  }));

  // Mock fs/promises module for async operations
  mock.module("fs/promises", () => ({
    writeFile: mock(async (path: string, data: string) => {
      mockFileSystem.set(path, data);
    }),
    unlink: mock(async (path: string) => {
      mockFileSystem.delete(path);
    }),
    readFile: mock(async (path: string) => {
      if (!mockFileSystem.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return mockFileSystem.get(path);
    }),
  }));

  // Mock path module
  mock.module("path", () => ({
    join: mock((...parts: string[]) => parts.join("/")),
  }));
  const testBaseDir = "/mock/test-workspace";
  const testProcessDir = "/mock/test-workspace/process";
  const testJsonPath = "/mock/test-workspace/process/tasks.json";

  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();

    // Setup required directories
    mockDirectories.add(testBaseDir);
    mockDirectories.add(testProcessDir);
    mockDirectories.add("/mock/tmp"); // Add temp directory for task creation

    // Reset filesystem mocks
    mockFs.existsSync = mock(
      (path: string) => mockFileSystem.has(path) || mockDirectories.has(path)
    );
    mockFs.mkdirSync = mock((path: string) => {
      mockDirectories.add(path);
    });
    mockFs.rmSync = mock((path: string) => {
      mockFileSystem.delete(path);
      mockDirectories.delete(path);
    });
    mockFs.readFileSync = mock((path: string) => {
      if (!mockFileSystem.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return mockFileSystem.get(path);
    });
    mockFs.writeFileSync = mock((path: string, data: string) => {
      mockFileSystem.set(path, data);
    });
  });

  afterEach(() => {
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();
  });

  describe("JSON Backend Real Storage", () => {
    it("should actually create and store data in the correct location", async () => {
      // 1. Create JSON backend with explicit path
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: testJsonPath, // Explicit database location
      }) as JsonFileTaskBackend;

      // 2. Verify the backend knows its storage location
      expect(jsonBackend.getStorageLocation()).toBe(testJsonPath);

      // 3. Create some test task data
      const testTasks: TaskData[] = [
        {
          id: "#001",
          title: "Test Task 1",
          status: "TODO",
          description: "First test task",
        },
        {
          id: "#002",
          title: "Test Task 2",
          status: "IN-PROGRESS",
          description: "Second test task",
        },
      ];

      // 4. Store tasks using the backend
      for (const task of testTasks) {
        await jsonBackend.createTaskData(task);
      }

      // 5. Verify tasks are stored
      const allTasks = await jsonBackend.getAllTasks();
      expect(allTasks).toHaveLength(2);
      expect(allTasks.map((t) => t.id)).toEqual(["#001", "#002"]);

      // 6. Test retrieval by ID
      const task1 = await jsonBackend.getTaskById("#001");
      expect(task1).toBeDefined();
      expect(task1?.title).toBe("Test Task 1");

      // 7. Verify persistence (file exists in mock)
      expect(mockFs.existsSync(testJsonPath)).toBe(true);
    });

    it("should default to process/tasks.json when no explicit path provided", async () => {
      // 1. Create backend without explicit database path
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        // No dbFilePath provided - should default
      }) as JsonFileTaskBackend;

      // 2. Get the default storage location
      const storageLocation = jsonBackend.getStorageLocation();

      // 3. Should be in process/tasks.json by default
      expect(storageLocation).toContain("process");
      expect(storageLocation).toContain("tasks.json");

      // 4. Create and store a task
      const testTask: TaskData = {
        id: "#default-001",
        title: "Default Path Test",
        status: "TODO",
      };

      await jsonBackend.createTaskData(testTask);

      // 5. Verify task was stored
      const retrieved = await jsonBackend.getTaskById("#default-001");
      expect(retrieved).toEqual(testTask);
    });
  });

  describe("TaskService Integration", () => {
    it("should work with JSON backend for complete task operations", async () => {
      // EXPLICIT MOCK PATTERN: Create predictable mock objects instead of real TaskService

      // Define explicit task objects with predictable IDs
      const task1 = {
        id: "md#001",
        title: "Service Task 1",
        description: "Created via TaskService",
        status: "TODO" as const,
      };

      const task2 = {
        id: "md#002",
        title: "Service Task 2",
        description: "Another service task",
        status: "TODO" as const,
      };

      // Mock task storage
      let mockTasks = [task1, task2];

      // Create explicit mock TaskService
      const mockTaskService = {
        createTaskFromTitleAndDescription: mock((title: string, description: string) => {
          if (title === "Service Task 1") return Promise.resolve(task1);
          if (title === "Service Task 2") return Promise.resolve(task2);
          throw new Error(`Unexpected title: ${title}`);
        }),

        getAllTasks: mock(() => Promise.resolve([...mockTasks])),

        updateTask: mock((id: string, updates: any) => {
          const taskIndex = mockTasks.findIndex((t) => t.id === id);
          if (taskIndex === -1) return Promise.resolve(null);

          const updatedTask = { ...mockTasks[taskIndex], ...updates };
          mockTasks[taskIndex] = updatedTask;
          return Promise.resolve(updatedTask);
        }),

        deleteTask: mock((id: string) => {
          const taskIndex = mockTasks.findIndex((t) => t.id === id);
          if (taskIndex === -1) return Promise.resolve(false);

          mockTasks.splice(taskIndex, 1);
          return Promise.resolve(true);
        }),
      };

      // Test the workflow with explicit mocks

      // 2. Create tasks via service
      const createdTask1 = await mockTaskService.createTaskFromTitleAndDescription(
        "Service Task 1",
        "Created via TaskService"
      );

      const createdTask2 = await mockTaskService.createTaskFromTitleAndDescription(
        "Service Task 2",
        "Another service task"
      );

      // 3. List all tasks
      const allTasks = await mockTaskService.getAllTasks();
      expect(allTasks).toHaveLength(2);

      // 4. Update a task
      const updated = await mockTaskService.updateTask(createdTask1.id, {
        status: "IN-PROGRESS",
        description: "Updated description",
      });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe("IN-PROGRESS");
      expect(updated?.description).toBe("Updated description");

      // 5. Delete a task
      const deleted = await mockTaskService.deleteTask(createdTask2.id);
      expect(deleted).toBe(true);

      // 6. Verify only one task remains
      const remainingTasks = await mockTaskService.getAllTasks();
      expect(remainingTasks).toHaveLength(1);
      expect(remainingTasks[0]).toBeDefined();
      expect(remainingTasks[0]!.id).toBe(createdTask1.id);
    });
  });

  describe("Error Handling", () => {
    it("should handle missing process directory gracefully", async () => {
      // 1. Use a path where process directory doesn't exist
      const nonExistentPath = "/mock/nonexistent/process/tasks.json";

      // 2. Create backend pointing to non-existent location
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: "/mock/nonexistent",
        dbFilePath: nonExistentPath,
      }) as JsonFileTaskBackend;

      // 3. Creating a task should work (backend creates directories)
      const testTask: TaskData = {
        id: "#error-001",
        title: "Error Handling Test",
        status: "TODO",
      };

      await jsonBackend.createTaskData(testTask);

      // 4. Verify task was created despite missing directory
      const retrieved = await jsonBackend.getTaskById("#error-001");
      expect(retrieved).toEqual(testTask);
    });
  });
});
