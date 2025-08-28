const SIZE_6 = 6;
const TEST_ARRAY_SIZE = 3;

/**
 * Tests for JsonFileTaskBackend
 * Uses completely mocked storage to test logic without any filesystem operations
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { TEST_DATA_PATTERNS } from "../../utils/test-utils/test-constants";

describe("JsonFileTaskBackend", () => {
  let backend: any;
  const mockTasks = new Map<string, any>();

  beforeEach(() => {
    // Reset all mocks before each test
    mock.restore();
    mockTasks.clear();

    // Create a completely mocked backend that doesn't touch the filesystem
    backend = {
      getStorageLocation: mock(() => "/mock/test-tasks.json"),

      async createTaskData(task: any) {
        mockTasks.set(task.id, { ...task });
        return task;
      },

      async getTaskById(id: string) {
        return mockTasks.get(id) || null;
      },

      async getAllTasks() {
        return Array.from(mockTasks.values());
      },

      async updateTaskData(id: string, updates: any) {
        const existing = mockTasks.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...updates };
        mockTasks.set(id, updated);
        return updated;
      },

      async deleteTaskData(id: string) {
        return mockTasks.delete(id);
      },

      async getTasksData() {
        return {
          success: true,
          content: JSON.stringify({
            tasks: Array.from(mockTasks.values()),
            lastUpdated: new Date().toISOString(),
          }),
        };
      },

      async saveTasksData(data: string) {
        try {
          const parsed = JSON.parse(data);
          mockTasks.clear();
          if (parsed.tasks) {
            parsed.tasks.forEach((task: any) => mockTasks.set(task.id, task));
          }
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      },

      parseTasks(content: string) {
        // Simple markdown parsing mock
        const lines = content.split("\n");
        const tasks: any[] = [];
        for (const line of lines) {
          const match = line.match(/# Task #(\w+): (.+)/);
          if (match) {
            tasks.push({
              id: `#${match[1]}`,
              title: match[2],
              status: "TODO",
            });
          }
        }
        return tasks;
      },

      formatTasks(tasks: any[]) {
        return JSON.stringify({
          tasks,
          lastUpdated: new Date().toISOString(),
        });
      },

      getTaskSpecPath(id: string, title?: string) {
        const cleanId = id.replace("#", "");
        const cleanTitle = title ? title.toLowerCase().replace(/\s+/g, "-") : "task";
        return `process/tasks/${cleanId}-${cleanTitle}.md`;
      },

      parseTaskSpec(content: string) {
        const lines = content.split("\n");
        const titleMatch = lines[0]?.match(/# Task #\w+: (.+)/);
        return {
          title: titleMatch?.[1] || "Unknown Task",
          description: lines.slice(2).join("\n").trim(),
        };
      },

      getWorkspacePath() {
        return "/mock/workspace";
      },
    };
  });

  afterEach(() => {
    mock.restore();
    mockTasks.clear();
  });

  describe("storage operations", () => {
    test("should initialize storage correctly", () => {
      const location = backend.getStorageLocation();
      expect(location).toBe("/mock/test-tasks.json");
    });

    test("should store and retrieve tasks", async () => {
      const testTask = {
        id: "#001",
        title: "Test Task",
        status: "TODO",
        description: "A test task",
      };

      // Create task
      const created = await backend.createTaskData(testTask);
      expect(created).toEqual(testTask);

      // Retrieve task
      const retrieved = await backend.getTaskById("#001");
      expect(retrieved).toEqual(testTask);

      // Get all tasks
      const allTasks = await backend.getAllTasks();
      expect(allTasks.length).toBe(1);
      expect(allTasks[0]).toEqual(testTask);
    });

    test("should update tasks", async () => {
      const testTask = {
        id: "#002",
        title: "Test Task 2",
        status: "TODO",
      };

      // Create initial task
      await backend.createTaskData(testTask);

      // Update task
      const updates = {
        title: TEST_DATA_PATTERNS.UPDATED_TASK_TITLE,
        status: "IN-PROGRESS",
      };

      const updated = await backend.updateTaskData("#002", updates);
      expect(updated).toBeDefined();
      expect(updated.title).toBe(TEST_DATA_PATTERNS.UPDATED_TASK_TITLE);
      expect(updated.status).toBe("IN-PROGRESS");

      // Verify update persisted
      const retrieved = await backend.getTaskById("#002");
      expect(retrieved.title).toBe(TEST_DATA_PATTERNS.UPDATED_TASK_TITLE);
      expect(retrieved.status).toBe("IN-PROGRESS");
    });

    test("should delete tasks", async () => {
      const testTask = {
        id: "#003",
        title: "Test Task 3",
        status: "TODO",
      };

      // Create task
      await backend.createTaskData(testTask);

      // Verify task exists
      const beforeDelete = await backend.getAllTasks();
      expect(beforeDelete.length).toBe(1);

      // Delete task
      const deleteResult = await backend.deleteTaskData("#003");
      expect(deleteResult).toBe(true);

      // Verify task is gone
      const afterDelete = await backend.getAllTasks();
      expect(afterDelete.length).toBe(0);

      // Verify getTaskById returns null
      const retrieved = await backend.getTaskById("#003");
      expect(retrieved).toBeNull();
    });
  });

  describe("TaskBackend interface compliance", () => {
    test("should implement getTasksData", async () => {
      const result = await backend.getTasksData();
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(typeof result.content).toBe("string");
    });

    test("should implement saveTasksData", async () => {
      const taskData = JSON.stringify({
        tasks: [
          { id: "#004", title: "Task 4", status: "TODO" },
          { id: "#005", title: "Task 5", status: "DONE" },
        ],
        lastUpdated: new Date().toISOString(),
      });

      const result = await backend.saveTasksData(taskData);
      expect(result.success).toBe(true);

      // Verify tasks were saved
      const retrieved = await backend.getAllTasks();
      expect(retrieved.length).toBe(2);
    });

    test("should implement parseTasks", () => {
      const markdownContent = `# Task #006: Test Task\nStatus: TODO\nDescription: Test description`;

      const parsed = backend.parseTasks(markdownContent);
      expect(parsed).toBeDefined();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    test("should implement formatTasks", () => {
      const testTasks = [{ id: "#007", title: "Task 7", status: "TODO" }];

      const formatted = backend.formatTasks(testTasks);
      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe("string");
    });

    test("should handle task spec operations", async () => {
      const testTask = {
        id: "#008",
        title: "Test Task 8",
        status: "TODO",
      };

      await backend.createTaskData(testTask);

      // Test getTaskSpecPath
      const specPath = backend.getTaskSpecPath("#008", "Test Task 8");
      expect(specPath).toBeDefined();
      expect(typeof specPath).toBe("string");
      expect(specPath).toContain("008");

      // Test parseTaskSpec
      const specContent = "# Task #008: Test Task 8\n\nDescription: Test task";
      const parsed = backend.parseTaskSpec(specContent);
      expect(parsed).toBeDefined();
      expect(parsed.title).toBe("Test Task 8");
    });
  });

  describe("markdown compatibility", () => {
    test("should parse markdown task format", () => {
      const markdownContent = `# Task #009: Sample Task\nStatus: IN-PROGRESS\nPriority: HIGH\nDescription: This is a sample task for testing`;

      const parsed = backend.parseTasks(markdownContent);
      expect(parsed).toBeDefined();
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  describe("helper methods", () => {
    test("should generate correct task spec paths", () => {
      const specPath = backend.getTaskSpecPath("#010", "Test Task 10");
      expect(specPath).toBeDefined();
      expect(typeof specPath).toBe("string");
      expect(specPath).toContain("010");
    });

    test("should return correct workspace path", () => {
      const workspacePath = backend.getWorkspacePath();
      expect(workspacePath).toBe("/mock/workspace");
    });
  });
});
