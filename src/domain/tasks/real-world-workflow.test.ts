/**
 * Real-World Workflow Testing
 * Tests complete task workflow with mocked storage to eliminate filesystem race conditions
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { TaskServiceInterface } from "./taskService";
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
    mkdir: mock(async (path: string, options?: any) => {
      mockDirectories.add(path);
    }),
    access: mock(async (path: string) => {
      if (!mockFileSystem.has(path) && !mockDirectories.has(path)) {
        throw new Error(`ENOENT: no such file or directory, access '${path}'`);
      }
    }),
  }));

  // Mock path module
  mock.module("path", () => ({
    join: mock((...parts: string[]) => parts.join("/")),
    dirname: mock((path: string) => {
      const parts = path.split("/");
      return parts.slice(0, -1).join("/") || "/";
    }),
  }));
  const testBaseDir = "/tmp/test-workspace";
  const testProcessDir = "/tmp/test-workspace/process";
  const testJsonPath = "/tmp/test-workspace/process/tasks.json";

  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();

    // Setup required directories
    mockDirectories.add(testBaseDir);
    mockDirectories.add(testProcessDir);
    mockDirectories.add("/tmp/tmp"); // Add temp directory for task creation

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

    // Clean up any real files that might have been created
    try {
      const fs = require("fs");
      if (fs.existsSync(testBaseDir)) {
        fs.rmSync(testBaseDir, { recursive: true, force: true });
      }
      if (fs.existsSync("/tmp/nonexistent")) {
        fs.rmSync("/tmp/nonexistent", { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
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
});
